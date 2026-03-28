// OpappWindowsHost.cpp : Defines the entry point for the application.
//

#include "pch.h"
#include "OpappWindowsHost.h"
#include "HostCore.h"
#include "WindowManager.h"

#include <MddBootstrap.h>
#include <WindowsAppSDK-VersionInfo.h>

#include "AutolinkedNativeModules.g.h"
#include "NativeModules.h"

#include <algorithm>
#include <array>
#include <cctype>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdint>
#include <cwctype>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <sstream>
#include <thread>
#include <urlmon.h>
#include <vector>
#include <bcrypt.h>
#include <winrt/Windows.Data.Json.h>

#pragma comment(lib, "urlmon.lib")
#pragma comment(lib, "bcrypt.lib")

using namespace OpappWindowsHost;

namespace {

// Reads bundle-manifest.json from bundleRoot and returns the entryFile field
// with the ".bundle" suffix stripped (e.g. "index.windows.bundle" -> "index.windows"),
// or nullopt if the manifest cannot be read or parsed.
std::optional<std::wstring> ReadBundleManifestEntryFile(std::wstring const &bundleRoot) noexcept {
  try {
    auto manifestPath = std::filesystem::path(bundleRoot) / L"bundle-manifest.json";
    std::ifstream stream(manifestPath, std::ios::binary);
    if (!stream.is_open()) {
      return std::nullopt;
    }

    std::string contents((std::istreambuf_iterator<char>(stream)), std::istreambuf_iterator<char>());

    auto jsonObject = winrt::Windows::Data::Json::JsonObject::Parse(winrt::to_hstring(contents));
    auto entryFileHstr = jsonObject.GetNamedString(L"entryFile");
    std::wstring entryFile(entryFileHstr.c_str(), entryFileHstr.size());

    constexpr std::wstring_view kBundleSuffix = L".bundle";
    if (entryFile.size() > kBundleSuffix.size() &&
        entryFile.substr(entryFile.size() - kBundleSuffix.size()) == kBundleSuffix) {
      entryFile = entryFile.substr(0, entryFile.size() - kBundleSuffix.size());
    }

    if (entryFile.empty()) {
      return std::nullopt;
    }

    return entryFile;
  } catch (...) {
    return std::nullopt;
  }
}

// Reads bundle-manifest.json from bundleRoot and returns the version field, or
// nullopt if the manifest cannot be read or parsed.
std::optional<std::wstring> ReadBundleManifestVersion(std::wstring const &bundleRoot) noexcept {
  try {
    auto manifestPath = std::filesystem::path(bundleRoot) / L"bundle-manifest.json";
    std::ifstream stream(manifestPath, std::ios::binary);
    if (!stream.is_open()) {
      return std::nullopt;
    }

    std::string contents((std::istreambuf_iterator<char>(stream)), std::istreambuf_iterator<char>());
    auto jsonObject = winrt::Windows::Data::Json::JsonObject::Parse(winrt::to_hstring(contents));
    auto versionHstr = jsonObject.GetNamedString(L"version");
    std::wstring version(versionHstr.c_str(), versionHstr.size());
    if (version.empty()) {
      return std::nullopt;
    }

    return version;
  } catch (...) {
    return std::nullopt;
  }
}

// Reads bundle-manifest.json from bundleRoot and returns the bundleId field, or
// nullopt if the manifest cannot be read or parsed.
std::optional<std::wstring> ReadBundleManifestBundleId(std::wstring const &bundleRoot) noexcept {
  try {
    auto manifestPath = std::filesystem::path(bundleRoot) / L"bundle-manifest.json";
    std::ifstream stream(manifestPath, std::ios::binary);
    if (!stream.is_open()) {
      return std::nullopt;
    }

    std::string contents((std::istreambuf_iterator<char>(stream)), std::istreambuf_iterator<char>());
    auto jsonObject = winrt::Windows::Data::Json::JsonObject::Parse(winrt::to_hstring(contents));
    auto bundleIdHstr = jsonObject.GetNamedString(L"bundleId");
    std::wstring bundleId(bundleIdHstr.c_str(), bundleIdHstr.size());
    if (bundleId.empty()) {
      return std::nullopt;
    }

    return bundleId;
  } catch (...) {
    return std::nullopt;
  }
}

void LogRedBoxError(std::string const &phase, winrt::Microsoft::ReactNative::IRedBoxErrorInfo const &info) noexcept {
  AppendLog(phase + ".Message=" + ToUtf8(info.Message()));
  AppendLog(phase + ".OriginalMessage=" + ToUtf8(info.OriginalMessage()));
  AppendLog(phase + ".Name=" + ToUtf8(info.Name()));
  AppendLog(phase + ".ComponentStack=" + ToUtf8(info.ComponentStack()));

  auto frames = info.Callstack();
  for (uint32_t i = 0; i < frames.Size(); ++i) {
    auto frame = frames.GetAt(i);
    AppendLog(
        phase + ".Frame[" + std::to_string(i) + "]=" + ToUtf8(frame.Method()) + " @ " + ToUtf8(frame.File()) +
        ":" + std::to_string(frame.Line()) + ":" + std::to_string(frame.Column()));
  }
}

struct WindowsAppRuntimeBootstrap {
  HMODULE Module{nullptr};
  decltype(&MddBootstrapShutdown) Shutdown{nullptr};
  bool Initialized{false};

