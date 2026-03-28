#include "pch.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <optional>
#include <string>
#include <vector>

#include <objidl.h>
#include <propidl.h>
#include <wincodec.h>
#include <winrt/Windows.Data.Json.h>

#include "NativeModules.h"

#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "windowscodecs.lib")

namespace OpappWindowsHostModules {

namespace {

namespace fs = std::filesystem;

enum class CaptureFormat {
  Png,
  Jpg,
};

enum class CaptureResultKind {
  TmpFile,
  Base64,
  DataUri,
};

struct CaptureOptions {
  CaptureFormat Format{CaptureFormat::Png};
  CaptureResultKind Result{CaptureResultKind::TmpFile};
  double Quality{1.0};
  int Width{0};
  int Height{0};
  std::wstring FileName;
};

std::wstring Utf8ToWide(std::string const &value) noexcept {
  return std::wstring(winrt::to_hstring(value));
}

std::string WideToUtf8(std::wstring const &value) noexcept {
  return winrt::to_string(winrt::hstring(value));
}

bool IsSafeChildPath(fs::path const &root, fs::path const &candidate) noexcept {
  try {
    auto normalizedRoot = root.lexically_normal();
    auto normalizedCandidate = candidate.lexically_normal();
    auto relative = normalizedCandidate.lexically_relative(normalizedRoot);
    if (relative.empty()) {
      return false;
    }

    return *relative.begin() != fs::path(L"..");
  } catch (...) {
    return false;
  }
}

std::optional<fs::path> GetCaptureRoot() noexcept {
  wchar_t tempPath[MAX_PATH] = {};
  DWORD length = GetTempPathW(MAX_PATH, tempPath);
  if (length == 0 || length >= MAX_PATH) {
    return std::nullopt;
  }

  return (fs::path(tempPath) / L"OPApp" / L"view-shot").lexically_normal();
}

std::wstring SanitizeFileStem(std::wstring const &value) {
  std::wstring sanitized;
  sanitized.reserve(value.size());

  for (auto ch : value) {
    if ((ch >= L'0' && ch <= L'9') || (ch >= L'a' && ch <= L'z') || (ch >= L'A' && ch <= L'Z') || ch == L'-' ||
        ch == L'_') {
      sanitized.push_back(ch);
      continue;
    }

    if (ch == L' ' || ch == L'.') {
      sanitized.push_back(L'-');
    }
  }

  while (!sanitized.empty() && (sanitized.front() == L'-' || sanitized.front() == L'_')) {
    sanitized.erase(sanitized.begin());
  }

  while (!sanitized.empty() && (sanitized.back() == L'-' || sanitized.back() == L'_')) {
    sanitized.pop_back();
  }

  return sanitized.empty() ? L"capture" : sanitized;
}

std::wstring BuildDefaultFileStem() {
  FILETIME fileTime{};
  GetSystemTimeAsFileTime(&fileTime);
  ULARGE_INTEGER value{};
  value.LowPart = fileTime.dwLowDateTime;
  value.HighPart = fileTime.dwHighDateTime;
  return L"capture-" + std::to_wstring(value.QuadPart);
}

std::wstring ExtensionForFormat(CaptureFormat format) {
  return format == CaptureFormat::Png ? L".png" : L".jpg";
}

GUID ContainerGuidForFormat(CaptureFormat format) {
  return format == CaptureFormat::Png ? GUID_ContainerFormatPng : GUID_ContainerFormatJpeg;
}

std::string MimeTypeForFormat(CaptureFormat format) {
  return format == CaptureFormat::Png ? "image/png" : "image/jpeg";
}

std::optional<std::wstring> TryReadJsonString(
    winrt::Windows::Data::Json::JsonObject const &json,
    wchar_t const *key) noexcept {
  try {
    if (!json.HasKey(key)) {
      return std::nullopt;
    }

    auto value = json.Lookup(key);
    if (value.ValueType() != winrt::Windows::Data::Json::JsonValueType::String) {
      return std::nullopt;
    }

    return std::wstring(value.GetString());
  } catch (...) {
    return std::nullopt;
  }
}

std::optional<double> TryReadJsonNumber(
    winrt::Windows::Data::Json::JsonObject const &json,
    wchar_t const *key) noexcept {
  try {
    if (!json.HasKey(key)) {
      return std::nullopt;
    }

    auto value = json.Lookup(key);
    if (value.ValueType() != winrt::Windows::Data::Json::JsonValueType::Number) {
      return std::nullopt;
    }

    return value.GetNumber();
  } catch (...) {
    return std::nullopt;
  }
}

std::optional<CaptureOptions> ParseCaptureOptions(std::string const &optionsJson, std::wstring &error) noexcept {
  CaptureOptions options{};

  if (optionsJson.empty()) {
    return options;
  }

  try {
    auto json = winrt::Windows::Data::Json::JsonObject::Parse(winrt::to_hstring(optionsJson));

    if (auto format = TryReadJsonString(json, L"format")) {
      if (*format == L"png") {
        options.Format = CaptureFormat::Png;
      } else if (*format == L"jpg" || *format == L"jpeg") {
        options.Format = CaptureFormat::Jpg;
      } else {
        error = L"Unsupported capture format.";
        return std::nullopt;
      }
    }

    if (auto result = TryReadJsonString(json, L"result")) {
      if (*result == L"tmpfile") {
        options.Result = CaptureResultKind::TmpFile;
      } else if (*result == L"base64") {
        options.Result = CaptureResultKind::Base64;
      } else if (*result == L"data-uri") {
        options.Result = CaptureResultKind::DataUri;
      } else {
        error = L"Unsupported capture result kind.";
        return std::nullopt;
      }
    }

    if (auto quality = TryReadJsonNumber(json, L"quality")) {
      options.Quality = std::clamp(*quality, 0.0, 1.0);
    }

    if (auto width = TryReadJsonNumber(json, L"width")) {
      options.Width = static_cast<int>(std::lround(*width));
    }

    if (auto height = TryReadJsonNumber(json, L"height")) {
      options.Height = static_cast<int>(std::lround(*height));
    }

    if (options.Width < 0 || options.Height < 0) {
      error = L"Capture width and height must be positive.";
      return std::nullopt;
    }

    if (auto fileName = TryReadJsonString(json, L"fileName")) {
      options.FileName = *fileName;
    }
  } catch (...) {
    error = L"Unable to parse capture options.";
    return std::nullopt;
  }

  return options;
}

std::optional<HWND> ResolveForegroundManagedWindow(std::wstring &error) noexcept {
  auto foregroundWindow = GetForegroundWindow();
  if (!foregroundWindow) {
    error = L"ViewShot requires a focused OPApp window.";
    return std::nullopt;
  }

  auto rootWindow = GetAncestor(foregroundWindow, GA_ROOT);
  if (!rootWindow) {
    rootWindow = foregroundWindow;
  }

  DWORD processId = 0;
  GetWindowThreadProcessId(rootWindow, &processId);
  if (processId == 0 || processId != GetCurrentProcessId()) {
    error = L"ViewShot requires a focused OPApp window.";
    return std::nullopt;
  }

  return rootWindow;
}

std::optional<RECT> ResolveWindowClientRectInScreen(HWND hwnd, std::wstring &error) noexcept {
  RECT clientRect{};
  if (!GetClientRect(hwnd, &clientRect)) {
    error = L"Unable to resolve the focused window client area.";
    return std::nullopt;
  }

  POINT topLeft{clientRect.left, clientRect.top};
  POINT bottomRight{clientRect.right, clientRect.bottom};
  if (!ClientToScreen(hwnd, &topLeft) || !ClientToScreen(hwnd, &bottomRight)) {
    error = L"Unable to map the focused window to screen coordinates.";
    return std::nullopt;
  }

  RECT screenRect{};
  screenRect.left = topLeft.x;
  screenRect.top = topLeft.y;
  screenRect.right = bottomRight.x;
  screenRect.bottom = bottomRight.y;
  if (screenRect.right <= screenRect.left || screenRect.bottom <= screenRect.top) {
    error = L"Focused OPApp window has no capturable client area.";
    return std::nullopt;
  }

  return screenRect;
}

double ResolveWindowScale(HWND hwnd) noexcept {
  auto dpi = hwnd ? GetDpiForWindow(hwnd) : 0;
  if (dpi == 0) {
    return 1.0;
  }

  return static_cast<double>(dpi) / 96.0;
}

std::optional<RECT> ResolveScreenRectForWindowRegion(
    double x,
    double y,
    double width,
    double height,
    std::wstring &error) noexcept {
  if (!std::isfinite(x) || !std::isfinite(y) || !std::isfinite(width) || !std::isfinite(height)) {
    error = L"captureRegion requires finite coordinates.";
    return std::nullopt;
  }

  if (width <= 0.0 || height <= 0.0) {
    error = L"captureRegion requires a non-empty target region.";
    return std::nullopt;
  }

  auto hwnd = ResolveForegroundManagedWindow(error);
  if (!hwnd) {
    return std::nullopt;
  }

  auto windowRect = ResolveWindowClientRectInScreen(*hwnd, error);
  if (!windowRect) {
    return std::nullopt;
  }

  auto scale = ResolveWindowScale(*hwnd);
  RECT regionRect{};
  regionRect.left = windowRect->left + static_cast<LONG>(std::lround(x * scale));
  regionRect.top = windowRect->top + static_cast<LONG>(std::lround(y * scale));
  regionRect.right = regionRect.left + static_cast<LONG>(std::lround(width * scale));
  regionRect.bottom = regionRect.top + static_cast<LONG>(std::lround(height * scale));

  RECT clippedRect{};
  clippedRect.left = std::max(windowRect->left, regionRect.left);
  clippedRect.top = std::max(windowRect->top, regionRect.top);
  clippedRect.right = std::min(windowRect->right, regionRect.right);
  clippedRect.bottom = std::min(windowRect->bottom, regionRect.bottom);
  if (clippedRect.right <= clippedRect.left || clippedRect.bottom <= clippedRect.top) {
    error = L"captureRegion resolved outside the visible OPApp client area.";
    return std::nullopt;
  }

  return clippedRect;
}

std::optional<RECT> ResolveScreenRectForFocusedWindow(std::wstring &error) noexcept {
  auto hwnd = ResolveForegroundManagedWindow(error);
  if (!hwnd) {
    return std::nullopt;
  }

  return ResolveWindowClientRectInScreen(*hwnd, error);
}

bool CapturePixelsFromScreen(
    RECT const &screenRect,
    int targetWidth,
    int targetHeight,
    std::vector<uint8_t> &pixels,
    int &outputWidth,
    int &outputHeight,
    std::wstring &error) noexcept {
  auto sourceWidth = screenRect.right - screenRect.left;
  auto sourceHeight = screenRect.bottom - screenRect.top;
  if (sourceWidth <= 0 || sourceHeight <= 0) {
    error = L"Requested capture area is empty.";
    return false;
  }

  outputWidth = targetWidth > 0 ? targetWidth : sourceWidth;
  outputHeight = targetHeight > 0 ? targetHeight : sourceHeight;

  if (targetWidth > 0 && targetHeight <= 0) {
    outputHeight = std::max(1, static_cast<int>(std::lround(
                                     static_cast<double>(sourceHeight) * static_cast<double>(targetWidth) /
                                     static_cast<double>(sourceWidth))));
  } else if (targetHeight > 0 && targetWidth <= 0) {
    outputWidth = std::max(1, static_cast<int>(std::lround(
                                    static_cast<double>(sourceWidth) * static_cast<double>(targetHeight) /
                                    static_cast<double>(sourceHeight))));
  }

  HDC screenDc = GetDC(nullptr);
  if (!screenDc) {
    error = L"Unable to access the desktop device context.";
    return false;
  }

  HDC captureDc = CreateCompatibleDC(screenDc);
  if (!captureDc) {
    ReleaseDC(nullptr, screenDc);
    error = L"Unable to create a compatible device context.";
    return false;
  }

  HBITMAP captureBitmap = CreateCompatibleBitmap(screenDc, outputWidth, outputHeight);
  if (!captureBitmap) {
    DeleteDC(captureDc);
    ReleaseDC(nullptr, screenDc);
    error = L"Unable to allocate a compatible bitmap.";
    return false;
  }

  auto previousBitmap = SelectObject(captureDc, captureBitmap);
  SetStretchBltMode(captureDc, HALFTONE);
  SetBrushOrgEx(captureDc, 0, 0, nullptr);

  BOOL blitOk = FALSE;
  if (outputWidth == sourceWidth && outputHeight == sourceHeight) {
    blitOk = BitBlt(
        captureDc,
        0,
        0,
        outputWidth,
        outputHeight,
        screenDc,
        screenRect.left,
        screenRect.top,
        SRCCOPY | CAPTUREBLT);
  } else {
    blitOk = StretchBlt(
        captureDc,
        0,
        0,
        outputWidth,
        outputHeight,
        screenDc,
        screenRect.left,
        screenRect.top,
        sourceWidth,
        sourceHeight,
        SRCCOPY | CAPTUREBLT);
  }

  if (!blitOk) {
    SelectObject(captureDc, previousBitmap);
    DeleteObject(captureBitmap);
    DeleteDC(captureDc);
    ReleaseDC(nullptr, screenDc);
    error = L"Unable to copy pixels from the desktop surface.";
    return false;
  }

  BITMAPINFO bitmapInfo{};
  bitmapInfo.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
  bitmapInfo.bmiHeader.biWidth = outputWidth;
  bitmapInfo.bmiHeader.biHeight = -outputHeight;
  bitmapInfo.bmiHeader.biPlanes = 1;
  bitmapInfo.bmiHeader.biBitCount = 32;
  bitmapInfo.bmiHeader.biCompression = BI_RGB;

  pixels.resize(static_cast<std::size_t>(outputWidth) * static_cast<std::size_t>(outputHeight) * 4);
  auto scanLines = GetDIBits(
      captureDc,
      captureBitmap,
      0,
      static_cast<UINT>(outputHeight),
      pixels.data(),
      &bitmapInfo,
      DIB_RGB_COLORS);

  SelectObject(captureDc, previousBitmap);
  DeleteObject(captureBitmap);
  DeleteDC(captureDc);
  ReleaseDC(nullptr, screenDc);

  if (scanLines == 0) {
    pixels.clear();
    error = L"Unable to read pixels from the captured bitmap.";
    return false;
  }

  for (std::size_t offset = 3; offset < pixels.size(); offset += 4) {
    pixels[offset] = 0xFF;
  }

  return true;
}

bool EncodePixelsToBytes(
    std::vector<uint8_t> const &pixels,
    int width,
    int height,
    CaptureOptions const &options,
    std::vector<uint8_t> &encoded,
    std::wstring &error) noexcept {
  try {
    WICPixelFormatGUID inputPixelFormat = GUID_WICPixelFormat32bppBGRA;
    UINT inputStride = static_cast<UINT>(width * 4);
    std::vector<uint8_t> inputPixels;
    auto const *inputBytes = pixels.data();
    auto inputSize = static_cast<UINT>(pixels.size());

    if (options.Format == CaptureFormat::Jpg) {
      inputPixelFormat = GUID_WICPixelFormat24bppBGR;
      inputStride = static_cast<UINT>(width * 3);
      inputPixels.resize(static_cast<std::size_t>(width) * static_cast<std::size_t>(height) * 3);

      for (int index = 0; index < width * height; ++index) {
        auto sourceOffset = static_cast<std::size_t>(index) * 4;
        auto targetOffset = static_cast<std::size_t>(index) * 3;
        inputPixels[targetOffset] = pixels[sourceOffset];
        inputPixels[targetOffset + 1] = pixels[sourceOffset + 1];
        inputPixels[targetOffset + 2] = pixels[sourceOffset + 2];
      }

      inputBytes = inputPixels.data();
      inputSize = static_cast<UINT>(inputPixels.size());
    }

    winrt::com_ptr<IWICImagingFactory> imagingFactory;
    winrt::check_hresult(CoCreateInstance(
        CLSID_WICImagingFactory,
        nullptr,
        CLSCTX_INPROC_SERVER,
        IID_PPV_ARGS(imagingFactory.put())));

    winrt::com_ptr<IStream> memoryStream;
    winrt::check_hresult(CreateStreamOnHGlobal(nullptr, TRUE, memoryStream.put()));

    winrt::com_ptr<IWICStream> wicStream;
    winrt::check_hresult(imagingFactory->CreateStream(wicStream.put()));
    winrt::check_hresult(wicStream->InitializeFromIStream(memoryStream.get()));

    winrt::com_ptr<IWICBitmapEncoder> encoder;
    winrt::check_hresult(imagingFactory->CreateEncoder(ContainerGuidForFormat(options.Format), nullptr, encoder.put()));
    winrt::check_hresult(encoder->Initialize(wicStream.get(), WICBitmapEncoderNoCache));

    winrt::com_ptr<IWICBitmapFrameEncode> frame;
    winrt::com_ptr<IPropertyBag2> propertyBag;
    winrt::check_hresult(encoder->CreateNewFrame(frame.put(), propertyBag.put()));

    if (propertyBag && options.Format == CaptureFormat::Jpg) {
      PROPBAG2 option{};
      option.pstrName = const_cast<LPOLESTR>(L"ImageQuality");

      VARIANT qualityValue;
      VariantInit(&qualityValue);
      qualityValue.vt = VT_R4;
      qualityValue.fltVal = static_cast<FLOAT>(options.Quality);
      propertyBag->Write(1, &option, &qualityValue);
      VariantClear(&qualityValue);
    }

    winrt::check_hresult(frame->Initialize(propertyBag.get()));
    winrt::check_hresult(frame->SetSize(static_cast<UINT>(width), static_cast<UINT>(height)));

    WICPixelFormatGUID pixelFormat = inputPixelFormat;
    winrt::check_hresult(frame->SetPixelFormat(&pixelFormat));
    if (pixelFormat != inputPixelFormat) {
      error = options.Format == CaptureFormat::Jpg
          ? L"Windows JPEG encoder did not accept 24bpp BGR input."
          : L"Windows PNG encoder did not accept 32bpp BGRA input.";
      return false;
    }

    winrt::check_hresult(frame->WritePixels(
        static_cast<UINT>(height),
        inputStride,
        inputSize,
        const_cast<BYTE *>(inputBytes)));

    winrt::check_hresult(frame->Commit());
    winrt::check_hresult(encoder->Commit());

    STATSTG streamStats{};
    winrt::check_hresult(memoryStream->Stat(&streamStats, STATFLAG_NONAME));

    LARGE_INTEGER zero{};
    winrt::check_hresult(memoryStream->Seek(zero, STREAM_SEEK_SET, nullptr));

    encoded.resize(static_cast<std::size_t>(streamStats.cbSize.QuadPart));
    ULONG bytesRead = 0;
    winrt::check_hresult(memoryStream->Read(encoded.data(), static_cast<ULONG>(encoded.size()), &bytesRead));
    encoded.resize(bytesRead);
    return true;
  } catch (winrt::hresult_error const &) {
    error = L"Unable to encode the captured bitmap.";
    encoded.clear();
    return false;
  } catch (...) {
    error = L"Unexpected image encoding failure.";
    encoded.clear();
    return false;
  }
}

std::string Base64Encode(std::vector<uint8_t> const &bytes) {
  static constexpr char kAlphabet[] =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

  std::string encoded;
  encoded.reserve(((bytes.size() + 2) / 3) * 4);

  std::size_t index = 0;
  while (index < bytes.size()) {
    std::uint32_t chunk = static_cast<std::uint32_t>(bytes[index]) << 16;
    bool hasSecond = (index + 1) < bytes.size();
    bool hasThird = (index + 2) < bytes.size();

    if (hasSecond) {
      chunk |= static_cast<std::uint32_t>(bytes[index + 1]) << 8;
    }

    if (hasThird) {
      chunk |= static_cast<std::uint32_t>(bytes[index + 2]);
    }

    encoded.push_back(kAlphabet[(chunk >> 18) & 0x3F]);
    encoded.push_back(kAlphabet[(chunk >> 12) & 0x3F]);
    encoded.push_back(hasSecond ? kAlphabet[(chunk >> 6) & 0x3F] : '=');
    encoded.push_back(hasThird ? kAlphabet[chunk & 0x3F] : '=');

    index += 3;
  }

  return encoded;
}

bool WriteBytesToFile(fs::path const &path, std::vector<uint8_t> const &bytes, std::wstring &error) noexcept {
  try {
    std::error_code createDirectoriesError;
    fs::create_directories(path.parent_path(), createDirectoriesError);
    if (createDirectoriesError) {
      error = L"Unable to create the capture output directory.";
      return false;
    }

    std::ofstream stream(path, std::ios::binary | std::ios::trunc);
    if (!stream.is_open()) {
      error = L"Unable to open the capture output file.";
      return false;
    }

    stream.write(reinterpret_cast<char const *>(bytes.data()), static_cast<std::streamsize>(bytes.size()));
    if (!stream.good()) {
      error = L"Unable to write the capture output file.";
      return false;
    }

    return true;
  } catch (...) {
    error = L"Unexpected file I/O error while writing the capture.";
    return false;
  }
}

std::optional<fs::path> ResolveCapturePath(CaptureOptions const &options, std::wstring &error) noexcept {
  auto captureRoot = GetCaptureRoot();
  if (!captureRoot) {
    error = L"Unable to resolve the host capture directory.";
    return std::nullopt;
  }

  auto requestedStem = options.FileName.empty()
      ? BuildDefaultFileStem()
      : SanitizeFileStem(fs::path(options.FileName).stem().wstring());
  auto capturePath = (*captureRoot / (requestedStem + ExtensionForFormat(options.Format))).lexically_normal();
  if (!IsSafeChildPath(*captureRoot, capturePath)) {
    error = L"Refusing to write a capture outside the managed host directory.";
    return std::nullopt;
  }

  return capturePath;
}

std::optional<std::string> BuildCaptureResult(
    RECT const &screenRect,
    CaptureOptions const &options,
    std::wstring &error) noexcept {
  int outputWidth = 0;
  int outputHeight = 0;
  std::vector<uint8_t> pixels;
  if (!CapturePixelsFromScreen(screenRect, options.Width, options.Height, pixels, outputWidth, outputHeight, error)) {
    return std::nullopt;
  }

  std::vector<uint8_t> encoded;
  if (!EncodePixelsToBytes(pixels, outputWidth, outputHeight, options, encoded, error)) {
    return std::nullopt;
  }

  if (options.Result == CaptureResultKind::Base64) {
    return Base64Encode(encoded);
  }

  if (options.Result == CaptureResultKind::DataUri) {
    return "data:" + MimeTypeForFormat(options.Format) + ";base64," + Base64Encode(encoded);
  }

  auto capturePath = ResolveCapturePath(options, error);
  if (!capturePath) {
    return std::nullopt;
  }

  if (!WriteBytesToFile(*capturePath, encoded, error)) {
    return std::nullopt;
  }

  return WideToUtf8(capturePath->wstring());
}

std::optional<fs::path> NormalizeManagedCaptureUri(std::string const &uri) noexcept {
  if (uri.empty()) {
    return std::nullopt;
  }

  auto normalized = uri;
  constexpr char kFilePrefix[] = "file://";
  if (normalized.rfind(kFilePrefix, 0) == 0) {
    normalized = normalized.substr(sizeof(kFilePrefix) - 1);
  }

  auto captureRoot = GetCaptureRoot();
  if (!captureRoot) {
    return std::nullopt;
  }

  auto candidate = fs::path(Utf8ToWide(normalized)).lexically_normal();
  if (!candidate.is_absolute()) {
    return std::nullopt;
  }

  if (!IsSafeChildPath(*captureRoot, candidate)) {
    return std::nullopt;
  }

  return candidate;
}

} // namespace

REACT_MODULE(OpappViewShotModule, L"OpappViewShot")
struct OpappViewShotModule {
  REACT_METHOD(CaptureRegion, L"captureRegion")
  void CaptureRegion(
      double x,
      double y,
      double width,
      double height,
      std::string optionsJson,
      winrt::Microsoft::ReactNative::ReactPromise<std::string> &&result) noexcept {
    std::wstring error;
    auto options = ParseCaptureOptions(optionsJson, error);
    if (!options) {
      result.Reject(error.c_str());
      return;
    }

    auto screenRect = ResolveScreenRectForWindowRegion(x, y, width, height, error);
    if (!screenRect) {
      result.Reject(error.c_str());
      return;
    }

    auto captureResult = BuildCaptureResult(*screenRect, *options, error);
    if (!captureResult) {
      result.Reject(error.c_str());
      return;
    }

    result.Resolve(*captureResult);
  }

