#include "pch.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cwctype>
#include <filesystem>
#include <fstream>
#include <optional>
#include <string>
#include <vector>

#include <d3d11.h>
#include <dxgi1_2.h>
#include <inspectable.h>
#include <objidl.h>
#include <propidl.h>
#include <wincodec.h>

#include <winrt/Windows.Data.Json.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Graphics.Capture.h>
#include <winrt/Windows.Graphics.DirectX.h>
#include <winrt/Windows.Graphics.DirectX.Direct3D11.h>
#include <winrt/Windows.Graphics.Imaging.h>
#include <winrt/Windows.Storage.Streams.h>

#include "HostCore.h"
#include "NativeModules.h"

#pragma comment(lib, "d3d11.lib")
#pragma comment(lib, "dxgi.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "windowscodecs.lib")

namespace OpappWindowsHostModules {

namespace {

namespace fs = std::filesystem;
namespace json = winrt::Windows::Data::Json;
namespace foundation = winrt::Windows::Foundation;
namespace capture = winrt::Windows::Graphics::Capture;
namespace direct3d = winrt::Windows::Graphics::DirectX::Direct3D11;
namespace imaging = winrt::Windows::Graphics::Imaging;
namespace streams = winrt::Windows::Storage::Streams;

enum class CaptureBackend { Auto, CopyScreen, Wgc };
enum class CaptureRegion { Client, Window, Monitor };
enum class CaptureFormat { Png, Jpg };

struct ScreenRect {
  int Left{0};
  int Top{0};
  int Right{0};
  int Bottom{0};

