#pragma once

#include <cstddef>
#include <map>
#include <optional>
#include <string>
#include <vector>

#include <winrt/base.h>

namespace OpappWindowsHost {

enum class WindowPolicyId {
  Main,
  Settings,
  Tool,
};

enum class WindowSizeMode {
  Balanced,
  Compact,
  Wide,
};

struct ParsedWindowPolicy {
  WindowPolicyId Policy{WindowPolicyId::Main};
  std::optional<WindowSizeMode> ModeOverride;
};

struct WindowPreferences {
  WindowSizeMode MainWindowMode{WindowSizeMode::Balanced};
  WindowSizeMode SettingsWindowMode{WindowSizeMode::Balanced};
  std::wstring SettingsPresentation{L"current-window"};
};

struct StartupTargetPreference {
  std::wstring SurfaceId;
  std::wstring BundleId;
  WindowPolicyId Policy{WindowPolicyId::Main};
  std::wstring Presentation{L"current-window"};
};

struct LaunchSurfaceConfig {
  std::wstring WindowId;
  std::wstring SurfaceId;
  WindowPolicyId Policy{WindowPolicyId::Main};
  WindowSizeMode MetricsMode{WindowSizeMode::Balanced};
};

struct AutoOpenSurfaceConfig {
  std::wstring SurfaceId;
  WindowPolicyId Policy{WindowPolicyId::Main};
  std::wstring Presentation{L"current-window"};
  std::optional<std::wstring> BundleId;
  std::optional<std::wstring> DevSmokeScenario;
  std::optional<std::wstring> SmokeSaveMainWindowMode;
  std::optional<std::wstring> SmokeSaveSettingsWindowMode;
  std::optional<std::wstring> SmokeSaveSettingsPresentation;
};

struct WindowMetrics {
  int X{0};
  int Y{0};
  int Width{1360};
  int Height{900};
};

struct WindowModeGeometry {
  double WidthFactor{0.5};
  double AspectRatio{0.72};
  int MinWidth{960};
  int MinHeight{780};
};

struct WindowPolicyDefinition {
  WindowPolicyId Policy{WindowPolicyId::Main};
  WindowSizeMode DefaultMode{WindowSizeMode::Balanced};
  int MinWidth{960};
  int MinHeight{780};
  std::wstring DefaultPlacement{L"centered"};
  bool RememberWindowRect{true};
  bool AllowManualResize{true};
  std::map<WindowSizeMode, WindowModeGeometry> Geometry;
};

using WindowPolicyRegistry = std::map<WindowPolicyId, WindowPolicyDefinition>;

std::string ToUtf8(winrt::hstring const &value);
std::string ToUtf8(std::wstring const &value);
std::string ToUtf8(WindowPolicyId policy);
std::string ToUtf8(WindowSizeMode mode);
winrt::hstring WindowPolicyName(WindowPolicyId policy);
winrt::hstring WindowSizeModeName(WindowSizeMode mode);
std::optional<WindowSizeMode> ParseWindowSizeMode(std::string const &mode);
std::optional<ParsedWindowPolicy> ParseWindowPolicy(std::string const &policy);
std::wstring NormalizeSettingsPresentation(std::wstring presentation);
std::wstring NormalizeStartupTargetPresentation(std::wstring presentation);
WindowSizeMode ResolveWindowSizeMode(WindowPolicyId policy, WindowPreferences const &preferences) noexcept;
std::wstring GetWindowTitle(LaunchSurfaceConfig const &launchSurface);
std::string GetHostLogPath() noexcept;
void ResetLog() noexcept;
void AppendLog(std::string const &message) noexcept;
std::string ReadLogTail(std::size_t maxLines = 120) noexcept;
std::string BoolString(bool value);
WindowMetrics ResolveWindowMetrics(
    int workAreaX,
    int workAreaY,
    int workAreaWidth,
    int workAreaHeight,
    WindowPolicyId policy,
    WindowSizeMode mode = WindowSizeMode::Balanced) noexcept;
bool InitializeWindowPolicyRegistry(std::wstring const &appDirectory, bool bundledRuntime) noexcept;
WindowPreferences LoadWindowPreferences() noexcept;
bool SaveWindowPreferences(WindowPreferences const &preferences) noexcept;
std::string SerializeWindowPreferences(WindowPreferences const &preferences);
std::optional<StartupTargetPreference> LoadStartupTargetPreference() noexcept;
bool SaveStartupTargetPreference(StartupTargetPreference const &preference) noexcept;
std::string SerializeStartupTargetPreference(
    std::optional<StartupTargetPreference> const &preference);
std::optional<std::wstring> ReadSessionState(std::wstring const &windowId) noexcept;
bool WriteSessionState(std::wstring const &windowId, std::wstring const &value) noexcept;
bool DeleteSessionState(std::wstring const &windowId) noexcept;
std::vector<std::wstring> ReadStoredSessionWindowIds() noexcept;
std::wstring BuildDynamicWindowId() noexcept;
LaunchSurfaceConfig BuildLaunchSurface(
    std::wstring surfaceId,
    WindowPolicyId policy,
    std::wstring windowId,
    std::optional<WindowSizeMode> modeOverride = std::nullopt) noexcept;
LaunchSurfaceConfig GetInitialLaunchSurface() noexcept;
std::optional<LaunchSurfaceConfig> GetSecondaryStartupSurface() noexcept;
std::optional<AutoOpenSurfaceConfig> GetInitialAutoOpenSurface() noexcept;
std::optional<std::wstring> GetMainDevSmokeScenario() noexcept;
std::optional<std::wstring> GetOtaRemoteUrl() noexcept;

} // namespace OpappWindowsHost