  ~WindowsAppRuntimeBootstrap() noexcept {
    if (Initialized && Shutdown) {
      Shutdown();
      AppendLog("WinMain.BootstrapShutdown.Done");
    }

    if (Module) {
      FreeLibrary(Module);
    }
  }
};

bool HasPackageIdentity() noexcept {
  UINT32 packageFullNameLength = 0;
  auto result = GetCurrentPackageFullName(&packageFullNameLength, nullptr);
  return result != APPMODEL_ERROR_NO_PACKAGE;
}

WindowsAppRuntimeBootstrap InitializeWindowsAppRuntimeBootstrap() {
  AppendLog("WinMain.BootstrapInitialize");

  if (HasPackageIdentity()) {
    AppendLog("WinMain.BootstrapInitialize.SkipPackageIdentity");
    return {};
  }

  auto bootstrapModule = LoadLibraryW(L"Microsoft.WindowsAppRuntime.Bootstrap.dll");
  if (!bootstrapModule) {
    throw winrt::hresult_error(
        HRESULT_FROM_WIN32(GetLastError()),
        L"LoadLibrary(Microsoft.WindowsAppRuntime.Bootstrap.dll) failed");
  }

  auto initialize = reinterpret_cast<decltype(&MddBootstrapInitialize2)>(
      GetProcAddress(bootstrapModule, "MddBootstrapInitialize2"));
  auto shutdown =
      reinterpret_cast<decltype(&MddBootstrapShutdown)>(GetProcAddress(bootstrapModule, "MddBootstrapShutdown"));
  if (!initialize || !shutdown) {
    auto error = GetLastError();
    FreeLibrary(bootstrapModule);
    throw winrt::hresult_error(
        HRESULT_FROM_WIN32(error == 0 ? ERROR_PROC_NOT_FOUND : error),
        L"GetProcAddress(MddBootstrap*) failed");
  }

  PACKAGE_VERSION minVersion{};
  minVersion.Version = WINDOWSAPPSDK_RUNTIME_VERSION_UINT64;
  auto hr = initialize(
      WINDOWSAPPSDK_RELEASE_MAJORMINOR,
      WINDOWSAPPSDK_RELEASE_VERSION_TAG_W,
      minVersion,
      MddBootstrapInitializeOptions_None);
  if (FAILED(hr)) {
    FreeLibrary(bootstrapModule);
    throw winrt::hresult_error(hr, L"MddBootstrapInitialize2 failed");
  }

  AppendLog("WinMain.BootstrapInitialize.Done");
  return WindowsAppRuntimeBootstrap{bootstrapModule, shutdown, true};
}

struct LoggingRedBoxHandler
    : winrt::implements<LoggingRedBoxHandler, winrt::Microsoft::ReactNative::IRedBoxHandler> {
  LoggingRedBoxHandler(winrt::Microsoft::ReactNative::IRedBoxHandler innerHandler) noexcept
      : m_innerHandler(std::move(innerHandler)) {}

  void ShowNewError(
      winrt::Microsoft::ReactNative::IRedBoxErrorInfo const &info,
      winrt::Microsoft::ReactNative::RedBoxErrorType type) noexcept {
    AppendLog(std::string("RedBox.ShowNewError type=") + std::to_string(static_cast<int>(type)));
    LogRedBoxError("RedBox", info);

    if (m_innerHandler && m_innerHandler.IsDevSupportEnabled()) {
      m_innerHandler.ShowNewError(info, type);
    }
  }

  bool IsDevSupportEnabled() noexcept {
    return true;
  }

  void UpdateError(winrt::Microsoft::ReactNative::IRedBoxErrorInfo const &info) noexcept {
    AppendLog("RedBox.UpdateError");
    LogRedBoxError("RedBoxUpdate", info);

    if (m_innerHandler && m_innerHandler.IsDevSupportEnabled()) {
      m_innerHandler.UpdateError(info);
    }
  }

  void DismissRedBox() noexcept {
    AppendLog("RedBox.DismissRedBox");

    if (m_innerHandler && m_innerHandler.IsDevSupportEnabled()) {
      m_innerHandler.DismissRedBox();
    }
  }

 private:
  winrt::Microsoft::ReactNative::IRedBoxHandler m_innerHandler{nullptr};
};

// Resolves a tooling script path by searching upward from the exe directory
// until a matching <ancestor>/tooling/scripts/<scriptName> is found.
//
// Portable output reaches the repo root in ~5 levels, while the packaged AppX
// output sits deeper under OpappWindowsHost.Package/bin/x64/Release/AppX/.
// Walking ancestors keeps both layouts working inside the repo while still
// returning nullopt for deployments that do not include the development
// toolchain beside the build output.
std::optional<std::wstring> ResolveToolingScriptPath(
    std::wstring const &appDirectory,
    std::wstring const &scriptName) noexcept {
  try {
    auto currentPath = std::filesystem::path(appDirectory);
    while (!currentPath.empty()) {
      auto scriptPath = currentPath / L"tooling" / L"scripts" / scriptName;
      if (std::filesystem::exists(scriptPath)) {
        return scriptPath.wstring();
      }

      auto parentPath = currentPath.parent_path();
      if (parentPath == currentPath) {
        break;
      }
      currentPath = parentPath;
    }
    return std::nullopt;
  } catch (...) {
    return std::nullopt;
  }
}

std::string FormatHResult(HRESULT hr) {
  std::ostringstream stream;
  stream << "0x" << std::hex << std::uppercase << static_cast<unsigned long>(hr);
  return stream.str();
}

std::wstring TrimTrailingSlashes(std::wstring value) {
  while (!value.empty() && (value.back() == L'/' || value.back() == L'\\')) {
    value.pop_back();
  }
  return value;
}

std::wstring NowIso8601Utc() {
  SYSTEMTIME systemTime{};
  GetSystemTime(&systemTime);

  std::wostringstream stream;
  stream << std::setfill(L'0')
         << std::setw(4) << systemTime.wYear << L"-"
         << std::setw(2) << systemTime.wMonth << L"-"
         << std::setw(2) << systemTime.wDay << L"T"
         << std::setw(2) << systemTime.wHour << L":"
         << std::setw(2) << systemTime.wMinute << L":"
         << std::setw(2) << systemTime.wSecond << L"."
         << std::setw(3) << systemTime.wMilliseconds << L"Z";
  return stream.str();
}

std::optional<std::wstring> ReadEnvironmentString(std::wstring const &name) noexcept {
  DWORD required = GetEnvironmentVariableW(name.c_str(), nullptr, 0);
  if (required == 0) {
    return std::nullopt;
  }

  std::wstring value(required > 0 ? required - 1 : 0, L'\0');
  if (required > 1) {
    GetEnvironmentVariableW(name.c_str(), value.data(), required);
  }
  return value;
}

bool WriteUtf8File(std::filesystem::path const &path, std::string const &contents) {
  try {
    std::filesystem::create_directories(path.parent_path());
    std::ofstream stream(path, std::ios::binary | std::ios::trunc);
    stream.write(contents.data(), static_cast<std::streamsize>(contents.size()));
    return stream.good();
  } catch (...) {
    return false;
  }
}

std::optional<std::string> ReadUtf8File(std::filesystem::path const &path) {
  try {
    std::ifstream stream(path, std::ios::binary);
    if (!stream.is_open()) {
      return std::nullopt;
    }

    return std::string((std::istreambuf_iterator<char>(stream)), std::istreambuf_iterator<char>());
  } catch (...) {
    return std::nullopt;
  }
}

std::optional<winrt::Windows::Data::Json::JsonObject> ReadJsonFile(std::filesystem::path const &path) {
  auto contents = ReadUtf8File(path);
  if (!contents) {
    return std::nullopt;
  }

  try {
    return winrt::Windows::Data::Json::JsonObject::Parse(winrt::to_hstring(*contents));
  } catch (...) {
    return std::nullopt;
  }
}

bool WriteJsonFile(
    std::filesystem::path const &path,
    winrt::Windows::Data::Json::JsonObject const &jsonObject) {
  auto jsonString = winrt::to_string(jsonObject.Stringify()) + "\n";
  return WriteUtf8File(path, jsonString);
}

void InsertStringField(
    winrt::Windows::Data::Json::JsonObject &target,
    std::wstring const &key,
    std::wstring const &value) {
  target.Insert(key, winrt::Windows::Data::Json::JsonValue::CreateStringValue(value));
}

void InsertOptionalStringField(
    winrt::Windows::Data::Json::JsonObject &target,
    std::wstring const &key,
    std::optional<std::wstring> const &value) {
  if (value && !value->empty()) {
    target.Insert(key, winrt::Windows::Data::Json::JsonValue::CreateStringValue(*value));
  } else {
    target.Insert(key, winrt::Windows::Data::Json::JsonValue::CreateNullValue());
  }
}

std::wstring ResolveOtaChannel(
    std::filesystem::path const &cacheRoot,
    std::optional<std::wstring> const &channelOverride) {
  auto channelPath = cacheRoot / L"channel.json";
  if (channelOverride && !channelOverride->empty()) {
    winrt::Windows::Data::Json::JsonObject channelObject;
    InsertStringField(channelObject, L"channel", *channelOverride);
    InsertStringField(channelObject, L"updatedAt", NowIso8601Utc());
    if (!WriteJsonFile(channelPath, channelObject)) {
      AppendLog("OTA.Native.ChannelPersistFailed path=" + ToUtf8(channelPath.wstring()));
    } else {
      AppendLog("OTA.Native.ChannelPersisted value=" + ToUtf8(*channelOverride));
    }
    return *channelOverride;
  }

  if (auto channelObject = ReadJsonFile(channelPath)) {
    try {
      std::wstring persistedChannel = channelObject->GetNamedString(L"channel", L"").c_str();
      if (!persistedChannel.empty()) {
        AppendLog("OTA.Native.ChannelLoaded value=" + ToUtf8(persistedChannel));
        return persistedChannel;
      }
    } catch (...) {
      AppendLog("OTA.Native.ChannelInvalid path=" + ToUtf8(channelPath.wstring()));
    }
  }

  AppendLog("OTA.Native.ChannelDefaulted value=stable");
  return std::wstring(L"stable");
}

std::optional<std::wstring> ReadPersistedOtaDeviceId(std::filesystem::path const &cacheRoot) noexcept {
  try {
    auto deviceIdPath = cacheRoot / L"device-id.json";
    auto deviceIdObject = ReadJsonFile(deviceIdPath);
    if (!deviceIdObject) {
      return std::nullopt;
    }

    std::wstring deviceId = deviceIdObject->GetNamedString(L"deviceId", L"").c_str();
    if (deviceId.empty()) {
      return std::nullopt;
    }

    std::transform(
        deviceId.begin(),
        deviceId.end(),
        deviceId.begin(),
        [](wchar_t ch) { return static_cast<wchar_t>(std::towlower(ch)); });
    return deviceId;
  } catch (...) {
    return std::nullopt;
  }
}

std::optional<std::wstring> GenerateUuidV4() noexcept {
  std::array<unsigned char, 16> bytes{};
  if (BCryptGenRandom(
          nullptr,
          bytes.data(),
          static_cast<ULONG>(bytes.size()),
          BCRYPT_USE_SYSTEM_PREFERRED_RNG) != 0) {
    return std::nullopt;
  }

  bytes[6] = static_cast<unsigned char>((bytes[6] & 0x0F) | 0x40);
  bytes[8] = static_cast<unsigned char>((bytes[8] & 0x3F) | 0x80);

  wchar_t buffer[37] = {};
  auto written = swprintf_s(
      buffer,
      std::size(buffer),
      L"%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",
      bytes[0],
      bytes[1],
      bytes[2],
      bytes[3],
      bytes[4],
      bytes[5],
      bytes[6],
      bytes[7],
      bytes[8],
      bytes[9],
      bytes[10],
      bytes[11],
      bytes[12],
      bytes[13],
      bytes[14],
      bytes[15]);
  if (written <= 0) {
    return std::nullopt;
  }

  return std::wstring(buffer);
}

std::optional<std::wstring> GetOrCreateOtaDeviceId(std::filesystem::path const &cacheRoot) noexcept {
  if (auto persistedDeviceId = ReadPersistedOtaDeviceId(cacheRoot)) {
    return persistedDeviceId;
  }

  auto generatedDeviceId = GenerateUuidV4();
  if (!generatedDeviceId) {
    return std::nullopt;
  }

  auto deviceIdPath = cacheRoot / L"device-id.json";
  winrt::Windows::Data::Json::JsonObject deviceIdObject;
  InsertStringField(deviceIdObject, L"deviceId", *generatedDeviceId);
  InsertStringField(deviceIdObject, L"createdAt", NowIso8601Utc());
  if (!WriteJsonFile(deviceIdPath, deviceIdObject)) {
    AppendLog("OTA.Native.DeviceIdPersistFailed path=" + ToUtf8(deviceIdPath.wstring()));
    return std::nullopt;
  }

  AppendLog("OTA.Native.DeviceIdPersisted path=" + ToUtf8(deviceIdPath.wstring()));
  return generatedDeviceId;
}

std::optional<std::filesystem::path> ResolveRepoRootFromAppDirectory(std::wstring const &appDirectory) {
  try {
    auto currentPath = std::filesystem::path(appDirectory);
    while (!currentPath.empty()) {
      auto toolingScriptsPath = currentPath / L"tooling" / L"scripts";
      auto hostRootPath = currentPath / L"hosts" / L"windows-host";
      if (std::filesystem::exists(toolingScriptsPath) && std::filesystem::exists(hostRootPath)) {
        return currentPath;
      }

      auto parentPath = currentPath.parent_path();
      if (parentPath == currentPath) {
        break;
      }
      currentPath = parentPath;
    }
  } catch (...) {
    // Fall through to std::nullopt.
  }

  return std::nullopt;
}

std::filesystem::path ResolveOtaCacheRoot(std::wstring const &appDirectory) {
  if (auto repoRoot = ResolveRepoRootFromAppDirectory(appDirectory)) {
    return *repoRoot / L".ota-cache";
  }

  if (auto localAppData = ReadEnvironmentString(L"LOCALAPPDATA")) {
    return std::filesystem::path(*localAppData) / L"OPApp" / L".ota-cache";
  }

  wchar_t tempPath[MAX_PATH] = {};
  auto tempLength = GetTempPathW(MAX_PATH, tempPath);
  if (tempLength > 0 && tempLength <= MAX_PATH) {
    return std::filesystem::path(tempPath) / L"OPApp" / L".ota-cache";
  }

  return std::filesystem::path(appDirectory) / L".ota-cache";
}

bool DownloadUrlToFile(
    std::wstring const &url,
    std::filesystem::path const &targetPath,
    std::string const &phaseLabel,
    bool required = true) {
  try {
    std::filesystem::create_directories(targetPath.parent_path());
  } catch (...) {
    AppendLog(
        phaseLabel + ".Failed pathCreate target=" + ToUtf8(targetPath.wstring()));
    return false;
  }

  auto hr = URLDownloadToFileW(nullptr, url.c_str(), targetPath.wstring().c_str(), 0, nullptr);
  if (FAILED(hr)) {
    if (required) {
      AppendLog(
          phaseLabel + ".Failed hr=" + FormatHResult(hr) +
          " url=" + ToUtf8(url));
    } else {
      AppendLog(
          phaseLabel + ".SkippedOptional hr=" + FormatHResult(hr) +
          " url=" + ToUtf8(url));
    }
    return false;
  }

  AppendLog(
      phaseLabel + ".OK url=" + ToUtf8(url) +
      " target=" + ToUtf8(targetPath.wstring()));
  return true;
}

std::optional<std::string> ComputeSha256Hex(std::filesystem::path const &filePath) {
  BCRYPT_ALG_HANDLE algorithmHandle = nullptr;
  BCRYPT_HASH_HANDLE hashHandle = nullptr;
  std::vector<uint8_t> hashObject;
  std::vector<uint8_t> hashValue;

  auto cleanup = [&]() noexcept {
    if (hashHandle) {
      BCryptDestroyHash(hashHandle);
      hashHandle = nullptr;
    }
    if (algorithmHandle) {
      BCryptCloseAlgorithmProvider(algorithmHandle, 0);
      algorithmHandle = nullptr;
    }
  };

  try {
    if (BCryptOpenAlgorithmProvider(&algorithmHandle, BCRYPT_SHA256_ALGORITHM, nullptr, 0) != 0) {
      cleanup();
      return std::nullopt;
    }

    DWORD objectSize = 0;
    DWORD bytesWritten = 0;
    if (BCryptGetProperty(
            algorithmHandle,
            BCRYPT_OBJECT_LENGTH,
            reinterpret_cast<PUCHAR>(&objectSize),
            sizeof(objectSize),
            &bytesWritten,
            0) != 0 ||
        objectSize == 0) {
      cleanup();
      return std::nullopt;
    }

    DWORD hashSize = 0;
    if (BCryptGetProperty(
            algorithmHandle,
            BCRYPT_HASH_LENGTH,
            reinterpret_cast<PUCHAR>(&hashSize),
            sizeof(hashSize),
            &bytesWritten,
            0) != 0 ||
        hashSize == 0) {
      cleanup();
      return std::nullopt;
    }

    hashObject.resize(objectSize);
    hashValue.resize(hashSize);

    if (BCryptCreateHash(
            algorithmHandle,
            &hashHandle,
            hashObject.data(),
            objectSize,
            nullptr,
            0,
            0) != 0) {
      cleanup();
      return std::nullopt;
    }

    std::ifstream stream(filePath, std::ios::binary);
    if (!stream.is_open()) {
      cleanup();
      return std::nullopt;
    }

    std::vector<char> buffer(64 * 1024);
    while (stream.good()) {
      stream.read(buffer.data(), static_cast<std::streamsize>(buffer.size()));
      auto chunkSize = stream.gcount();
      if (chunkSize <= 0) {
        continue;
      }

      if (BCryptHashData(
              hashHandle,
              reinterpret_cast<PUCHAR>(buffer.data()),
              static_cast<ULONG>(chunkSize),
              0) != 0) {
        cleanup();
        return std::nullopt;
      }
    }

    if (!stream.eof()) {
      cleanup();
      return std::nullopt;
    }

    if (BCryptFinishHash(hashHandle, hashValue.data(), hashSize, 0) != 0) {
      cleanup();
      return std::nullopt;
    }

    std::ostringstream hashHex;
    hashHex << std::hex << std::setfill('0');
    for (auto byte : hashValue) {
      hashHex << std::setw(2) << static_cast<int>(byte);
    }

    cleanup();
    return hashHex.str();
  } catch (...) {
    cleanup();
    return std::nullopt;
  }
}

std::optional<std::string> ComputeSha256HexForString(std::string const &value) {
  BCRYPT_ALG_HANDLE algorithmHandle = nullptr;
  BCRYPT_HASH_HANDLE hashHandle = nullptr;
  std::vector<uint8_t> hashObject;
  std::vector<uint8_t> hashValue;

  auto cleanup = [&]() noexcept {
    if (hashHandle) {
      BCryptDestroyHash(hashHandle);
      hashHandle = nullptr;
    }
    if (algorithmHandle) {
      BCryptCloseAlgorithmProvider(algorithmHandle, 0);
      algorithmHandle = nullptr;
    }
  };

  try {
    if (BCryptOpenAlgorithmProvider(&algorithmHandle, BCRYPT_SHA256_ALGORITHM, nullptr, 0) != 0) {
      cleanup();
      return std::nullopt;
    }

    DWORD objectSize = 0;
    DWORD bytesWritten = 0;
    if (BCryptGetProperty(
            algorithmHandle,
            BCRYPT_OBJECT_LENGTH,
            reinterpret_cast<PUCHAR>(&objectSize),
            sizeof(objectSize),
            &bytesWritten,
            0) != 0 ||
        objectSize == 0) {
      cleanup();
      return std::nullopt;
    }

    DWORD hashSize = 0;
    if (BCryptGetProperty(
            algorithmHandle,
            BCRYPT_HASH_LENGTH,
            reinterpret_cast<PUCHAR>(&hashSize),
            sizeof(hashSize),
            &bytesWritten,
            0) != 0 ||
        hashSize == 0) {
      cleanup();
      return std::nullopt;
    }

    hashObject.resize(objectSize);
    hashValue.resize(hashSize);

    if (BCryptCreateHash(
            algorithmHandle,
            &hashHandle,
            hashObject.data(),
            objectSize,
            nullptr,
            0,
            0) != 0) {
      cleanup();
      return std::nullopt;
    }

    if (BCryptHashData(
            hashHandle,
            reinterpret_cast<PUCHAR>(const_cast<char *>(value.data())),
            static_cast<ULONG>(value.size()),
            0) != 0) {
      cleanup();
      return std::nullopt;
    }

    if (BCryptFinishHash(hashHandle, hashValue.data(), hashSize, 0) != 0) {
      cleanup();
      return std::nullopt;
    }

    std::ostringstream hashHex;
    hashHex << std::hex << std::setfill('0');
    for (auto byte : hashValue) {
      hashHex << std::setw(2) << static_cast<int>(byte);
    }

    cleanup();
    return hashHex.str();
  } catch (...) {
    cleanup();
    return std::nullopt;
  }
}

std::optional<int32_t> ParseRolloutPercent(winrt::Windows::Data::Json::JsonObject const &bundleInfoObject) noexcept {
  if (!bundleInfoObject.HasKey(L"rolloutPercent")) {
    return std::nullopt;
  }

  try {
    auto rawRolloutPercent = bundleInfoObject.GetNamedNumber(L"rolloutPercent", 100.0);
    if (!std::isfinite(rawRolloutPercent)) {
      return std::nullopt;
    }

    auto roundedRolloutPercent = static_cast<int32_t>(std::lround(rawRolloutPercent));
    return std::clamp<int32_t>(roundedRolloutPercent, 0, 100);
  } catch (...) {
    return std::nullopt;
  }
}

std::optional<std::wstring> ResolveLatestVersionFromVersions(
    winrt::Windows::Data::Json::JsonObject const &bundleInfoObject) noexcept {
  try {
    auto versionsValue = bundleInfoObject.GetNamedValue(L"versions", nullptr);
    if (!versionsValue ||
        versionsValue.ValueType() != winrt::Windows::Data::Json::JsonValueType::Array) {
      return std::nullopt;
    }

    auto versionsArray = versionsValue.GetArray();
    std::optional<std::wstring> latestVersion;
    for (auto const &value : versionsArray) {
      if (value.ValueType() != winrt::Windows::Data::Json::JsonValueType::String) {
        continue;
      }

      auto candidate = std::wstring(value.GetString());
      if (candidate.empty()) {
        continue;
      }

      if (!latestVersion || candidate > *latestVersion) {
        latestVersion = candidate;
      }
    }

    return latestVersion;
  } catch (...) {
    return std::nullopt;
  }
}

bool IsListedVersion(
    winrt::Windows::Data::Json::JsonObject const &bundleInfoObject,
    std::wstring const &candidate) noexcept {
  if (candidate.empty()) {
    return false;
  }

  try {
    auto versionsValue = bundleInfoObject.GetNamedValue(L"versions", nullptr);
    if (!versionsValue ||
        versionsValue.ValueType() != winrt::Windows::Data::Json::JsonValueType::Array) {
      return true;
    }

    auto versionsArray = versionsValue.GetArray();
    auto sawListedVersion = false;
    for (auto const &value : versionsArray) {
      if (value.ValueType() != winrt::Windows::Data::Json::JsonValueType::String) {
        continue;
      }

      auto listedVersion = std::wstring(value.GetString());
      if (listedVersion.empty()) {
        continue;
      }

      sawListedVersion = true;
      if (listedVersion == candidate) {
        return true;
      }
    }

    return false;
  } catch (...) {
    return false;
  }
}

std::optional<int32_t> ComputeRolloutBucket(
    std::wstring const &bundleId,
    std::wstring const &deviceId) noexcept {
  try {
    auto hashInput = ToUtf8(bundleId) + ":" + ToUtf8(deviceId);
    auto hashHex = ComputeSha256HexForString(hashInput);
    if (!hashHex || hashHex->size() < 8) {
      return std::nullopt;
    }

    auto bucketSeed = std::stoul(hashHex->substr(0, 8), nullptr, 16);
    return static_cast<int32_t>(bucketSeed % 100);
  } catch (...) {
    return std::nullopt;
  }
}

bool VerifyBundleChecksum(
    winrt::Windows::Data::Json::JsonObject const &manifestObject,
    std::filesystem::path const &bundlePath) {
  auto checksumObject = manifestObject.GetNamedObject(L"checksum", nullptr);
  if (!checksumObject) {
    AppendLog("OTA.Native.Checksum.Skip reason=manifest-missing-checksum");
    return true;
  }

  std::wstring algorithm = checksumObject.GetNamedString(L"algorithm", L"").c_str();
  std::wstring expectedValue = checksumObject.GetNamedString(L"value", L"").c_str();
  if (algorithm.empty() || expectedValue.empty()) {
    AppendLog("OTA.Native.Checksum.Failed reason=invalid-checksum-metadata");
    return false;
  }

  std::transform(
      algorithm.begin(),
      algorithm.end(),
      algorithm.begin(),
      [](wchar_t ch) { return static_cast<wchar_t>(std::towlower(ch)); });
  if (algorithm != L"sha256") {
    AppendLog("OTA.Native.Checksum.Failed reason=unsupported-algorithm value=" + ToUtf8(algorithm));
    return false;
  }

  auto computedValue = ComputeSha256Hex(bundlePath);
  if (!computedValue) {
    AppendLog("OTA.Native.Checksum.Failed reason=compute-error path=" + ToUtf8(bundlePath.wstring()));
    return false;
  }

  auto expectedUtf8 = ToUtf8(expectedValue);
  std::transform(
      expectedUtf8.begin(),
      expectedUtf8.end(),
      expectedUtf8.begin(),
      [](unsigned char ch) { return static_cast<char>(std::tolower(ch)); });
  if (*computedValue != expectedUtf8) {
    AppendLog(
        "OTA.Native.Checksum.Failed reason=mismatch expected=" + expectedUtf8 +
        " computed=" + *computedValue);
    return false;
  }

  AppendLog("OTA.Native.Checksum.OK value=" + *computedValue);
  return true;
}

bool ReplaceDirectoryWithCopy(
    std::filesystem::path const &sourceDirectory,
    std::filesystem::path const &targetDirectory,
    std::optional<std::wstring> const &sourceKindOverride = std::nullopt,
    bool preserveExistingNestedBundles = false) {
  std::filesystem::path tempDirectory;
  try {
    auto parentDirectory = targetDirectory.parent_path();
    auto tempSuffix = std::to_wstring(GetTickCount64());
    tempDirectory =
        parentDirectory /
        (targetDirectory.filename().wstring() + L".__ota_tmp__" + tempSuffix);

    std::filesystem::create_directories(parentDirectory);
    std::error_code ignoredError;
    std::filesystem::remove_all(tempDirectory, ignoredError);
    std::filesystem::copy(
        sourceDirectory,
        tempDirectory,
        std::filesystem::copy_options::recursive |
            std::filesystem::copy_options::overwrite_existing);
    if (sourceKindOverride && !sourceKindOverride->empty()) {
      auto stagedManifestPath = tempDirectory / L"bundle-manifest.json";
      auto stagedManifestObject = ReadJsonFile(stagedManifestPath);
      if (!stagedManifestObject) {
        AppendLog("OTA.Native.ManifestPatchFailed reason=parse");
        return false;
      }

      InsertStringField(*stagedManifestObject, L"sourceKind", *sourceKindOverride);
      if (!WriteJsonFile(stagedManifestPath, *stagedManifestObject)) {
        AppendLog("OTA.Native.ManifestPatchFailed reason=write");
        return false;
      }
      AppendLog("OTA.Native.ManifestPatch.OK sourceKind=" + ToUtf8(*sourceKindOverride));
    }
    if (preserveExistingNestedBundles) {
      auto existingBundlesDirectory = targetDirectory / L"bundles";
      auto stagedBundlesDirectory = tempDirectory / L"bundles";
      if (!std::filesystem::exists(stagedBundlesDirectory) &&
          std::filesystem::exists(existingBundlesDirectory)) {
        std::filesystem::copy(
            existingBundlesDirectory,
            stagedBundlesDirectory,
            std::filesystem::copy_options::recursive |
                std::filesystem::copy_options::overwrite_existing);
        AppendLog(
            "OTA.Native.PreservedNestedBundles source=" +
            ToUtf8(existingBundlesDirectory.wstring()));
      }
    }
    std::filesystem::remove_all(targetDirectory, ignoredError);
    std::filesystem::rename(tempDirectory, targetDirectory);
    return true;
  } catch (...) {
    std::error_code ignoredError;
    if (!tempDirectory.empty()) {
      std::filesystem::remove_all(tempDirectory, ignoredError);
    }
    return false;
  }
}

void WriteOtaLastRun(
    std::filesystem::path const &cacheRoot,
    std::wstring const &remoteUrl,
    std::wstring const &status,
    std::optional<std::wstring> const &bundleId,
    std::optional<std::wstring> const &channel,
    std::optional<std::wstring> const &currentVersion,
    std::optional<std::wstring> const &latestVersion,
    std::optional<std::wstring> const &version,
    std::optional<std::wstring> const &previousVersion,
    std::optional<std::wstring> const &stagedAt,
    std::optional<std::wstring> const &deviceId = std::nullopt,
    std::optional<bool> inRollout = std::nullopt,
    std::optional<int32_t> rolloutPercent = std::nullopt) {
  winrt::Windows::Data::Json::JsonObject lastRunObject;
  InsertStringField(lastRunObject, L"mode", L"update");
  InsertStringField(lastRunObject, L"remoteBase", remoteUrl);
  InsertStringField(lastRunObject, L"status", status);
  InsertOptionalStringField(lastRunObject, L"bundleId", bundleId);
  InsertOptionalStringField(lastRunObject, L"channel", channel);
  InsertOptionalStringField(lastRunObject, L"currentVersion", currentVersion);
  InsertOptionalStringField(lastRunObject, L"latestVersion", latestVersion);
  InsertOptionalStringField(lastRunObject, L"version", version);
  InsertOptionalStringField(lastRunObject, L"previousVersion", previousVersion);
  InsertOptionalStringField(lastRunObject, L"stagedAt", stagedAt);
  InsertOptionalStringField(lastRunObject, L"deviceId", deviceId);
  if (inRollout.has_value()) {
    lastRunObject.Insert(L"inRollout", winrt::Windows::Data::Json::JsonValue::CreateBooleanValue(*inRollout));
  } else {
    lastRunObject.Insert(L"inRollout", winrt::Windows::Data::Json::JsonValue::CreateNullValue());
  }
  if (rolloutPercent.has_value()) {
    lastRunObject.Insert(
        L"rolloutPercent",
        winrt::Windows::Data::Json::JsonValue::CreateNumberValue(*rolloutPercent));
  } else {
    lastRunObject.Insert(L"rolloutPercent", winrt::Windows::Data::Json::JsonValue::CreateNullValue());
  }
  InsertStringField(lastRunObject, L"recordedAt", NowIso8601Utc());
  WriteJsonFile(cacheRoot / L"last-run.json", lastRunObject);
}

void RunNativeOtaUpdate(
    std::wstring appDirectory,
    std::wstring remoteUrl,
    std::wstring hostBundleDir,
    std::optional<std::wstring> currentVersion,
    std::optional<std::wstring> channel,
    bool forceUpdate) noexcept {
  auto normalizedRemoteUrl = TrimTrailingSlashes(remoteUrl);
  auto resolvedChannel = std::wstring(L"stable");
  auto cacheRoot = ResolveOtaCacheRoot(appDirectory);
  std::optional<std::wstring> resolvedDeviceIdForLastRun;
  std::optional<bool> inRolloutForLastRun;
  std::optional<int32_t> rolloutPercentForLastRun;

  try {
    winrt::init_apartment(winrt::apartment_type::multi_threaded);

    std::filesystem::create_directories(cacheRoot);
    resolvedChannel = ResolveOtaChannel(cacheRoot, channel);
    AppendLog("OTA.Native.Start remoteUrl=" + ToUtf8(normalizedRemoteUrl));
    AppendLog("OTA.Native.CacheRoot path=" + ToUtf8(cacheRoot.wstring()));
    AppendLog("OTA.Native.Channel value=" + ToUtf8(resolvedChannel));

    auto indexUrl = normalizedRemoteUrl + L"/index.json";
    auto indexPath = cacheRoot / L"index.json";
    if (!DownloadUrlToFile(indexUrl, indexPath, "OTA.Native.DownloadIndex")) {
      WriteOtaLastRun(
          cacheRoot,
          normalizedRemoteUrl,
          L"failed",
          std::nullopt,
          resolvedChannel,
          currentVersion,
          std::nullopt,
          std::nullopt,
          std::nullopt,
          std::nullopt);
      return;
    }

    auto indexObject = ReadJsonFile(indexPath);
    if (!indexObject) {
      AppendLog("OTA.Native.IndexParseFailed path=" + ToUtf8(indexPath.wstring()));
      WriteOtaLastRun(
          cacheRoot,
          normalizedRemoteUrl,
          L"failed",
          std::nullopt,
          resolvedChannel,
          currentVersion,
          std::nullopt,
          std::nullopt,
          std::nullopt,
          std::nullopt);
      return;
    }

    auto bundlesObject = indexObject->GetNamedObject(L"bundles", nullptr);
    if (!bundlesObject) {
      AppendLog("OTA.Native.IndexMissingBundles");
      WriteOtaLastRun(
          cacheRoot,
          normalizedRemoteUrl,
          L"failed",
          std::nullopt,
          resolvedChannel,
          currentVersion,
          std::nullopt,
          std::nullopt,
          std::nullopt,
          std::nullopt);
      return;
    }

    std::vector<std::wstring> indexedBundleIds;
    for (auto const &entry : bundlesObject) {
      indexedBundleIds.emplace_back(entry.Key().c_str());
    }

    auto localBundleId = ReadBundleManifestBundleId(hostBundleDir);
    std::optional<std::wstring> resolvedBundleId;
    if (localBundleId && bundlesObject.HasKey(winrt::hstring(*localBundleId))) {
      resolvedBundleId = *localBundleId;
    } else if (indexedBundleIds.size() == 1) {
      resolvedBundleId = indexedBundleIds.front();
    }

    if (!resolvedBundleId) {
      AppendLog("OTA.Native.BundleResolutionFailed localBundleId=" + (localBundleId ? ToUtf8(*localBundleId) : "null"));
      WriteOtaLastRun(
          cacheRoot,
          normalizedRemoteUrl,
          L"failed",
          std::nullopt,
          resolvedChannel,
          currentVersion,
          std::nullopt,
          std::nullopt,
          std::nullopt,
          std::nullopt);
      return;
    }

    auto bundleInfoObject = bundlesObject.GetNamedObject(winrt::hstring(*resolvedBundleId), nullptr);
    if (!bundleInfoObject) {
      AppendLog("OTA.Native.BundleInfoMissing bundleId=" + ToUtf8(*resolvedBundleId));
      WriteOtaLastRun(
          cacheRoot,
          normalizedRemoteUrl,
          L"failed",
          resolvedBundleId,
          resolvedChannel,
          currentVersion,
          std::nullopt,
          std::nullopt,
          std::nullopt,
          std::nullopt);
      return;
    }

    auto latestVersionFromVersions = ResolveLatestVersionFromVersions(bundleInfoObject);
    std::wstring latestVersion;
    std::string latestVersionSource;
    auto tryUseLatestVersion = [&](std::wstring const &candidate, std::string const &source) {
      if (candidate.empty()) {
        return false;
      }
      if (!IsListedVersion(bundleInfoObject, candidate)) {
        AppendLog(
            "OTA.Native.LatestVersionIgnored source=" + source +
            " value=" + ToUtf8(candidate) +
            " reason=missing-from-versions");
        return false;
      }
      latestVersion = candidate;
      latestVersionSource = source;
      return true;
    };

    if (latestVersionFromVersions) {
      latestVersion = *latestVersionFromVersions;
      latestVersionSource = "versions";
    } else {
      tryUseLatestVersion(
          bundleInfoObject.GetNamedString(L"latestVersion", L"").c_str(),
          "latestVersion");
    }

    if (auto channelsObject = bundleInfoObject.GetNamedObject(L"channels", nullptr)) {
      std::wstring channelVersion =
          channelsObject.GetNamedString(winrt::hstring(resolvedChannel), L"").c_str();
      if (!tryUseLatestVersion(channelVersion, "channels:" + ToUtf8(resolvedChannel)) &&
          resolvedChannel != L"stable") {
        std::wstring stableVersion =
            channelsObject.GetNamedString(L"stable", L"").c_str();
        tryUseLatestVersion(stableVersion, "channels:stable");
      }
    }

    if (latestVersion.empty()) {
      AppendLog("OTA.Native.LatestVersionMissing bundleId=" + ToUtf8(*resolvedBundleId));
      WriteOtaLastRun(
          cacheRoot,
          normalizedRemoteUrl,
          L"failed",
          resolvedBundleId,
          resolvedChannel,
          currentVersion,
          std::nullopt,
          std::nullopt,
          std::nullopt,
          std::nullopt);
      return;
    }
    AppendLog(
        "OTA.Native.LatestVersion source=" + latestVersionSource +
        " value=" + ToUtf8(latestVersion));

    auto resolvedDeviceId = GetOrCreateOtaDeviceId(cacheRoot);
    if (!resolvedDeviceId) {
      AppendLog("OTA.Native.DeviceIdResolutionFailed");
      WriteOtaLastRun(
          cacheRoot,
          normalizedRemoteUrl,
          L"failed",
          resolvedBundleId,
          resolvedChannel,
          currentVersion,
          latestVersion,
          std::nullopt,
          std::nullopt,
          std::nullopt);
      return;
    }
    AppendLog("OTA.Native.DeviceId value=" + ToUtf8(*resolvedDeviceId));
    resolvedDeviceIdForLastRun = resolvedDeviceId;

    auto rolloutPercent = ParseRolloutPercent(bundleInfoObject);
    auto inRollout = true;
    if (rolloutPercent && *rolloutPercent < 100) {
      auto rolloutBucket = ComputeRolloutBucket(*resolvedBundleId, *resolvedDeviceId);
      if (!rolloutBucket) {
        AppendLog("OTA.Native.RolloutBucketFailed");
        WriteOtaLastRun(
            cacheRoot,
            normalizedRemoteUrl,
            L"failed",
            resolvedBundleId,
            resolvedChannel,
            currentVersion,
            latestVersion,
            std::nullopt,
            std::nullopt,
            std::nullopt);
        return;
      }
      inRollout = *rolloutBucket < *rolloutPercent;
      AppendLog(
          "OTA.Native.Rollout percent=" + std::to_string(*rolloutPercent) +
          " bucket=" + std::to_string(*rolloutBucket) +
          " inRollout=" + (inRollout ? std::string("true") : std::string("false")));
    } else if (rolloutPercent) {
      AppendLog(
          "OTA.Native.Rollout percent=" + std::to_string(*rolloutPercent) +
          " inRollout=true");
    } else {
      AppendLog("OTA.Native.Rollout percent=100 inRollout=true");
    }
    inRolloutForLastRun = inRollout;
    rolloutPercentForLastRun = rolloutPercent;

    auto shouldUpdate = inRollout && forceUpdate;
    if (!shouldUpdate && inRollout) {
      shouldUpdate = !currentVersion || latestVersion > *currentVersion;
    }

    if (!shouldUpdate) {
      auto reason = inRollout ? "version" : "rollout";
      AppendLog(
          "OTA.Native.UpToDate reason=" + std::string(reason) +
          " bundleId=" + ToUtf8(*resolvedBundleId) +
          " version=" + ToUtf8(latestVersion));
      WriteOtaLastRun(
          cacheRoot,
          normalizedRemoteUrl,
          L"up-to-date",
          resolvedBundleId,
          resolvedChannel,
          currentVersion,
          latestVersion,
          latestVersion,
          std::nullopt,
          std::nullopt,
          resolvedDeviceId,
          inRollout,
          rolloutPercent);
      return;
    }

    auto artifactBaseUrl =
        normalizedRemoteUrl + L"/" + *resolvedBundleId + L"/" + latestVersion + L"/windows";
    auto manifestPath = cacheRoot / *resolvedBundleId / latestVersion / L"windows" / L"bundle-manifest.json";
    if (!DownloadUrlToFile(
            artifactBaseUrl + L"/bundle-manifest.json",
            manifestPath,
            "OTA.Native.DownloadManifest")) {
      WriteOtaLastRun(
          cacheRoot,
          normalizedRemoteUrl,
          L"failed",
          resolvedBundleId,
          resolvedChannel,
          currentVersion,
          latestVersion,
          std::nullopt,
          std::nullopt,
          std::nullopt,
          resolvedDeviceId,
          inRollout,
          rolloutPercent);
      return;
    }

    auto manifestObject = ReadJsonFile(manifestPath);
    if (!manifestObject) {
      AppendLog("OTA.Native.ManifestParseFailed path=" + ToUtf8(manifestPath.wstring()));
      WriteOtaLastRun(
          cacheRoot,
          normalizedRemoteUrl,
          L"failed",
          resolvedBundleId,
          resolvedChannel,
          currentVersion,
          latestVersion,
          std::nullopt,
          std::nullopt,
          std::nullopt,
          resolvedDeviceId,
          inRollout,
          rolloutPercent);
      return;
    }

    std::wstring entryFileName =
        manifestObject->GetNamedString(L"entryFile", L"").c_str();
    if (entryFileName.empty()) {
      AppendLog("OTA.Native.ManifestMissingEntryFile");
      WriteOtaLastRun(
          cacheRoot,
          normalizedRemoteUrl,
          L"failed",
          resolvedBundleId,
          resolvedChannel,
          currentVersion,
          latestVersion,
          std::nullopt,
          std::nullopt,
          std::nullopt,
          resolvedDeviceId,
          inRollout,
          rolloutPercent);
      return;
    }

    auto stagedDirectory = manifestPath.parent_path();
    auto entryFilePath = stagedDirectory / entryFileName;
    if (!DownloadUrlToFile(
            artifactBaseUrl + L"/" + entryFileName,
            entryFilePath,
            "OTA.Native.DownloadEntryFile")) {
      WriteOtaLastRun(
          cacheRoot,
          normalizedRemoteUrl,
          L"failed",
          resolvedBundleId,
          resolvedChannel,
          currentVersion,
          latestVersion,
          std::nullopt,
          std::nullopt,
          std::nullopt,
          resolvedDeviceId,
          inRollout,
          rolloutPercent);
      return;
    }

    if (!VerifyBundleChecksum(*manifestObject, entryFilePath)) {
      WriteOtaLastRun(
          cacheRoot,
          normalizedRemoteUrl,
          L"failed",
          resolvedBundleId,
          resolvedChannel,
          currentVersion,
          latestVersion,
          std::nullopt,
          std::nullopt,
          std::nullopt,
          resolvedDeviceId,
          inRollout,
          rolloutPercent);
      return;
    }

    DownloadUrlToFile(
        artifactBaseUrl + L"/window-policy-registry.json",
        stagedDirectory / L"window-policy-registry.json",
        "OTA.Native.DownloadPolicyRegistry",
        false);

    std::optional<std::wstring> previousSnapshotVersion =
        ReadBundleManifestVersion(hostBundleDir);
    std::optional<std::filesystem::path> previousSnapshotDir;
    std::optional<std::wstring> previousSnapshotAt;
    if (previousSnapshotVersion) {
      auto snapshotDir =
          cacheRoot / *resolvedBundleId / L"previous" / L"windows";
      if (!ReplaceDirectoryWithCopy(std::filesystem::path(hostBundleDir), snapshotDir)) {
        AppendLog("OTA.Native.SnapshotFailed snapshotDir=" + ToUtf8(snapshotDir.wstring()));
        WriteOtaLastRun(
            cacheRoot,
            normalizedRemoteUrl,
            L"failed",
            resolvedBundleId,
            resolvedChannel,
            currentVersion,
            latestVersion,
            std::nullopt,
            std::nullopt,
            std::nullopt,
            resolvedDeviceId,
            inRollout,
            rolloutPercent);
        return;
      }
      previousSnapshotDir = snapshotDir;
      previousSnapshotAt = NowIso8601Utc();
      AppendLog(
          "OTA.Native.Snapshot.OK version=" + ToUtf8(*previousSnapshotVersion) +
          " snapshotDir=" + ToUtf8(snapshotDir.wstring()));
    } else {
      AppendLog("OTA.Native.SnapshotSkipped reason=manifest-unavailable");
    }

    if (!ReplaceDirectoryWithCopy(
            stagedDirectory,
            std::filesystem::path(hostBundleDir),
            std::wstring(L"sibling-staging"),
            *resolvedBundleId == L"opapp.companion.main")) {
      AppendLog("OTA.Native.ApplyFailed hostBundleDir=" + ToUtf8(hostBundleDir));
      WriteOtaLastRun(
          cacheRoot,
          normalizedRemoteUrl,
          L"failed",
          resolvedBundleId,
          resolvedChannel,
          currentVersion,
          latestVersion,
          std::nullopt,
          std::nullopt,
          std::nullopt,
          resolvedDeviceId,
          inRollout,
          rolloutPercent);
      return;
    }

    auto nowIso = NowIso8601Utc();
    winrt::Windows::Data::Json::JsonObject otaStateObject;
    InsertStringField(otaStateObject, L"bundleId", *resolvedBundleId);
    InsertStringField(otaStateObject, L"version", latestVersion);
    InsertStringField(otaStateObject, L"platform", L"windows");
    InsertStringField(otaStateObject, L"manifestDir", stagedDirectory.wstring());
    InsertStringField(otaStateObject, L"downloadedAt", nowIso);
    InsertStringField(otaStateObject, L"stagedAt", nowIso);
    InsertStringField(otaStateObject, L"hostBundleDir", hostBundleDir);
    if (previousSnapshotDir && previousSnapshotAt) {
      winrt::Windows::Data::Json::JsonObject previousSnapshotObject;
      if (previousSnapshotVersion && !previousSnapshotVersion->empty()) {
        InsertStringField(previousSnapshotObject, L"version", *previousSnapshotVersion);
      } else {
        previousSnapshotObject.Insert(
            L"version",
            winrt::Windows::Data::Json::JsonValue::CreateNullValue());
      }
      InsertStringField(previousSnapshotObject, L"snapshotDir", previousSnapshotDir->wstring());
      InsertStringField(previousSnapshotObject, L"snapshotAt", *previousSnapshotAt);
      otaStateObject.Insert(
          L"previousSnapshot",
          winrt::Windows::Data::Json::JsonValue::Parse(previousSnapshotObject.Stringify()));
    }
    WriteJsonFile(cacheRoot / L"ota-state.json", otaStateObject);

    auto previousVersionForLastRun = previousSnapshotVersion ? previousSnapshotVersion : currentVersion;
    WriteOtaLastRun(
        cacheRoot,
        normalizedRemoteUrl,
        L"updated",
        resolvedBundleId,
        resolvedChannel,
        currentVersion,
        latestVersion,
        latestVersion,
        previousVersionForLastRun,
        nowIso,
        resolvedDeviceId,
        inRollout,
        rolloutPercent);
    AppendLog(
        "OTA.Native.Updated bundleId=" + ToUtf8(*resolvedBundleId) +
        " version=" + ToUtf8(latestVersion));
  } catch (winrt::hresult_error const &error) {
    AppendLog(
        "OTA.Native.HResultError code=" + std::to_string(static_cast<int32_t>(error.code().value)) +
        " message=" + ToUtf8(error.message()));
    WriteOtaLastRun(
        cacheRoot,
        normalizedRemoteUrl,
        L"failed",
        std::nullopt,
        resolvedChannel,
        currentVersion,
        std::nullopt,
        std::nullopt,
        std::nullopt,
        std::nullopt,
        resolvedDeviceIdForLastRun,
        inRolloutForLastRun,
        rolloutPercentForLastRun);
  } catch (std::exception const &error) {
    AppendLog(std::string("OTA.Native.StdException message=") + error.what());
    WriteOtaLastRun(
        cacheRoot,
        normalizedRemoteUrl,
        L"failed",
        std::nullopt,
        resolvedChannel,
        currentVersion,
        std::nullopt,
        std::nullopt,
        std::nullopt,
        std::nullopt,
        resolvedDeviceIdForLastRun,
        inRolloutForLastRun,
        rolloutPercentForLastRun);
  } catch (...) {
    AppendLog("OTA.Native.UnknownException");
    WriteOtaLastRun(
        cacheRoot,
        normalizedRemoteUrl,
        L"failed",
        std::nullopt,
        resolvedChannel,
        currentVersion,
        std::nullopt,
        std::nullopt,
        std::nullopt,
        std::nullopt,
        resolvedDeviceIdForLastRun,
        inRolloutForLastRun,
        rolloutPercentForLastRun);
  }
}

// Spawns the native OTA updater worker in a detached background thread.
//
// WinMain does not wait for the worker thread to exit. The staged bundle takes
// effect on the next application launch (RFC-010 Phase 2).
void SpawnOtaUpdateProcess(
    std::wstring const &appDirectory,
    std::wstring const &remoteUrl,
    std::optional<std::wstring> const &hostBundleDir,
    std::optional<std::wstring> const &currentVersion,
    std::optional<std::wstring> const &channel,
    bool forceUpdate) noexcept {
  auto logLine = std::string("OTA.SpawnUpdateProcess remoteUrl=") + ToUtf8(remoteUrl);
  if (hostBundleDir) {
    logLine += " hostBundleDir=" + ToUtf8(*hostBundleDir);
  }
  if (currentVersion) {
    logLine += " currentVersion=" + ToUtf8(*currentVersion);
  }
  if (channel) {
    logLine += " channel=" + ToUtf8(*channel);
  }
  if (forceUpdate) {
    logLine += " force=true";
  }
  AppendLog(logLine);

  if (!hostBundleDir || hostBundleDir->empty()) {
    AppendLog("OTA.SpawnUpdateProcess.HostBundleDirMissing");
    return;
  }

  try {
    std::thread(
        [appDirectory, remoteUrl, hostBundleDir, currentVersion, channel, forceUpdate]() noexcept {
          RunNativeOtaUpdate(
              appDirectory,
              remoteUrl,
              *hostBundleDir,
              currentVersion,
              channel,
              forceUpdate);
        })
        .detach();
    AppendLog("OTA.SpawnUpdateProcess.OK mode=native-thread");
  } catch (std::exception const &error) {
    AppendLog(std::string("OTA.SpawnUpdateProcess.Failed exception=") + error.what());
  } catch (...) {
    AppendLog("OTA.SpawnUpdateProcess.Failed exception=unknown");
  }
}

// Runs `node crash-watchdog.mjs --mode=guard --platform=windows` synchronously,
// waiting up to 5 seconds for it to exit.
//
// Returns the process exit code (0 = proceed normally; 2 = rollback was
// performed).  Returns 0 on any error or timeout so launch is never blocked
// by watchdog failures (RFC-013).
int RunWatchdogGuardSync(std::wstring const &appDirectory) noexcept {
  AppendLog("Watchdog.Guard.Start");

  auto scriptPath = ResolveToolingScriptPath(appDirectory, L"crash-watchdog.mjs");
  if (!scriptPath) {
    AppendLog("Watchdog.Guard.ScriptNotFound appDirectory=" + ToUtf8(appDirectory));
    return 0;
  }

  std::wstring cmdLine =
      std::wstring(L"node.exe \"") + *scriptPath + L"\" --mode=guard --platform=windows";

  STARTUPINFOW si{};
  si.cb = sizeof(si);
  PROCESS_INFORMATION pi{};
  BOOL ok = CreateProcessW(
      nullptr,
      cmdLine.data(),
      nullptr,
      nullptr,
      FALSE,
      CREATE_NO_WINDOW,
      nullptr,
      appDirectory.c_str(),
      &si,
      &pi);

  if (!ok) {
    AppendLog("Watchdog.Guard.Failed error=" + std::to_string(GetLastError()));
    return 0;
  }

  CloseHandle(pi.hThread);

  // Wait up to 5 seconds; proceed normally on timeout.
  DWORD waitResult = WaitForSingleObject(pi.hProcess, 5000);
  int exitCode = 0;
  if (waitResult == WAIT_OBJECT_0) {
    DWORD code = 0;
    GetExitCodeProcess(pi.hProcess, &code);
    exitCode = static_cast<int>(code);
    AppendLog("Watchdog.Guard.Done exitCode=" + std::to_string(exitCode));
  } else {
    AppendLog("Watchdog.Guard.Timeout");
    TerminateProcess(pi.hProcess, 1);
  }

  CloseHandle(pi.hProcess);
  return exitCode;
}

// Spawns `node crash-watchdog.mjs --mode=heartbeat` as a detached background
// process.  Called from the InstanceLoaded callback after a successful JS
// bundle load.  Failure is silently ignored (RFC-013).
void SpawnWatchdogHeartbeat(std::wstring const &appDirectory) noexcept {
  AppendLog("Watchdog.Heartbeat.Spawn");

  auto scriptPath = ResolveToolingScriptPath(appDirectory, L"crash-watchdog.mjs");
  if (!scriptPath) {
    AppendLog("Watchdog.Heartbeat.ScriptNotFound");
    return;
  }

  std::wstring cmdLine = std::wstring(L"node.exe \"") + *scriptPath + L"\" --mode=heartbeat";

  STARTUPINFOW si{};
  si.cb = sizeof(si);
  PROCESS_INFORMATION pi{};
  BOOL ok = CreateProcessW(
      nullptr,
      cmdLine.data(),
      nullptr,
      nullptr,
      FALSE,
      CREATE_NO_WINDOW | DETACHED_PROCESS,
      nullptr,
      appDirectory.c_str(),
      &si,
      &pi);

  if (ok) {
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    AppendLog("Watchdog.Heartbeat.OK");
  } else {
    AppendLog("Watchdog.Heartbeat.Failed error=" + std::to_string(GetLastError()));
  }
}

} // namespace