  int Width() const noexcept { return Right - Left; }
  int Height() const noexcept { return Bottom - Top; }
};

struct WindowSelector {
  bool Foreground{false};
  std::optional<std::uint64_t> Handle;
  std::optional<std::wstring> ProcessName;
  std::optional<std::wstring> TitleContains;
  std::optional<std::wstring> TitleExact;
  std::optional<std::wstring> ClassName;
};

struct CaptureRequest {
  bool Activate{false};
  int ActivationDelayMs{400};
  CaptureBackend RequestedBackend{CaptureBackend::Auto};
  CaptureBackend Backend{CaptureBackend::Wgc};
  CaptureRegion Region{CaptureRegion::Client};
  CaptureFormat Format{CaptureFormat::Png};
  int TimeoutMs{5000};
  bool IncludeCursor{false};
  fs::path OutputPath;
};

struct WindowEntry {
  HWND Handle{nullptr};
  std::wstring HandleHex;
  DWORD ProcessId{0};
  std::wstring ProcessName;
  std::wstring Title;
  std::wstring ClassName;
  bool IsForeground{false};
  bool IsMinimized{false};
  ScreenRect WindowRect;
  std::optional<ScreenRect> ClientRect;
  std::optional<ScreenRect> MonitorRect;
  std::int64_t WindowArea{0};
};

std::wstring Utf8ToWide(std::string const &value) noexcept {
  return std::wstring(winrt::to_hstring(value));
}

std::string WideToUtf8(std::wstring const &value) noexcept {
  return winrt::to_string(winrt::hstring(value));
}

// JSON helpers

json::IJsonValue NullJsonValue() {
  return json::JsonValue::Parse(L"null");
}

std::wstring Trim(std::wstring value) {
  auto isWhitespace = [](wchar_t ch) noexcept {
    return ch == L' ' || ch == L'\t' || ch == L'\r' || ch == L'\n';
  };

  while (!value.empty() && isWhitespace(value.front())) {
    value.erase(value.begin());
  }
  while (!value.empty() && isWhitespace(value.back())) {
    value.pop_back();
  }
  return value;
}

std::wstring ToLowerInvariant(std::wstring const &value) {
  std::wstring lowered;
  lowered.reserve(value.size());
  for (auto ch : value) {
    lowered.push_back(static_cast<wchar_t>(::towlower(ch)));
  }
  return lowered;
}

bool EqualsInsensitive(std::wstring const &left, std::wstring const &right) {
  return ToLowerInvariant(left) == ToLowerInvariant(right);
}

bool ContainsInsensitive(std::wstring const &haystack, std::wstring const &needle) {
  return ToLowerInvariant(haystack).find(ToLowerInvariant(needle)) != std::wstring::npos;
}

std::optional<std::wstring> TryReadJsonString(json::JsonObject const &value, wchar_t const *key) noexcept {
  try {
    if (!value.HasKey(key)) {
      return std::nullopt;
    }
    auto jsonValue = value.Lookup(key);
    if (jsonValue.ValueType() != json::JsonValueType::String) {
      return std::nullopt;
    }
    return std::wstring(jsonValue.GetString());
  } catch (...) {
    return std::nullopt;
  }
}

std::optional<double> TryReadJsonNumber(json::JsonObject const &value, wchar_t const *key) noexcept {
  try {
    if (!value.HasKey(key)) {
      return std::nullopt;
    }
    auto jsonValue = value.Lookup(key);
    if (jsonValue.ValueType() != json::JsonValueType::Number) {
      return std::nullopt;
    }
    return jsonValue.GetNumber();
  } catch (...) {
    return std::nullopt;
  }
}

std::optional<bool> TryReadJsonBoolean(json::JsonObject const &value, wchar_t const *key) noexcept {
  try {
    if (!value.HasKey(key)) {
      return std::nullopt;
    }
    auto jsonValue = value.Lookup(key);
    if (jsonValue.ValueType() != json::JsonValueType::Boolean) {
      return std::nullopt;
    }
    return jsonValue.GetBoolean();
  } catch (...) {
    return std::nullopt;
  }
}

std::optional<std::uint64_t> ParseHandleText(std::wstring const &rawValue) {
  auto value = Trim(rawValue);
  if (value.empty()) {
    return std::nullopt;
  }

  try {
    std::size_t processed = 0;
    unsigned long long parsed = 0;
    if (value.rfind(L"0x", 0) == 0 || value.rfind(L"0X", 0) == 0) {
      parsed = std::stoull(value.substr(2), &processed, 16);
      if (processed != value.size() - 2) {
        return std::nullopt;
      }
    } else {
      parsed = std::stoull(value, &processed, 10);
      if (processed != value.size()) {
        return std::nullopt;
      }
    }

    return parsed == 0 ? std::nullopt : std::optional<std::uint64_t>(parsed);
  } catch (...) {
    return std::nullopt;
  }
}

std::optional<std::uint64_t> ParseHandleJsonValue(json::IJsonValue const &value) {
  try {
    if (value.ValueType() == json::JsonValueType::Number) {
      auto number = value.GetNumber();
      if (!std::isfinite(number) || number <= 0.0) {
        return std::nullopt;
      }
      return static_cast<std::uint64_t>(std::llround(number));
    }
    if (value.ValueType() == json::JsonValueType::String) {
      return ParseHandleText(std::wstring(value.GetString()));
    }
  } catch (...) {
  }

  return std::nullopt;
}

CaptureBackend ResolveBackend(CaptureBackend requestedBackend, CaptureRegion region) noexcept {
  if (requestedBackend == CaptureBackend::Auto) {
    return region == CaptureRegion::Monitor ? CaptureBackend::CopyScreen : CaptureBackend::Wgc;
  }
  return requestedBackend;
}

std::wstring CaptureBackendName(CaptureBackend backend) {
  switch (backend) {
    case CaptureBackend::Auto:
      return L"auto";
    case CaptureBackend::CopyScreen:
      return L"copy-screen";
    case CaptureBackend::Wgc:
      return L"wgc";
  }
  return L"auto";
}

std::wstring CaptureRegionName(CaptureRegion region) {
  switch (region) {
    case CaptureRegion::Client:
      return L"client";
    case CaptureRegion::Window:
      return L"window";
    case CaptureRegion::Monitor:
      return L"monitor";
  }
  return L"client";
}

std::wstring CaptureFormatName(CaptureFormat format) {
  return format == CaptureFormat::Png ? L"png" : L"jpg";
}

ScreenRect ToScreenRect(RECT const &rect) noexcept {
  return ScreenRect{rect.left, rect.top, rect.right, rect.bottom};
}

RECT ToNativeRect(ScreenRect const &rect) noexcept {
  RECT nativeRect{};
  nativeRect.left = rect.Left;
  nativeRect.top = rect.Top;
  nativeRect.right = rect.Right;
  nativeRect.bottom = rect.Bottom;
  return nativeRect;
}

json::JsonObject CreateRectJson(ScreenRect const &rect) {
  json::JsonObject value;
  value.Insert(L"left", json::JsonValue::CreateNumberValue(rect.Left));
  value.Insert(L"top", json::JsonValue::CreateNumberValue(rect.Top));
  value.Insert(L"right", json::JsonValue::CreateNumberValue(rect.Right));
  value.Insert(L"bottom", json::JsonValue::CreateNumberValue(rect.Bottom));
  value.Insert(L"width", json::JsonValue::CreateNumberValue(rect.Width()));
  value.Insert(L"height", json::JsonValue::CreateNumberValue(rect.Height()));
  return value;
}

json::JsonObject CreateSizeJson(int width, int height) {
  json::JsonObject value;
  value.Insert(L"width", json::JsonValue::CreateNumberValue(width));
  value.Insert(L"height", json::JsonValue::CreateNumberValue(height));
  return value;
}

// Path helpers

std::wstring SanitizeFileStem(std::wstring const &value) {
  std::wstring sanitized;
  sanitized.reserve(value.size());
  for (auto ch : value) {
    if ((ch >= L'0' && ch <= L'9') || (ch >= L'a' && ch <= L'z') || (ch >= L'A' && ch <= L'Z') || ch == L'-' ||
        ch == L'_' || ch == L'.') {
      sanitized.push_back(ch);
    } else if (ch == L' ') {
      sanitized.push_back(L'-');
    }
  }

  while (!sanitized.empty() && (sanitized.front() == L'-' || sanitized.front() == L'_' || sanitized.front() == L'.')) {
    sanitized.erase(sanitized.begin());
  }
  while (!sanitized.empty() && (sanitized.back() == L'-' || sanitized.back() == L'_' || sanitized.back() == L'.')) {
    sanitized.pop_back();
  }

  return sanitized.empty() ? L"window-capture" : sanitized;
}

std::optional<fs::path> ResolveCaptureRoot() noexcept {
  wchar_t tempPath[MAX_PATH] = {};
  DWORD length = GetTempPathW(MAX_PATH, tempPath);
  if (length == 0 || length >= MAX_PATH) {
    return std::nullopt;
  }

  return (fs::path(tempPath) / L"OPApp" / L"window-capture").lexically_normal();
}

std::optional<fs::path> NormalizeOutputPath(std::optional<std::wstring> const &rawPath) noexcept {
  try {
    if (!rawPath || Trim(*rawPath).empty()) {
      return std::nullopt;
    }

    auto path = fs::path(*rawPath);
    if (!path.is_absolute()) {
      path = fs::absolute(path);
    }
    return path.lexically_normal();
  } catch (...) {
    return std::nullopt;
  }
}

std::wstring BuildTimestampToken() {
  FILETIME fileTime{};
  GetSystemTimeAsFileTime(&fileTime);
  ULARGE_INTEGER value{};
  value.LowPart = fileTime.dwLowDateTime;
  value.HighPart = fileTime.dwHighDateTime;
  return std::to_wstring(value.QuadPart);
}

fs::path BuildDefaultOutputPath(WindowSelector const &selector, CaptureFormat format) {
  auto captureRoot = ResolveCaptureRoot().value_or(fs::temp_directory_path());
  std::wstring hint = L"foreground-window";
  if (selector.ProcessName) {
    hint = *selector.ProcessName;
  } else if (selector.TitleExact) {
    hint = *selector.TitleExact;
  } else if (selector.TitleContains) {
    hint = *selector.TitleContains;
  } else if (selector.Handle) {
    hint = L"hwnd-" + std::to_wstring(*selector.Handle);
  }

  return (captureRoot / (SanitizeFileStem(hint) + L"-" + BuildTimestampToken() +
                         (format == CaptureFormat::Png ? L".png" : L".jpg")))
      .lexically_normal();
}

bool EnsureParentDirectory(fs::path const &path, std::wstring &error) noexcept {
  try {
    std::error_code createDirectoriesError;
    fs::create_directories(path.parent_path(), createDirectoriesError);
    if (createDirectoriesError) {
      error = L"Unable to create the window-capture output directory.";
      return false;
    }
    return true;
  } catch (...) {
    error = L"Unexpected I/O error while preparing the output directory.";
    return false;
  }
}

std::wstring FormatHandleHex(HWND hwnd) {
  wchar_t buffer[32] = {};
  swprintf_s(buffer, L"0x%llX", static_cast<unsigned long long>(reinterpret_cast<std::uintptr_t>(hwnd)));
  return std::wstring(buffer);
}

std::optional<WindowSelector> ParseSelector(std::string const &selectorJson, std::wstring &error) noexcept {
  WindowSelector selector{};

  try {
    auto value = selectorJson.empty() ? json::JsonObject() : json::JsonObject::Parse(winrt::to_hstring(selectorJson));

    if (auto foreground = TryReadJsonBoolean(value, L"foreground")) {
      selector.Foreground = *foreground;
    }
    if (value.HasKey(L"handle")) {
      auto parsedHandle = ParseHandleJsonValue(value.Lookup(L"handle"));
      if (!parsedHandle) {
        error = L"Selector field \"handle\" must be a positive number or 0x-prefixed hex string.";
        return std::nullopt;
      }
      selector.Handle = *parsedHandle;
    }
    selector.ProcessName = TryReadJsonString(value, L"processName");
    selector.TitleContains = TryReadJsonString(value, L"titleContains");
    selector.TitleExact = TryReadJsonString(value, L"titleExact");
    selector.ClassName = TryReadJsonString(value, L"className");
  } catch (...) {
    error = L"Unable to parse the window selector JSON payload.";
    return std::nullopt;
  }

  if (!selector.Foreground && !selector.Handle && !selector.ProcessName && !selector.TitleContains && !selector.TitleExact &&
      !selector.ClassName) {
    error = L"Provide at least one window selector.";
    return std::nullopt;
  }

  return selector;
}

std::optional<CaptureRequest> ParseCaptureRequest(
    std::string const &optionsJson,
    WindowSelector const &selector,
    std::wstring &error) noexcept {
  CaptureRequest request{};

  try {
    auto value = optionsJson.empty() ? json::JsonObject() : json::JsonObject::Parse(winrt::to_hstring(optionsJson));

    if (auto activate = TryReadJsonBoolean(value, L"activate")) {
      request.Activate = *activate;
    }
    if (auto activationDelayMs = TryReadJsonNumber(value, L"activationDelayMs")) {
      auto parsed = static_cast<int>(std::llround(*activationDelayMs));
      if (parsed < 0) {
        error = L"Capture option \"activationDelayMs\" must be zero or positive.";
        return std::nullopt;
      }
      request.ActivationDelayMs = parsed;
    }
    if (auto backend = TryReadJsonString(value, L"backend")) {
      if (*backend == L"auto") {
        request.RequestedBackend = CaptureBackend::Auto;
      } else if (*backend == L"copy-screen") {
        request.RequestedBackend = CaptureBackend::CopyScreen;
      } else if (*backend == L"wgc") {
        request.RequestedBackend = CaptureBackend::Wgc;
      } else {
        error = L"Capture option \"backend\" must be auto, copy-screen, or wgc.";
        return std::nullopt;
      }
    }
    if (auto region = TryReadJsonString(value, L"region")) {
      if (*region == L"client") {
        request.Region = CaptureRegion::Client;
      } else if (*region == L"window") {
        request.Region = CaptureRegion::Window;
      } else if (*region == L"monitor") {
        request.Region = CaptureRegion::Monitor;
      } else {
        error = L"Capture option \"region\" must be client, window, or monitor.";
        return std::nullopt;
      }
    }
    if (auto format = TryReadJsonString(value, L"format")) {
      if (*format == L"png") {
        request.Format = CaptureFormat::Png;
      } else if (*format == L"jpg" || *format == L"jpeg") {
        request.Format = CaptureFormat::Jpg;
      } else {
        error = L"Capture option \"format\" must be png or jpg.";
        return std::nullopt;
      }
    }
    if (auto timeoutMs = TryReadJsonNumber(value, L"timeoutMs")) {
      auto parsed = static_cast<int>(std::llround(*timeoutMs));
      if (parsed <= 0) {
        error = L"Capture option \"timeoutMs\" must be a positive integer.";
        return std::nullopt;
      }
      request.TimeoutMs = parsed;
    }
    if (auto includeCursor = TryReadJsonBoolean(value, L"includeCursor")) {
      request.IncludeCursor = *includeCursor;
    }

    auto rawOutputPath = TryReadJsonString(value, L"outputPath");
    auto outputPath = NormalizeOutputPath(rawOutputPath);
    if (rawOutputPath && !outputPath) {
      error = L"Capture option \"outputPath\" could not be normalized.";
      return std::nullopt;
    }

    request.Backend = ResolveBackend(request.RequestedBackend, request.Region);
    if (request.Backend == CaptureBackend::Wgc && request.Region == CaptureRegion::Monitor) {
      error = L"The WGC backend currently supports only region=window or region=client.";
      return std::nullopt;
    }
    request.OutputPath = outputPath ? *outputPath : BuildDefaultOutputPath(selector, request.Format);
  } catch (...) {
    error = L"Unable to parse the capture options JSON payload.";
    return std::nullopt;
  }

  return request;
}

// Window enumeration helpers

std::optional<std::wstring> ReadProcessName(DWORD processId) noexcept {
  HANDLE processHandle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, processId);
  if (!processHandle) {
    return std::nullopt;
  }

