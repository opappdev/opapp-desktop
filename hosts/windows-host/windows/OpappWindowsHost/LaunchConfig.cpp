#include "pch.h"
#include "HostCore.h"

namespace OpappWindowsHost {
namespace {

constexpr wchar_t kDefaultOtaRemoteUrl[] = L"https://r2.opapp.dev";

std::optional<std::wstring> GetEnvironmentString(std::wstring const &name) noexcept {
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

std::wstring GetLaunchConfigPath() noexcept {
  wchar_t tempPath[MAX_PATH] = {};
  auto length = GetTempPathW(MAX_PATH, tempPath);
  if (length == 0 || length > MAX_PATH) {
    return L"opapp-windows-host.launch.ini";
  }

  return std::wstring(tempPath) + L"opapp-windows-host.launch.ini";
}

std::optional<std::wstring> ReadLaunchConfigValue(
    std::wstring const &section,
    std::wstring const &key) noexcept {
  wchar_t buffer[512] = {};
  auto length = GetPrivateProfileStringW(
      section.c_str(),
      key.c_str(),
      L"",
      buffer,
      512,
      GetLaunchConfigPath().c_str());

  if (length == 0) {
    return std::nullopt;
  }

  return std::wstring(buffer, length);
}

std::optional<std::wstring> GetStartupOverride(
    std::wstring const &section,
    std::wstring const &key,
    std::wstring const &environmentName) noexcept {
  if (auto configValue = ReadLaunchConfigValue(section, key)) {
    return configValue;
  }

  return GetEnvironmentString(environmentName);
}

std::optional<bool> ParseBooleanValue(std::wstring const &value) noexcept {
  if (value == L"1" || value == L"true" || value == L"TRUE" || value == L"yes" || value == L"on") {
    return true;
  }
  if (value == L"0" || value == L"false" || value == L"FALSE" || value == L"no" || value == L"off") {
    return false;
  }

  return std::nullopt;
}

bool GetBooleanStartupOverride(
    std::wstring const &section,
    std::wstring const &key,
    std::wstring const &environmentName,
    bool fallbackValue = false) noexcept {
  if (auto value = GetStartupOverride(section, key, environmentName)) {
    if (auto parsed = ParseBooleanValue(*value)) {
      return *parsed;
    }
  }

  return fallbackValue;
}

} // namespace

LaunchSurfaceConfig BuildLaunchSurface(
    std::wstring surfaceId,
    WindowPolicyId policy,
    std::wstring windowId,
    std::optional<WindowSizeMode> modeOverride) noexcept {
  auto preferences = LoadWindowPreferences();
  return LaunchSurfaceConfig{
      std::move(windowId),
      std::move(surfaceId),
      policy,
      modeOverride.value_or(ResolveWindowSizeMode(policy, preferences)),
  };
}

LaunchSurfaceConfig GetInitialLaunchSurface() noexcept {
  auto surfaceId = GetStartupOverride(L"main", L"surface", L"OPAPP_MAIN_SURFACE_ID").value_or(L"companion.main");
  auto policyName = GetStartupOverride(L"main", L"policy", L"OPAPP_MAIN_WINDOW_POLICY");

  WindowPolicyId policy = WindowPolicyId::Main;
  std::optional<WindowSizeMode> modeOverride;
  if (policyName) {
    auto parsedPolicy = ParseWindowPolicy(ToUtf8(*policyName));
    if (parsedPolicy) {
      policy = parsedPolicy->Policy;
      modeOverride = parsedPolicy->ModeOverride;
    }
  }

  return BuildLaunchSurface(std::move(surfaceId), policy, L"window.main", modeOverride);
}

std::optional<LaunchSurfaceConfig> GetSecondaryStartupSurface() noexcept {
  auto surfaceId = GetStartupOverride(L"secondary", L"surface", L"OPAPP_SECONDARY_SURFACE_ID");
  if (!surfaceId) {
    return std::nullopt;
  }

  auto policyName = GetStartupOverride(L"secondary", L"policy", L"OPAPP_SECONDARY_WINDOW_POLICY");
  WindowPolicyId policy = WindowPolicyId::Settings;
  std::optional<WindowSizeMode> modeOverride;
  if (policyName) {
    auto parsedPolicy = ParseWindowPolicy(ToUtf8(*policyName));
    if (parsedPolicy) {
      policy = parsedPolicy->Policy;
      modeOverride = parsedPolicy->ModeOverride;
    }
  }

  return BuildLaunchSurface(std::move(*surfaceId), policy, L"window.secondary.startup", modeOverride);
}

std::optional<std::wstring> GetMainDevSmokeScenario() noexcept {
  return GetStartupOverride(L"main-props", L"dev-smoke-scenario", L"OPAPP_MAIN_DEV_SMOKE_SCENARIO");
}

std::optional<AutoOpenSurfaceConfig> GetInitialAutoOpenSurface() noexcept {
  auto surfaceId = GetStartupOverride(L"initial-open", L"surface", L"OPAPP_INITIAL_OPEN_SURFACE_ID");
  if (!surfaceId) {
    return std::nullopt;
  }

  AutoOpenSurfaceConfig config{};
  config.SurfaceId = std::move(*surfaceId);

  if (auto policyName = GetStartupOverride(L"initial-open", L"policy", L"OPAPP_INITIAL_OPEN_WINDOW_POLICY")) {
    auto parsedPolicy = ParseWindowPolicy(ToUtf8(*policyName));
    if (parsedPolicy) {
      config.Policy = parsedPolicy->Policy;
    }
  }

  if (auto presentation =
          GetStartupOverride(L"initial-open", L"presentation", L"OPAPP_INITIAL_OPEN_PRESENTATION")) {
    config.Presentation = *presentation;
  }

  if (auto bundleId = GetStartupOverride(L"initial-open", L"bundle", L"OPAPP_INITIAL_OPEN_BUNDLE_ID")) {
    config.BundleId = *bundleId;
  }

  if (auto devSmokeScenario =
          ReadLaunchConfigValue(L"initial-open-props", L"dev-smoke-scenario")) {
    config.DevSmokeScenario = *devSmokeScenario;
  }

  if (auto smokeSaveMainWindowMode =
          ReadLaunchConfigValue(L"initial-open-props", L"smoke-save-main-window-mode")) {
    config.SmokeSaveMainWindowMode = *smokeSaveMainWindowMode;
  }

  if (auto smokeSaveSettingsWindowMode =
          ReadLaunchConfigValue(L"initial-open-props", L"smoke-save-settings-window-mode")) {
    config.SmokeSaveSettingsWindowMode = *smokeSaveSettingsWindowMode;
  }

  if (auto smokeSaveSettingsPresentation =
          ReadLaunchConfigValue(L"initial-open-props", L"smoke-save-settings-presentation")) {
    config.SmokeSaveSettingsPresentation = *smokeSaveSettingsPresentation;
  }

  return config;
}

std::optional<std::wstring> GetOtaRemoteUrl() noexcept {
  if (auto configured = GetStartupOverride(L"ota", L"remote", L"OPAPP_OTA_REMOTE_URL")) {
    return configured;
  }

  return std::wstring(kDefaultOtaRemoteUrl);
}

std::optional<std::wstring> GetOtaChannel() noexcept {
  return GetStartupOverride(L"ota", L"channel", L"OPAPP_OTA_CHANNEL");
}

bool GetOtaForceUpdate() noexcept {
  return GetBooleanStartupOverride(L"ota", L"force", L"OPAPP_OTA_FORCE");
}

bool GetOtaDisableNativeUpdate() noexcept {
  return GetBooleanStartupOverride(
      L"ota",
      L"disable-native-update",
      L"OPAPP_OTA_DISABLE_NATIVE_UPDATE");
}

} // namespace OpappWindowsHost
