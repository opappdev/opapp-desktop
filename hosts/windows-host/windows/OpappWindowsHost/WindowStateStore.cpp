#include "pch.h"
#include "HostCore.h"

namespace OpappWindowsHost {
namespace {

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

std::wstring GetPreferencesPath() noexcept {
  wchar_t buffer[512] = {};
  auto launchConfigPath = []() noexcept {
    wchar_t tempPath[MAX_PATH] = {};
    auto length = GetTempPathW(MAX_PATH, tempPath);
    if (length == 0 || length > MAX_PATH) {
      return std::wstring{L"opapp-windows-host.launch.ini"};
    }

    return std::wstring(tempPath) + L"opapp-windows-host.launch.ini";
  }();
  auto configLength = GetPrivateProfileStringW(
      L"preferences",
      L"path",
      L"",
      buffer,
      512,
      launchConfigPath.c_str());
  if (configLength != 0) {
    return std::wstring(buffer, configLength);
  }

  if (auto overridePath = GetEnvironmentString(L"OPAPP_WINDOW_PREFERENCES_PATH")) {
    return *overridePath;
  }

  auto localAppData = GetEnvironmentString(L"LOCALAPPDATA").value_or(L".");
  auto directory = localAppData + L"\\OpappWindowsHost";
  CreateDirectoryW(directory.c_str(), nullptr);
  return directory + L"\\window-preferences.ini";
}

std::wstring GetSessionsPath() noexcept {
  wchar_t buffer[512] = {};
  auto launchConfigPath = []() noexcept {
    wchar_t tempPath[MAX_PATH] = {};
    auto length = GetTempPathW(MAX_PATH, tempPath);
    if (length == 0 || length > MAX_PATH) {
      return std::wstring{L"opapp-windows-host.launch.ini"};
    }

    return std::wstring(tempPath) + L"opapp-windows-host.launch.ini";
  }();
  auto configLength = GetPrivateProfileStringW(
      L"sessions",
      L"path",
      L"",
      buffer,
      512,
      launchConfigPath.c_str());
  if (configLength != 0) {
    return std::wstring(buffer, configLength);
  }

  if (auto overridePath = GetEnvironmentString(L"OPAPP_WINDOW_SESSIONS_PATH")) {
    return *overridePath;
  }

  auto localAppData = GetEnvironmentString(L"LOCALAPPDATA").value_or(L".");
  auto directory = localAppData + L"\\OpappWindowsHost";
  CreateDirectoryW(directory.c_str(), nullptr);
  return directory + L"\\window-sessions.ini";
}

std::optional<std::wstring> ReadPreferencesValue(
    std::wstring const &section,
    std::wstring const &key) noexcept {
  wchar_t buffer[512] = {};
  auto length = GetPrivateProfileStringW(
      section.c_str(),
      key.c_str(),
      L"",
      buffer,
      512,
      GetPreferencesPath().c_str());

  if (length == 0) {
    return std::nullopt;
  }

  return std::wstring(buffer, length);
}

bool WritePreferencesValue(
    std::wstring const &section,
    std::wstring const &key,
    std::wstring const &value) noexcept {
  return WritePrivateProfileStringW(
             section.c_str(),
             key.c_str(),
             value.c_str(),
             GetPreferencesPath().c_str()) != FALSE;
}

bool DeletePreferencesSection(std::wstring const &section) noexcept {
  return WritePrivateProfileStringW(
             section.c_str(),
             nullptr,
             nullptr,
             GetPreferencesPath().c_str()) != FALSE;
}

} // namespace

std::optional<std::wstring> ReadSessionState(std::wstring const &windowId) noexcept {
  std::wstring buffer(16384, L'\0');
  auto length = GetPrivateProfileStringW(
      L"session",
      windowId.c_str(),
      L"",
      buffer.data(),
      static_cast<DWORD>(buffer.size()),
      GetSessionsPath().c_str());

  if (length == 0) {
    return std::nullopt;
  }

  return buffer.substr(0, length);
}

bool WriteSessionState(
    std::wstring const &windowId,
    std::wstring const &value) noexcept {
  return WritePrivateProfileStringW(
             L"session",
             windowId.c_str(),
             value.c_str(),
             GetSessionsPath().c_str()) != FALSE;
}

bool DeleteSessionState(std::wstring const &windowId) noexcept {
  return WritePrivateProfileStringW(
             L"session",
             windowId.c_str(),
             nullptr,
             GetSessionsPath().c_str()) != FALSE;
}

std::vector<std::wstring> ReadStoredSessionWindowIds() noexcept {
  std::vector<std::wstring> windowIds;
  std::wstring buffer(32768, L'\0');
  auto length = GetPrivateProfileSectionW(
      L"session",
      buffer.data(),
      static_cast<DWORD>(buffer.size()),
      GetSessionsPath().c_str());

  if (length == 0 || length >= buffer.size() - 2) {
    return windowIds;
  }

  auto cursor = buffer.c_str();
  while (*cursor != L'\0') {
    std::wstring entry(cursor);
    auto separator = entry.find(L'=');
    if (separator != std::wstring::npos && separator > 0) {
      windowIds.push_back(entry.substr(0, separator));
    }

    cursor += entry.size() + 1;
  }

  return windowIds;
}

WindowPreferences LoadWindowPreferences() noexcept {
  WindowPreferences preferences{};

  if (auto mainMode = ReadPreferencesValue(L"window", L"main-mode")) {
    if (auto parsed = ParseWindowSizeMode(ToUtf8(*mainMode))) {
      preferences.MainWindowMode = *parsed;
    }
  }

  if (auto settingsMode = ReadPreferencesValue(L"window", L"settings-mode")) {
    if (auto parsed = ParseWindowSizeMode(ToUtf8(*settingsMode))) {
      preferences.SettingsWindowMode = *parsed;
    }
  }

  if (auto settingsPresentation = ReadPreferencesValue(L"surface", L"settings-presentation")) {
    preferences.SettingsPresentation = NormalizeSettingsPresentation(*settingsPresentation);
  }

  if (auto appearancePreset = ReadPreferencesValue(L"theme", L"appearance-preset")) {
    preferences.AppearancePreset = NormalizeAppearancePreset(*appearancePreset);
  }

  return preferences;
}

bool SaveWindowPreferences(WindowPreferences const &preferences) noexcept {
  auto normalizedPresentation = NormalizeSettingsPresentation(preferences.SettingsPresentation);
  auto normalizedAppearance = NormalizeAppearancePreset(preferences.AppearancePreset);

  return WritePreferencesValue(L"window", L"main-mode", WindowSizeModeName(preferences.MainWindowMode).c_str()) &&
      WritePreferencesValue(
          L"window",
          L"settings-mode",
          WindowSizeModeName(preferences.SettingsWindowMode).c_str()) &&
      WritePreferencesValue(L"surface", L"settings-presentation", normalizedPresentation) &&
      WritePreferencesValue(L"theme", L"appearance-preset", normalizedAppearance);
}

std::string SerializeWindowPreferences(WindowPreferences const &preferences) {
  return std::string("{\"mainWindowMode\":\"") + ToUtf8(WindowSizeModeName(preferences.MainWindowMode)) +
      "\",\"settingsWindowMode\":\"" + ToUtf8(WindowSizeModeName(preferences.SettingsWindowMode)) +
      "\",\"settingsPresentation\":\"" + ToUtf8(NormalizeSettingsPresentation(preferences.SettingsPresentation)) +
      "\",\"appearancePreset\":\"" + ToUtf8(NormalizeAppearancePreset(preferences.AppearancePreset)) +
      "\"}";
}

std::optional<StartupTargetPreference> LoadStartupTargetPreference() noexcept {
  auto surfaceId = ReadPreferencesValue(L"startup-target", L"surface");
  auto bundleId = ReadPreferencesValue(L"startup-target", L"bundle");
  auto policyName = ReadPreferencesValue(L"startup-target", L"policy");
  auto presentation = ReadPreferencesValue(L"startup-target", L"presentation");

  if (!surfaceId || !bundleId || !policyName || !presentation) {
    return std::nullopt;
  }

  if (surfaceId->empty() || bundleId->empty()) {
    return std::nullopt;
  }

  auto parsedPolicy = ParseWindowPolicy(ToUtf8(*policyName));
  if (!parsedPolicy) {
    return std::nullopt;
  }

  return StartupTargetPreference{
      *surfaceId,
      *bundleId,
      parsedPolicy->Policy,
      NormalizeStartupTargetPresentation(*presentation),
  };
}

bool SaveStartupTargetPreference(StartupTargetPreference const &preference) noexcept {
  auto normalizedPresentation =
      NormalizeStartupTargetPresentation(preference.Presentation);

  return WritePreferencesValue(L"startup-target", L"surface", preference.SurfaceId) &&
      WritePreferencesValue(L"startup-target", L"bundle", preference.BundleId) &&
      WritePreferencesValue(
          L"startup-target",
          L"policy",
          WindowPolicyName(preference.Policy).c_str()) &&
      WritePreferencesValue(
          L"startup-target",
          L"presentation",
          normalizedPresentation);
}

bool DeleteStartupTargetPreference() noexcept {
  return DeletePreferencesSection(L"startup-target");
}

std::string SerializeStartupTargetPreference(
    std::optional<StartupTargetPreference> const &preference) {
  if (!preference) {
    return std::string{};
  }

  return std::string("{\"surfaceId\":\"") + ToUtf8(preference->SurfaceId) +
      "\",\"bundleId\":\"" + ToUtf8(preference->BundleId) +
      "\",\"policy\":\"" + ToUtf8(preference->Policy) +
      "\",\"presentation\":\"" +
      ToUtf8(NormalizeStartupTargetPresentation(preference->Presentation)) + "\"}";
}

} // namespace OpappWindowsHost
