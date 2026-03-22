#include "pch.h"
#include "HostCore.h"

#include <atomic>

namespace OpappWindowsHost {
namespace {

std::string GetLogPath() {
  char tempPath[MAX_PATH] = {};
  auto length = GetTempPathA(MAX_PATH, tempPath);
  if (length == 0 || length > MAX_PATH) {
    return "opapp-windows-host.log";
  }

  return std::string(tempPath) + "opapp-windows-host.log";
}

} // namespace

std::string ToUtf8(winrt::hstring const &value) {
  return winrt::to_string(value);
}

std::string ToUtf8(std::wstring const &value) {
  return winrt::to_string(winrt::hstring{value});
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

std::wstring GetWindowTitle(LaunchSurfaceConfig const &launchSurface) {
  if (launchSurface.Policy == WindowPolicyId::Settings) {
    return L"Opapp Settings";
  }

  if (launchSurface.Policy == WindowPolicyId::Tool) {
    return L"Opapp Tool";
  }

  return L"OpappWindowsHost";
}

void ResetLog() noexcept {
  auto logPath = GetLogPath();
  HANDLE file = CreateFileA(
      logPath.c_str(),
      GENERIC_WRITE,
      FILE_SHARE_READ | FILE_SHARE_WRITE,
      nullptr,
      CREATE_ALWAYS,
      FILE_ATTRIBUTE_NORMAL,
      nullptr);

  if (file != INVALID_HANDLE_VALUE) {
    CloseHandle(file);
  }
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
  auto logPath = GetLogPath();

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

std::string BoolString(bool value) {
  return value ? "true" : "false";
}

std::wstring BuildDynamicWindowId() noexcept {
  static std::atomic<uint64_t> counter{1};
  auto value = counter.fetch_add(1);
  return L"window.secondary.dynamic." + std::to_wstring(value);
}

} // namespace OpappWindowsHost