  REACT_METHOD(CaptureScreen, L"captureScreen")
  void CaptureScreen(
      std::string optionsJson,
      winrt::Microsoft::ReactNative::ReactPromise<std::string> &&result) noexcept {
    std::wstring error;
    auto options = ParseCaptureOptions(optionsJson, error);
    if (!options) {
      result.Reject(error.c_str());
      return;
    }

    auto screenRect = ResolveScreenRectForFocusedWindow(error);
    if (!screenRect) {
      result.Reject(error.c_str());
      return;
    }

    auto captureResult = BuildCaptureResult(*screenRect, *options, error);
    if (!captureResult) {
      result.Reject(error.c_str());
      return;
    }

    result.Resolve(*captureResult);
  }

  REACT_METHOD(ReleaseCapture, L"releaseCapture")
  void ReleaseCapture(
      std::string uri,
      winrt::Microsoft::ReactNative::ReactPromise<bool> &&result) noexcept {
    try {
      auto capturePath = NormalizeManagedCaptureUri(uri);
      if (!capturePath) {
        result.Resolve(false);
        return;
      }

      std::error_code removeError;
      auto removed = fs::remove(*capturePath, removeError);
      if (removeError) {
        result.Reject(L"Unable to delete the requested capture.");
        return;
      }

      result.Resolve(removed);
    } catch (...) {
      result.Reject(L"Unexpected error while deleting the requested capture.");
    }
  }
};

} // namespace OpappWindowsHostModules