// A PackageProvider containing any turbo modules you define within this app project
struct CompReactPackageProvider
    : winrt::implements<CompReactPackageProvider, winrt::Microsoft::ReactNative::IReactPackageProvider> {
 public: // IReactPackageProvider
  void CreatePackage(winrt::Microsoft::ReactNative::IReactPackageBuilder const &packageBuilder) noexcept {
    AddAttributedModules(packageBuilder, true);
  }
};

// The entry point of the Win32 application
_Use_decl_annotations_ int CALLBACK WinMain(HINSTANCE /*instance*/, HINSTANCE, PSTR /*commandLine*/, int /*showCmd*/) {
  try {
    ResetLog();
    AppendLog("WinMain.Start");

    winrt::init_apartment(winrt::apartment_type::single_threaded);
    SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);

    WCHAR appDirectory[MAX_PATH];
    GetModuleFileNameW(NULL, appDirectory, MAX_PATH);
    PathCchRemoveFileSpec(appDirectory, MAX_PATH);

    // RFC-013: Run the crash watchdog guard synchronously before loading any
    // bundle.  If it exits with code 2 a rollback was performed; the current
    // launch will use the now-restored bundle.  Any failure is silent (0).
    {
      auto watchdogExitCode = RunWatchdogGuardSync(std::wstring(appDirectory));
      if (watchdogExitCode == 2) {
        AppendLog("Watchdog.RollbackPerformed bundleWillReflectRollback=true");
      }
    }

#if BUNDLE
    if (!InitializeWindowPolicyRegistry(appDirectory, true)) {
      AppendLog("FatalWindowPolicyRegistryLoadFailure");
      return -1;
    }
#else
    InitializeWindowPolicyRegistry(appDirectory, false);
#endif

    auto windowsAppRuntimeBootstrap = InitializeWindowsAppRuntimeBootstrap();

    auto launchSurface = GetInitialLaunchSurface();
    AppendLog(
        "LaunchSurface surface=" + ToUtf8(launchSurface.SurfaceId) + " policy=" +
        ToUtf8(launchSurface.Policy) + " mode=" + ToUtf8(launchSurface.MetricsMode));

    AppendLog("WinMain.BuildReactNativeApp");
    auto reactNativeWin32App{winrt::Microsoft::ReactNative::ReactNativeAppBuilder().Build()};
    AppendLog("WinMain.BuildReactNativeApp.Done");
    auto reactNativeHost = reactNativeWin32App.ReactNativeHost();
    InitializeWindowManager(
        reactNativeHost,
        std::wstring(appDirectory),
#if BUNDLE
        true
#else
        false
#endif
    );
    AppendLog("WinMain.WindowManagerInitialized");

    auto settings{reactNativeHost.InstanceSettings()};
    auto startupSecondarySurface = GetSecondaryStartupSurface();
    auto restoredSecondarySurfaces = LoadRestorableSecondarySurfaces(startupSecondarySurface);
    auto startupInitialOpenSurface = GetInitialAutoOpenSurface();

    // Capture the app directory for use in the InstanceLoaded heartbeat callback.
    std::wstring const appDir(appDirectory);

    settings.EnableDefaultCrashHandler(true);
    settings.NativeLogger([](winrt::Microsoft::ReactNative::LogLevel level, winrt::hstring const &message) {
      AppendLog(
          std::string("NativeLogger[") + std::to_string(static_cast<int>(level)) + "] " + ToUtf8(message));
    });
    settings.InstanceLoaded([settings, startupSecondarySurface, restoredSecondarySurfaces, appDir](
                                auto const &,
                                winrt::Microsoft::ReactNative::InstanceLoadedEventArgs const &args) {
      AppendLog(std::string("InstanceLoaded failed=") + BoolString(args.Failed()));

      if (args.Failed()) {
        return;
      }

      // RFC-013: JS bundle loaded successfully — send watchdog heartbeat to
      // reset the crash counter and clear the in-progress marker.
      SpawnWatchdogHeartbeat(appDir);

      if (startupSecondarySurface) {
        if (auto error = QueueManagedWindowOpen(settings.UIDispatcher(), *startupSecondarySurface)) {
          AppendLog(
              "SecondaryStartupSurfaceFailed surface=" + ToUtf8(startupSecondarySurface->SurfaceId) + " reason=" +
              *error);
        }
      }

      for (auto const &restoredSecondarySurface : restoredSecondarySurfaces) {
        if (auto error = QueueManagedWindowOpen(settings.UIDispatcher(), restoredSecondarySurface)) {
          AppendLog(
              "RestoredSecondaryWindowFailed window=" + ToUtf8(restoredSecondarySurface.WindowId) + " surface=" +
              ToUtf8(restoredSecondarySurface.SurfaceId) + " reason=" + *error);
        }
      }
    });
    settings.RedBoxHandler(winrt::make<LoggingRedBoxHandler>(
        winrt::Microsoft::ReactNative::RedBoxHelper::CreateDefaultHandler(reactNativeHost)));

    RegisterAutolinkedNativeModulePackages(settings.PackageProviders());
    settings.PackageProviders().Append(winrt::make<CompReactPackageProvider>());

#if BUNDLE
    auto bundleRootPath = std::wstring(appDirectory).append(L"\\Bundle");
    settings.BundleRootPath(bundleRootPath.c_str());

    std::wstring jsBundleFile = L"index.windows";
    if (auto entryFile = ReadBundleManifestEntryFile(bundleRootPath)) {
      jsBundleFile = *entryFile;
      AppendLog("BundleManifestSource=manifest entryFile=" + ToUtf8(jsBundleFile));
    } else {
      AppendLog("BundleManifestSource=hardcoded-fallback entryFile=" + ToUtf8(jsBundleFile));
    }

    settings.JavaScriptBundleFile(jsBundleFile.c_str());
    settings.UseFastRefresh(false);
    AppendLog(
        std::string("Runtime=Bundle root=") + ToUtf8(settings.BundleRootPath()) + " file=" +
        ToUtf8(settings.JavaScriptBundleFile()));
#else
    settings.JavaScriptBundleFile(L"index");
    settings.UseFastRefresh(true);
    AppendLog("Runtime=Metro");
#endif
#if _DEBUG
    settings.UseDirectDebugger(true);
    settings.UseDeveloperSupport(true);
    AppendLog("DeveloperSupport=Enabled");
#else
    settings.UseDirectDebugger(false);
    settings.UseDeveloperSupport(false);
    AppendLog("DeveloperSupport=Disabled");
#endif

    AppendLog("WinMain.ConfigureInitialWindow");
    ConfigureInitialWindow(reactNativeWin32App, launchSurface);
    AppendLog("WinMain.ConfigureInitialWindow.Done");

    if (startupInitialOpenSurface) {
      AppendLog(
          "InitialOpenSurface surface=" + ToUtf8(startupInitialOpenSurface->SurfaceId) + " policy=" +
          ToUtf8(startupInitialOpenSurface->Policy) + " presentation=" +
          ToUtf8(startupInitialOpenSurface->Presentation));
    }

    if (startupSecondarySurface) {
      AppendLog(
          "SecondaryStartupSurface surface=" + ToUtf8(startupSecondarySurface->SurfaceId) + " policy=" +
          ToUtf8(startupSecondarySurface->Policy) + " mode=" + ToUtf8(startupSecondarySurface->MetricsMode));
    }

    auto viewOptions{reactNativeWin32App.ReactViewOptions()};
    viewOptions.ComponentName(L"OpappWindowsHost");
    viewOptions.InitialProps(CreateLaunchProps(launchSurface, startupInitialOpenSurface));

    // RFC-010 Phase 2: spawn OTA bundle update process in the background if a
    // remote registry URL is configured via [ota] remote= (launch INI) or the
    // OPAPP_OTA_REMOTE_URL environment variable.  The subprocess runs silently
    // (CREATE_NO_WINDOW | DETACHED_PROCESS) and exits on its own; the staged
    // bundle takes effect on the next application launch.
    if (auto otaRemoteUrl = GetOtaRemoteUrl()) {
      std::optional<std::wstring> hostBundleDir;
      std::optional<std::wstring> currentBundleVersion;
#if BUNDLE
      hostBundleDir = std::wstring(appDirectory).append(L"\\Bundle");
      currentBundleVersion = ReadBundleManifestVersion(*hostBundleDir);
#endif
      SpawnOtaUpdateProcess(
          std::wstring(appDirectory),
          *otaRemoteUrl,
          hostBundleDir,
          currentBundleVersion,
          GetOtaChannel(),
          GetOtaForceUpdate());
    }

    AppendLog("WinMain.StartReactNativeApp");
    reactNativeWin32App.Start();
    AppendLog("WinMain.StartReactNativeApp.Done");
    return 0;
  } catch (winrt::hresult_error const &error) {
    AppendLog(
        "WinMain.HResultError code=" + std::to_string(static_cast<int32_t>(error.code().value)) +
        " message=" + ToUtf8(error.message()));
    return -1;
  } catch (std::exception const &error) {
    AppendLog(std::string("WinMain.StdException message=") + error.what());
    return -1;
  } catch (...) {
    AppendLog("WinMain.UnknownException");
    return -1;
  }
}




