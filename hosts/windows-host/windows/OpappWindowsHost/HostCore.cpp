#include "pch.h"
#include "HostCore.h"

#include <appmodel.h>
#include <winrt/Windows.Storage.h>

#include <atomic>
#include <deque>
#include <fstream>
#include <sstream>

namespace OpappWindowsHost {

std::string ToUtf8(winrt::hstring const &value);
std::string ToUtf8(std::wstring const &value);

namespace {

constexpr unsigned long long kMaxLogBytes = 2ull * 1024ull * 1024ull;
constexpr auto kHostLogFileName = "opapp-windows-host.log";

bool HasPackageIdentity() noexcept {
  UINT32 packageFullNameLength = 0;
  auto result = GetCurrentPackageFullName(&packageFullNameLength, nullptr);
  return result != APPMODEL_ERROR_NO_PACKAGE;
}

std::string GetDefaultHostLogPath() noexcept {
  char tempPath[MAX_PATH] = {};
  auto length = GetTempPathA(MAX_PATH, tempPath);
  if (length == 0 || length > MAX_PATH) {
    return kHostLogFileName;
  }

  return std::string(tempPath) + kHostLogFileName;
}

std::optional<std::string> GetPackageLocalCacheHostLogPath() noexcept {
  if (!HasPackageIdentity()) {
    return std::nullopt;
  }

  try {
    auto localCachePath = winrt::Windows::Storage::ApplicationData::Current().LocalCacheFolder().Path();
    if (localCachePath.empty()) {
      return std::nullopt;
    }

    return ToUtf8(localCachePath) + "\\" + kHostLogFileName;
  } catch (...) {
    return std::nullopt;
  }
}

bool CanOpenLogPath(std::string const &logPath) noexcept {
  HANDLE file = CreateFileA(
      logPath.c_str(),
      FILE_APPEND_DATA,
      FILE_SHARE_READ | FILE_SHARE_WRITE,
      nullptr,
      OPEN_ALWAYS,
      FILE_ATTRIBUTE_NORMAL,
      nullptr);

  if (file == INVALID_HANDLE_VALUE) {
    return false;
  }

  CloseHandle(file);
  return true;
}

std::string ResolveWritableHostLogPath() noexcept {
  static const std::string resolvedPath = []() {
    auto defaultPath = GetDefaultHostLogPath();
    if (CanOpenLogPath(defaultPath)) {
      return defaultPath;
    }

    auto packagePath = GetPackageLocalCacheHostLogPath();
    if (packagePath && CanOpenLogPath(*packagePath)) {
      return *packagePath;
    }

    return defaultPath;
  }();

  return resolvedPath;
}

std::string GetPreviousLogPath() {
  return GetHostLogPath() + ".previous";
}

void RotateLogIfNeeded() noexcept {
  WIN32_FILE_ATTRIBUTE_DATA attributes{};
  auto logPath = GetHostLogPath();
  if (!GetFileAttributesExA(logPath.c_str(), GetFileExInfoStandard, &attributes)) {
    return;
  }

  ULARGE_INTEGER size{};
  size.LowPart = attributes.nFileSizeLow;
  size.HighPart = attributes.nFileSizeHigh;

  if (size.QuadPart <= kMaxLogBytes) {
    return;
  }

  auto previousLogPath = GetPreviousLogPath();
  DeleteFileA(previousLogPath.c_str());
  MoveFileExA(logPath.c_str(), previousLogPath.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_COPY_ALLOWED);
}

} // namespace

std::string ToUtf8(winrt::hstring const &value) {
  return winrt::to_string(value);
}

std::string ToUtf8(std::wstring const &value) {
  return winrt::to_string(winrt::hstring{value});
}

std::string GetHostLogPath() noexcept {
  return ResolveWritableHostLogPath();
}

winrt::hstring WindowPolicyName(WindowPolicyId policy) {
  switch (policy) {
    case WindowPolicyId::Main:
      return L"main";
    case WindowPolicyId::Settings:
      return L"settings";
    case WindowPolicyId::Tool:
      return L"tool";
  }

  return L"main";
}

std::string ToUtf8(WindowPolicyId policy) {
  return ToUtf8(WindowPolicyName(policy));
}

winrt::hstring WindowSizeModeName(WindowSizeMode mode) {
  switch (mode) {
    case WindowSizeMode::Balanced:
      return L"balanced";
    case WindowSizeMode::Compact:
      return L"compact";
    case WindowSizeMode::Wide:
      return L"wide";
  }

  return L"balanced";
}

std::string ToUtf8(WindowSizeMode mode) {
  return ToUtf8(WindowSizeModeName(mode));
}

std::optional<WindowSizeMode> ParseWindowSizeMode(std::string const &mode) {
  if (mode == "balanced") {
    return WindowSizeMode::Balanced;
  }
  if (mode == "compact") {
    return WindowSizeMode::Compact;
  }
  if (mode == "wide") {
    return WindowSizeMode::Wide;
  }

  return std::nullopt;
}

std::optional<ParsedWindowPolicy> ParseWindowPolicy(std::string const &policy) {
  if (policy == "main") {
    return ParsedWindowPolicy{WindowPolicyId::Main, std::nullopt};
  }
  if (policy == "settings") {
    return ParsedWindowPolicy{WindowPolicyId::Settings, std::nullopt};
  }
  if (policy == "tool") {
    return ParsedWindowPolicy{WindowPolicyId::Tool, std::nullopt};
  }
  if (policy == "compact") {
    return ParsedWindowPolicy{WindowPolicyId::Main, WindowSizeMode::Compact};
  }
  if (policy == "wide") {
    return ParsedWindowPolicy{WindowPolicyId::Main, WindowSizeMode::Wide};
  }

  return std::nullopt;
}

std::wstring NormalizeSettingsPresentation(std::wstring presentation) {
  if (presentation != L"current-window" && presentation != L"new-window") {
    return L"current-window";
  }

  return presentation;
}

std::wstring NormalizeStartupTargetPresentation(std::wstring presentation) {
  if (
      presentation != L"current-window" &&
      presentation != L"tab" &&
      presentation != L"new-window") {
    return L"current-window";
  }

  return presentation;
}

std::wstring NormalizeAppearancePreset(std::wstring appearancePreset) {
  if (appearancePreset != L"classic" && appearancePreset != L"blossom") {
    return L"classic";
  }

  return appearancePreset;
}

std::wstring GetWindowTitle(LaunchSurfaceConfig const &launchSurface) {
  if (launchSurface.Policy == WindowPolicyId::Settings) {
    return L"OPApp 设置";
  }

  if (launchSurface.Policy == WindowPolicyId::Tool) {
    return L"OPApp 工具";
  }

  return L"OPApp";
}

void ResetLog() noexcept {
  RotateLogIfNeeded();

  HANDLE file = CreateFileA(
      GetHostLogPath().c_str(),
      GENERIC_WRITE,
      FILE_SHARE_READ | FILE_SHARE_WRITE,
      nullptr,
      OPEN_ALWAYS,
      FILE_ATTRIBUTE_NORMAL,
      nullptr);

  if (file != INVALID_HANDLE_VALUE) {
    CloseHandle(file);
  }

  AppendLog(
      "HostSession.Start pid=" + std::to_string(GetCurrentProcessId()) +
      " logPath=" + GetHostLogPath());
}

void AppendLog(std::string const &message) noexcept {
  SYSTEMTIME timestamp{};
  GetLocalTime(&timestamp);

  char prefix[64] = {};
  sprintf_s(
      prefix,
      "[%04d-%02d-%02d %02d:%02d:%02d.%03d] ",
      timestamp.wYear,
      timestamp.wMonth,
      timestamp.wDay,
      timestamp.wHour,
      timestamp.wMinute,
      timestamp.wSecond,
      timestamp.wMilliseconds);

  auto line = std::string(prefix) + message + "\r\n";
  auto logPath = GetHostLogPath();

  HANDLE file = CreateFileA(
      logPath.c_str(),
      FILE_APPEND_DATA,
      FILE_SHARE_READ | FILE_SHARE_WRITE,
      nullptr,
      OPEN_ALWAYS,
      FILE_ATTRIBUTE_NORMAL,
      nullptr);

  if (file != INVALID_HANDLE_VALUE) {
    DWORD written = 0;
    WriteFile(file, line.data(), static_cast<DWORD>(line.size()), &written, nullptr);
    CloseHandle(file);
  }

  OutputDebugStringA(line.c_str());
}

std::string ReadLogTail(std::size_t maxLines) noexcept {
  if (maxLines == 0) {
    return {};
  }

  std::ifstream stream(GetHostLogPath(), std::ios::in | std::ios::binary);
  if (!stream.is_open()) {
    return {};
  }

  std::deque<std::string> lines;
  std::string line;
  while (std::getline(stream, line)) {
    if (!line.empty() && line.back() == '\r') {
      line.pop_back();
    }

    lines.push_back(line);
    if (lines.size() > maxLines) {
      lines.pop_front();
    }
  }

  std::ostringstream buffer;
  for (std::size_t index = 0; index < lines.size(); ++index) {
    if (index > 0) {
      buffer << "\n";
    }
    buffer << lines[index];
  }

  return buffer.str();
}

std::string BoolString(bool value) {
  return value ? "true" : "false";
}

std::wstring BuildDynamicWindowId() noexcept {
  static std::atomic<uint64_t> counter{1};
  auto value = counter.fetch_add(1);
  return L"window.secondary.dynamic." + std::to_wstring(value);
}

} // namespace OpappWindowsHost