  std::vector<wchar_t> buffer(4096, L'\0');
  DWORD length = static_cast<DWORD>(buffer.size());
  std::wstring processName;
  if (QueryFullProcessImageNameW(processHandle, 0, buffer.data(), &length) && length > 0) {
    try {
      processName = fs::path(std::wstring(buffer.data(), length)).stem().wstring();
    } catch (...) {
      processName.clear();
    }
  }
  CloseHandle(processHandle);

  return processName.empty() ? std::nullopt : std::optional<std::wstring>(processName);
}

std::optional<ScreenRect> ResolveWindowRect(HWND hwnd) noexcept {
  RECT rect{};
  if (!GetWindowRect(hwnd, &rect)) {
    return std::nullopt;
  }

  auto screenRect = ToScreenRect(rect);
  return (screenRect.Width() > 0 && screenRect.Height() > 0) ? std::optional<ScreenRect>(screenRect) : std::nullopt;
}

std::optional<ScreenRect> ResolveClientRect(HWND hwnd) noexcept {
  RECT clientRect{};
  if (!GetClientRect(hwnd, &clientRect)) {
    return std::nullopt;
  }

  POINT topLeft{clientRect.left, clientRect.top};
  POINT bottomRight{clientRect.right, clientRect.bottom};
  if (!ClientToScreen(hwnd, &topLeft) || !ClientToScreen(hwnd, &bottomRight)) {
    return std::nullopt;
  }

  ScreenRect rect{topLeft.x, topLeft.y, bottomRight.x, bottomRight.y};
  return (rect.Width() > 0 && rect.Height() > 0) ? std::optional<ScreenRect>(rect) : std::nullopt;
}

std::optional<ScreenRect> ResolveMonitorRect(HWND hwnd) noexcept {
  auto monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
  if (!monitor) {
    return std::nullopt;
  }

  MONITORINFOEXW monitorInfo{};
  monitorInfo.cbSize = sizeof(monitorInfo);
  if (!GetMonitorInfoW(monitor, &monitorInfo)) {
    return std::nullopt;
  }

  auto rect = ToScreenRect(monitorInfo.rcMonitor);
  return (rect.Width() > 0 && rect.Height() > 0) ? std::optional<ScreenRect>(rect) : std::nullopt;
}

struct EnumerateWindowsContext {
  HWND ForegroundRoot{nullptr};
  std::vector<WindowEntry> *Items{nullptr};
};

BOOL CALLBACK EnumerateVisibleWindowCallback(HWND hwnd, LPARAM lParam) {
  auto *context = reinterpret_cast<EnumerateWindowsContext *>(lParam);
  if (!context || !context->Items) {
    return FALSE;
  }

  if (!IsWindowVisible(hwnd)) {
    return TRUE;
  }

  std::array<wchar_t, 512> titleBuffer{};
  auto titleLength = GetWindowTextW(hwnd, titleBuffer.data(), static_cast<int>(titleBuffer.size()));
  if (titleLength <= 0) {
    return TRUE;
  }

  std::wstring title(titleBuffer.data(), static_cast<std::size_t>(titleLength));
  if (Trim(title).empty()) {
    return TRUE;
  }

  DWORD processId = 0;
  GetWindowThreadProcessId(hwnd, &processId);
  if (processId == 0) {
    return TRUE;
  }

  auto processName = ReadProcessName(processId);
  if (!processName || processName->empty()) {
    return TRUE;
  }

  auto windowRect = ResolveWindowRect(hwnd);
  if (!windowRect) {
    return TRUE;
  }

  std::array<wchar_t, 256> classBuffer{};
  auto classLength = GetClassNameW(hwnd, classBuffer.data(), static_cast<int>(classBuffer.size()));

  context->Items->push_back(WindowEntry{
      .Handle = hwnd,
      .HandleHex = FormatHandleHex(hwnd),
      .ProcessId = processId,
      .ProcessName = *processName,
      .Title = title,
      .ClassName = classLength > 0 ? std::wstring(classBuffer.data(), static_cast<std::size_t>(classLength)) : L"",
      .IsForeground = context->ForegroundRoot == hwnd,
      .IsMinimized = IsIconic(hwnd) != FALSE,
      .WindowRect = *windowRect,
      .ClientRect = ResolveClientRect(hwnd),
      .MonitorRect = ResolveMonitorRect(hwnd),
      .WindowArea = static_cast<std::int64_t>(windowRect->Width()) * static_cast<std::int64_t>(windowRect->Height()),
  });

  return TRUE;
}

bool MatchesSelector(WindowEntry const &entry, WindowSelector const &selector) {
  if (selector.Handle) {
    auto handleValue = static_cast<std::uint64_t>(reinterpret_cast<std::uintptr_t>(entry.Handle));
    if (handleValue != *selector.Handle) {
      return false;
    }
  }
  if (selector.ProcessName && !EqualsInsensitive(entry.ProcessName, *selector.ProcessName)) {
    return false;
  }
  if (selector.TitleContains && !ContainsInsensitive(entry.Title, *selector.TitleContains)) {
    return false;
  }
  if (selector.TitleExact && !EqualsInsensitive(entry.Title, *selector.TitleExact)) {
    return false;
  }
  if (selector.ClassName && !EqualsInsensitive(entry.ClassName, *selector.ClassName)) {
    return false;
  }
  if (selector.Foreground && !entry.IsForeground) {
    return false;
  }

  return true;
}

std::vector<WindowEntry> EnumerateMatchingWindows(WindowSelector const &selector) {
  auto foregroundWindow = GetForegroundWindow();
  auto foregroundRoot = foregroundWindow ? GetAncestor(foregroundWindow, GA_ROOT) : nullptr;
  if (!foregroundRoot) {
    foregroundRoot = foregroundWindow;
  }

  std::vector<WindowEntry> entries;
  EnumerateWindowsContext context{foregroundRoot, &entries};
  EnumWindows(EnumerateVisibleWindowCallback, reinterpret_cast<LPARAM>(&context));

  entries.erase(
      std::remove_if(
          entries.begin(),
          entries.end(),
          [&](WindowEntry const &entry) {
            return !MatchesSelector(entry, selector);
          }),
      entries.end());

  std::sort(
      entries.begin(),
      entries.end(),
      [](WindowEntry const &left, WindowEntry const &right) {
        if (left.IsForeground != right.IsForeground) {
          return left.IsForeground > right.IsForeground;
        }
        if (left.IsMinimized != right.IsMinimized) {
          return left.IsMinimized < right.IsMinimized;
        }
        if (left.WindowArea != right.WindowArea) {
          return left.WindowArea > right.WindowArea;
        }
        return left.Title < right.Title;
      });

  return entries;
}

json::JsonObject CreateWindowJson(WindowEntry const &entry) {
  json::JsonObject value;
  value.Insert(
      L"handle",
      json::JsonValue::CreateNumberValue(static_cast<double>(static_cast<std::uint64_t>(reinterpret_cast<std::uintptr_t>(entry.Handle)))));
  value.Insert(L"handleHex", json::JsonValue::CreateStringValue(entry.HandleHex));
  value.Insert(L"processId", json::JsonValue::CreateNumberValue(entry.ProcessId));
  value.Insert(L"processName", json::JsonValue::CreateStringValue(entry.ProcessName));
  value.Insert(L"title", json::JsonValue::CreateStringValue(entry.Title));
  value.Insert(L"className", json::JsonValue::CreateStringValue(entry.ClassName));
  value.Insert(L"isForeground", json::JsonValue::CreateBooleanValue(entry.IsForeground));
  value.Insert(L"isMinimized", json::JsonValue::CreateBooleanValue(entry.IsMinimized));
  value.Insert(L"windowRect", CreateRectJson(entry.WindowRect));
  value.Insert(L"clientRect", entry.ClientRect ? CreateRectJson(*entry.ClientRect) : NullJsonValue());
  value.Insert(L"monitorRect", entry.MonitorRect ? CreateRectJson(*entry.MonitorRect) : NullJsonValue());
  return value;
}

std::string SerializeWindowArray(std::vector<WindowEntry> const &entries) {
  json::JsonArray items;
  for (auto const &entry : entries) {
    items.Append(CreateWindowJson(entry));
  }

  return winrt::to_string(items.Stringify());
}

void ActivateWindow(WindowEntry const &entry, int activationDelayMs) noexcept {
  ShowWindowAsync(entry.Handle, SW_RESTORE);
  BringWindowToTop(entry.Handle);
  SetForegroundWindow(entry.Handle);
  if (activationDelayMs > 0) {
    Sleep(static_cast<DWORD>(activationDelayMs));
  }
}

std::optional<ScreenRect> ResolveCaptureRect(WindowEntry const &entry, CaptureRegion region, std::wstring &error) {
  switch (region) {
    case CaptureRegion::Client:
      if (!entry.ClientRect) {
        error = L"Unable to resolve the selected window client area.";
        return std::nullopt;
      }
      return entry.ClientRect;
    case CaptureRegion::Window:
      return entry.WindowRect;
    case CaptureRegion::Monitor:
      if (!entry.MonitorRect) {
        error = L"Unable to resolve the selected window monitor area.";
        return std::nullopt;
      }
      return entry.MonitorRect;
  }

  error = L"Unsupported capture region.";
  return std::nullopt;
}

// Image encode helpers

GUID ContainerGuidForFormat(CaptureFormat format) {
  return format == CaptureFormat::Png ? GUID_ContainerFormatPng : GUID_ContainerFormatJpeg;
}

bool CapturePixelsFromScreen(
    ScreenRect const &screenRect,
    std::vector<std::uint8_t> &pixels,
    int &outputWidth,
    int &outputHeight,
    std::wstring &error) noexcept {
  outputWidth = screenRect.Width();
  outputHeight = screenRect.Height();
  if (outputWidth <= 0 || outputHeight <= 0) {
    error = L"Requested capture area is empty.";
    return false;
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
  auto nativeRect = ToNativeRect(screenRect);
  auto blitOk = BitBlt(
      captureDc,
      0,
      0,
      outputWidth,
      outputHeight,
      screenDc,
      nativeRect.left,
      nativeRect.top,
      SRCCOPY | CAPTUREBLT);

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
    std::vector<std::uint8_t> const &pixels,
    int width,
    int height,
    CaptureFormat format,
    std::vector<std::uint8_t> &encoded,
    std::wstring &error) noexcept {
  try {
    WICPixelFormatGUID inputPixelFormat = GUID_WICPixelFormat32bppBGRA;
    UINT inputStride = static_cast<UINT>(width * 4);
    std::vector<std::uint8_t> inputPixels;
    auto const *inputBytes = pixels.data();
    auto inputSize = static_cast<UINT>(pixels.size());

    if (format == CaptureFormat::Jpg) {
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
    winrt::check_hresult(imagingFactory->CreateEncoder(ContainerGuidForFormat(format), nullptr, encoder.put()));
    winrt::check_hresult(encoder->Initialize(wicStream.get(), WICBitmapEncoderNoCache));

    winrt::com_ptr<IWICBitmapFrameEncode> frame;
    winrt::com_ptr<IPropertyBag2> propertyBag;
    winrt::check_hresult(encoder->CreateNewFrame(frame.put(), propertyBag.put()));
    winrt::check_hresult(frame->Initialize(propertyBag.get()));
    winrt::check_hresult(frame->SetSize(static_cast<UINT>(width), static_cast<UINT>(height)));

    WICPixelFormatGUID pixelFormat = inputPixelFormat;
    winrt::check_hresult(frame->SetPixelFormat(&pixelFormat));
    if (pixelFormat != inputPixelFormat) {
      error = format == CaptureFormat::Jpg ? L"Windows JPEG encoder did not accept 24bpp BGR input."
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

bool WriteBytesToFile(fs::path const &path, std::vector<std::uint8_t> const &bytes, std::wstring &error) noexcept {
  try {
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
    error = L"Unexpected I/O error while writing the capture output file.";
    return false;
  }
}

// Native WGC helpers

struct __declspec(uuid("3628E81B-3CAC-4C60-B7F4-23CE0E0C3356")) IGraphicsCaptureItemInterop : ::IUnknown {
  virtual HRESULT __stdcall CreateForWindow(HWND window, REFIID iid, void **result) = 0;
  virtual HRESULT __stdcall CreateForMonitor(HMONITOR monitor, REFIID iid, void **result) = 0;
};

extern "C" HRESULT __stdcall CreateDirect3D11DeviceFromDXGIDevice(
    IDXGIDevice *dxgiDevice,
    ::IInspectable **graphicsDevice);

std::optional<imaging::BitmapBounds> ResolveCropBounds(
    WindowEntry const &entry,
    CaptureRegion region,
    int bitmapWidth,
    int bitmapHeight,
    std::wstring &error) {
  if (region != CaptureRegion::Client) {
    return std::nullopt;
  }
  if (!entry.ClientRect) {
    error = L"WGC client-area capture requires clientRect metadata.";
    return std::nullopt;
  }
  if (entry.WindowRect.Width() <= 0 || entry.WindowRect.Height() <= 0) {
    error = L"Selected window rect is empty.";
    return std::nullopt;
  }

  auto scaleX = static_cast<double>(bitmapWidth) / static_cast<double>(entry.WindowRect.Width());
  auto scaleY = static_cast<double>(bitmapHeight) / static_cast<double>(entry.WindowRect.Height());
  auto left = static_cast<int>(std::lround((entry.ClientRect->Left - entry.WindowRect.Left) * scaleX));
  auto top = static_cast<int>(std::lround((entry.ClientRect->Top - entry.WindowRect.Top) * scaleY));
  auto right = static_cast<int>(std::lround((entry.ClientRect->Right - entry.WindowRect.Left) * scaleX));
  auto bottom = static_cast<int>(std::lround((entry.ClientRect->Bottom - entry.WindowRect.Top) * scaleY));

  left = std::clamp(left, 0, bitmapWidth);
  top = std::clamp(top, 0, bitmapHeight);
  right = std::clamp(right, 0, bitmapWidth);
  bottom = std::clamp(bottom, 0, bitmapHeight);
  if (right <= left || bottom <= top) {
    error = L"Client area crop resolved outside the captured window content.";
    return std::nullopt;
  }

  imaging::BitmapBounds bounds{};
  bounds.X = static_cast<std::uint32_t>(left);
  bounds.Y = static_cast<std::uint32_t>(top);
  bounds.Width = static_cast<std::uint32_t>(right - left);
  bounds.Height = static_cast<std::uint32_t>(bottom - top);
  return bounds;
}

bool SaveSoftwareBitmapToFile(
    imaging::SoftwareBitmap const &bitmap,
    fs::path const &outputPath,
    CaptureFormat format,
    std::optional<imaging::BitmapBounds> const &cropBounds,
    std::wstring &error) noexcept {
  try {
    auto stream = streams::InMemoryRandomAccessStream();
    auto encoder = imaging::BitmapEncoder::CreateAsync(
                       format == CaptureFormat::Jpg ? imaging::BitmapEncoder::JpegEncoderId()
                                                    : imaging::BitmapEncoder::PngEncoderId(),
                       stream)
                       .get();
    if (cropBounds) {
      encoder.BitmapTransform().Bounds(*cropBounds);
    }
    encoder.SetSoftwareBitmap(bitmap);
    encoder.FlushAsync().get();

    stream.Seek(0);
    auto length = static_cast<std::uint32_t>(stream.Size());
    auto reader = streams::DataReader(stream.GetInputStreamAt(0));
    reader.LoadAsync(length).get();
    std::vector<std::uint8_t> bytes(length);
    reader.ReadBytes(bytes);
    return WriteBytesToFile(outputPath, bytes, error);
  } catch (winrt::hresult_error const &hrError) {
    error = hrError.message().c_str();
    return false;
  } catch (...) {
    error = L"Unexpected WGC bitmap encoding failure.";
    return false;
  }
}

std::optional<json::JsonObject> RunWgcCapture(
    WindowEntry const &entry,
    CaptureRequest const &request,
    std::wstring &error) {
  if (!capture::GraphicsCaptureSession::IsSupported()) {
    error = L"Windows.Graphics.Capture is not supported on this machine.";
    return std::nullopt;
  }
  if (!entry.Handle) {
    error = L"The requested window handle is invalid.";
    return std::nullopt;
  }

  winrt::com_ptr<ID3D11Device> d3dDevice;
  winrt::com_ptr<ID3D11DeviceContext> d3dContext;
  D3D_FEATURE_LEVEL featureLevel{};
  winrt::check_hresult(D3D11CreateDevice(
      nullptr,
      D3D_DRIVER_TYPE_HARDWARE,
      nullptr,
      D3D11_CREATE_DEVICE_BGRA_SUPPORT,
      nullptr,
      0,
      D3D11_SDK_VERSION,
      d3dDevice.put(),
      &featureLevel,
      d3dContext.put()));

  auto dxgiDevice = d3dDevice.as<IDXGIDevice>();
  winrt::com_ptr<::IInspectable> graphicsDeviceInspectable;
  winrt::check_hresult(CreateDirect3D11DeviceFromDXGIDevice(dxgiDevice.get(), graphicsDeviceInspectable.put()));
  auto graphicsDevice = graphicsDeviceInspectable.as<direct3d::IDirect3DDevice>();

  auto interop = winrt::get_activation_factory<capture::GraphicsCaptureItem, IGraphicsCaptureItemInterop>();
  winrt::com_ptr<::IInspectable> captureItemInspectable;
  winrt::check_hresult(
      interop->CreateForWindow(entry.Handle, winrt::guid_of<capture::GraphicsCaptureItem>(), captureItemInspectable.put_void()));
  auto captureItem = captureItemInspectable.as<capture::GraphicsCaptureItem>();

  auto framePool = capture::Direct3D11CaptureFramePool::CreateFreeThreaded(
      graphicsDevice,
      winrt::Windows::Graphics::DirectX::DirectXPixelFormat::B8G8R8A8UIntNormalized,
      1,
      captureItem.Size());
  auto session = framePool.CreateCaptureSession(captureItem);
  session.IsCursorCaptureEnabled(request.IncludeCursor);

  winrt::handle frameReady(CreateEventW(nullptr, TRUE, FALSE, nullptr));
  std::optional<imaging::SoftwareBitmap> capturedBitmap;
  std::wstring captureError;
  auto token = framePool.FrameArrived([&](capture::Direct3D11CaptureFramePool const &sender, foundation::IInspectable const &) {
    try {
      auto frame = sender.TryGetNextFrame();
      if (!frame) {
        return;
      }
      capturedBitmap = imaging::SoftwareBitmap::CreateCopyFromSurfaceAsync(
                           frame.Surface(),
                           imaging::BitmapAlphaMode::Premultiplied)
                           .get();
    } catch (winrt::hresult_error const &hrError) {
      captureError = hrError.message().c_str();
    } catch (...) {
      captureError = L"Unexpected WGC frame capture failure.";
    }
    SetEvent(frameReady.get());
  });

  session.StartCapture();
  auto waitResult = WaitForSingleObject(frameReady.get(), static_cast<DWORD>(request.TimeoutMs));
  framePool.FrameArrived(token);

  if (waitResult != WAIT_OBJECT_0) {
    error = L"Timed out while waiting for a capture frame.";
    return std::nullopt;
  }
  if (!captureError.empty()) {
    error = captureError;
    return std::nullopt;
  }
  if (!capturedBitmap) {
    error = L"Capture session completed without a frame.";
    return std::nullopt;
  }

  auto cropBounds = ResolveCropBounds(entry, request.Region, capturedBitmap->PixelWidth(), capturedBitmap->PixelHeight(), error);
  if (!error.empty()) {
    return std::nullopt;
  }
  if (!SaveSoftwareBitmapToFile(*capturedBitmap, request.OutputPath, request.Format, cropBounds, error)) {
    return std::nullopt;
  }

  auto itemSize = captureItem.Size();
  json::JsonObject result;
  result.Insert(L"outputPath", json::JsonValue::CreateStringValue(request.OutputPath.wstring()));
  result.Insert(L"format", json::JsonValue::CreateStringValue(CaptureFormatName(request.Format)));
  result.Insert(L"itemWidth", json::JsonValue::CreateNumberValue(static_cast<double>(itemSize.Width)));
  result.Insert(L"itemHeight", json::JsonValue::CreateNumberValue(static_cast<double>(itemSize.Height)));
  result.Insert(L"bitmapWidth", json::JsonValue::CreateNumberValue(capturedBitmap->PixelWidth()));
  result.Insert(L"bitmapHeight", json::JsonValue::CreateNumberValue(capturedBitmap->PixelHeight()));

  if (cropBounds) {
    result.Insert(L"outputWidth", json::JsonValue::CreateNumberValue(cropBounds->Width));
    result.Insert(L"outputHeight", json::JsonValue::CreateNumberValue(cropBounds->Height));
    result.Insert(L"cropLeft", json::JsonValue::CreateNumberValue(cropBounds->X));
    result.Insert(L"cropTop", json::JsonValue::CreateNumberValue(cropBounds->Y));
    result.Insert(L"cropWidth", json::JsonValue::CreateNumberValue(cropBounds->Width));
    result.Insert(L"cropHeight", json::JsonValue::CreateNumberValue(cropBounds->Height));
  } else {
    result.Insert(L"outputWidth", json::JsonValue::CreateNumberValue(capturedBitmap->PixelWidth()));
    result.Insert(L"outputHeight", json::JsonValue::CreateNumberValue(capturedBitmap->PixelHeight()));
    result.Insert(L"cropLeft", json::JsonValue::CreateNumberValue(0));
    result.Insert(L"cropTop", json::JsonValue::CreateNumberValue(0));
    result.Insert(L"cropWidth", json::JsonValue::CreateNumberValue(capturedBitmap->PixelWidth()));
    result.Insert(L"cropHeight", json::JsonValue::CreateNumberValue(capturedBitmap->PixelHeight()));
  }
  result.Insert(L"includeCursor", json::JsonValue::CreateBooleanValue(request.IncludeCursor));
  return result;
}

// Bridge entrypoints

std::optional<json::JsonObject> RunCopyScreenCapture(
    WindowEntry const &entry,
    CaptureRequest const &request,
    ScreenRect const &captureRect,
    std::wstring &error) noexcept {
  std::vector<std::uint8_t> pixels;
  int outputWidth = 0;
  int outputHeight = 0;
  if (!CapturePixelsFromScreen(captureRect, pixels, outputWidth, outputHeight, error)) {
    return std::nullopt;
  }

  std::vector<std::uint8_t> encoded;
  if (!EncodePixelsToBytes(pixels, outputWidth, outputHeight, request.Format, encoded, error)) {
    return std::nullopt;
  }

  if (!WriteBytesToFile(request.OutputPath, encoded, error)) {
    return std::nullopt;
  }

  json::JsonObject result;
  result.Insert(L"outputPath", json::JsonValue::CreateStringValue(request.OutputPath.wstring()));
  result.Insert(L"format", json::JsonValue::CreateStringValue(CaptureFormatName(request.Format)));
  result.Insert(L"captureSize", CreateSizeJson(outputWidth, outputHeight));
  result.Insert(
      L"visibilityWarning",
      (!request.Activate && !entry.IsForeground)
          ? json::JsonValue::CreateStringValue(
                L"Target window was not foreground. This capture copied visible desktop pixels in that region, so occlusion can leak into the result.")
          : NullJsonValue());
  return result;
}

std::optional<int> ReadRequiredJsonInt(json::JsonObject const &value, wchar_t const *key) noexcept {
  auto number = TryReadJsonNumber(value, key);
  if (!number) {
    return std::nullopt;
  }
  return static_cast<int>(std::llround(*number));
}

std::optional<std::string> BuildCaptureResponse(
    WindowEntry const &entry,
    CaptureRequest const &request,
    ScreenRect const &captureRect,
    int matchedCount,
    std::optional<json::JsonObject> const &backendResult,
    std::wstring &error) {
  if (!backendResult) {
    error = L"Capture backend did not return a result.";
    return std::nullopt;
  }

  json::JsonObject response;
  response.Insert(L"outputPath", json::JsonValue::CreateStringValue(request.OutputPath.wstring()));
  response.Insert(L"format", json::JsonValue::CreateStringValue(CaptureFormatName(request.Format)));
  response.Insert(L"region", json::JsonValue::CreateStringValue(CaptureRegionName(request.Region)));
  response.Insert(L"backend", json::JsonValue::CreateStringValue(CaptureBackendName(request.Backend)));
  response.Insert(L"requestedBackend", json::JsonValue::CreateStringValue(CaptureBackendName(request.RequestedBackend)));
  response.Insert(L"activate", json::JsonValue::CreateBooleanValue(request.Activate));
  response.Insert(L"activationDelayMs", json::JsonValue::CreateNumberValue(request.ActivationDelayMs));
  response.Insert(L"matchedCount", json::JsonValue::CreateNumberValue(matchedCount));
  response.Insert(L"selectedWindow", CreateWindowJson(entry));
  response.Insert(L"captureRect", CreateRectJson(captureRect));

  if (request.Backend == CaptureBackend::Wgc) {
    auto outputWidth = ReadRequiredJsonInt(*backendResult, L"outputWidth");
    auto outputHeight = ReadRequiredJsonInt(*backendResult, L"outputHeight");
    auto itemWidth = ReadRequiredJsonInt(*backendResult, L"itemWidth");
    auto itemHeight = ReadRequiredJsonInt(*backendResult, L"itemHeight");
    auto cropLeft = ReadRequiredJsonInt(*backendResult, L"cropLeft");
    auto cropTop = ReadRequiredJsonInt(*backendResult, L"cropTop");
    auto cropWidth = ReadRequiredJsonInt(*backendResult, L"cropWidth");
    auto cropHeight = ReadRequiredJsonInt(*backendResult, L"cropHeight");
    if (!outputWidth || !outputHeight || !itemWidth || !itemHeight || !cropLeft || !cropTop || !cropWidth || !cropHeight) {
      error = L"WGC backend returned an incomplete payload.";
      return std::nullopt;
    }

    response.Insert(L"captureSize", CreateSizeJson(*outputWidth, *outputHeight));
    response.Insert(L"sourceItemSize", CreateSizeJson(*itemWidth, *itemHeight));
    response.Insert(
        L"cropBounds",
        CreateRectJson(ScreenRect{*cropLeft, *cropTop, *cropLeft + *cropWidth, *cropTop + *cropHeight}));
    response.Insert(L"visibilityWarning", NullJsonValue());
  } else {
    response.Insert(L"captureSize", backendResult->GetNamedObject(L"captureSize"));
    response.Insert(
        L"visibilityWarning",
        backendResult->HasKey(L"visibilityWarning") ? backendResult->Lookup(L"visibilityWarning") : NullJsonValue());
  }

  return winrt::to_string(response.Stringify());
}

} // namespace

REACT_MODULE(OpappWindowCaptureModule, L"OpappWindowCapture")
struct OpappWindowCaptureModule {
  REACT_METHOD(ListVisibleWindows, L"listVisibleWindows")
  void ListVisibleWindows(
      std::string selectorJson,
      winrt::Microsoft::ReactNative::ReactPromise<std::string> &&result) noexcept;

  REACT_METHOD(CaptureWindow, L"captureWindow")
  void CaptureWindow(
      std::string selectorJson,
      std::string optionsJson,
      winrt::Microsoft::ReactNative::ReactPromise<std::string> &&result) noexcept;
};

void OpappWindowCaptureModule::ListVisibleWindows(
    std::string selectorJson,
    winrt::Microsoft::ReactNative::ReactPromise<std::string> &&result) noexcept {
  std::wstring error;
  auto selector = ParseSelector(selectorJson, error);
  if (!selector) {
    result.Reject(error.c_str());
    return;
  }

  result.Resolve(SerializeWindowArray(EnumerateMatchingWindows(*selector)));
}

void OpappWindowCaptureModule::CaptureWindow(
    std::string selectorJson,
    std::string optionsJson,
    winrt::Microsoft::ReactNative::ReactPromise<std::string> &&result) noexcept {
  std::wstring error;
  auto selector = ParseSelector(selectorJson, error);
  if (!selector) {
    result.Reject(error.c_str());
    return;
  }

  auto request = ParseCaptureRequest(optionsJson, *selector, error);
  if (!request) {
    result.Reject(error.c_str());
    return;
  }

  if (!EnsureParentDirectory(request->OutputPath, error)) {
    result.Reject(error.c_str());
    return;
  }

  auto matches = EnumerateMatchingWindows(*selector);
  if (matches.empty()) {
    result.Reject(L"No visible top-level window matched the requested selector.");
    return;
  }

  auto selectedWindow = matches.front();
  auto matchedCount = static_cast<int>(matches.size());
  if (request->Activate) {
    ActivateWindow(selectedWindow, request->ActivationDelayMs);
    auto activatedMatches = EnumerateMatchingWindows(*selector);
    matchedCount = static_cast<int>(activatedMatches.size());
    if (!activatedMatches.empty()) {
      selectedWindow = activatedMatches.front();
    }
  }

  auto captureRect = ResolveCaptureRect(selectedWindow, request->Region, error);
  if (!captureRect) {
    result.Reject(error.c_str());
    return;
  }

  OpappWindowsHost::AppendLog(
      "WindowCapture.Start backend=" + WideToUtf8(CaptureBackendName(request->Backend)) + " region=" +
      WideToUtf8(CaptureRegionName(request->Region)) + " handle=" + WideToUtf8(selectedWindow.HandleHex));

  std::optional<json::JsonObject> backendResult;
  try {
    backendResult = request->Backend == CaptureBackend::Wgc
        ? RunWgcCapture(selectedWindow, *request, error)
        : RunCopyScreenCapture(selectedWindow, *request, *captureRect, error);
  } catch (winrt::hresult_error const &hrError) {
    error = hrError.message().c_str();
  } catch (...) {
    error = L"Unexpected native window capture failure.";
  }

  if (!backendResult) {
    result.Reject(error.empty() ? L"Window capture failed." : error.c_str());
    return;
  }

  auto response = BuildCaptureResponse(selectedWindow, *request, *captureRect, matchedCount, backendResult, error);
  if (!response) {
    result.Reject(error.c_str());
    return;
  }

  OpappWindowsHost::AppendLog(
      "WindowCapture.Done backend=" + WideToUtf8(CaptureBackendName(request->Backend)) + " bytes=" +
      std::to_string(response->size()));
  result.Resolve(*response);
}

} // namespace OpappWindowsHostModules
