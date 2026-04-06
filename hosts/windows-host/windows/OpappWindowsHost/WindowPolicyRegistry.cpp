#include "pch.h"
#include "HostCore.h"

#include <algorithm>
#include <filesystem>
#include <fstream>
#include <initializer_list>

#include <winrt/Windows.Data.Json.h>

namespace OpappWindowsHost {
namespace {

template <typename TValue, typename TGetter>
std::optional<TValue> TryJsonValue(TGetter &&getter) noexcept {
  try {
    return getter();
  } catch (...) {
    return std::nullopt;
  }
}

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

WindowPolicyRegistry BuildEmergencyWindowPolicyRegistry() noexcept {
  auto createPolicy = [](
                          WindowPolicyId policy,
                          int minWidth,
                          int minHeight,
                          std::initializer_list<std::pair<const WindowSizeMode, WindowModeGeometry>> geometry) {
    WindowPolicyDefinition definition{};
    definition.Policy = policy;
    definition.DefaultMode = WindowSizeMode::Balanced;
    definition.MinWidth = minWidth;
    definition.MinHeight = minHeight;
    definition.DefaultPlacement = L"centered";
    definition.RememberWindowRect = true;
    definition.AllowManualResize = true;
    definition.Geometry = std::map<WindowSizeMode, WindowModeGeometry>(geometry);
    return definition;
  };

  return {
      {WindowPolicyId::Main,
       createPolicy(
           WindowPolicyId::Main,
           960,
           780,
           {{WindowSizeMode::Balanced, WindowModeGeometry{0.5, 0.72, 960, 780}},
            {WindowSizeMode::Compact, WindowModeGeometry{0.42, 0.78, 820, 730}},
            {WindowSizeMode::Wide, WindowModeGeometry{0.6, 0.66, 1140, 800}}})},
      {WindowPolicyId::Settings,
       createPolicy(
           WindowPolicyId::Settings,
           780,
           820,
           {{WindowSizeMode::Balanced, WindowModeGeometry{0.34, 0.88, 780, 820}},
            {WindowSizeMode::Compact, WindowModeGeometry{0.26, 0.94, 720, 770}},
            {WindowSizeMode::Wide, WindowModeGeometry{0.44, 0.82, 960, 840}}})},
      {WindowPolicyId::Tool,
       createPolicy(
           WindowPolicyId::Tool,
           860,
           760,
           {{WindowSizeMode::Balanced, WindowModeGeometry{0.4, 0.82, 860, 760}},
            {WindowSizeMode::Compact, WindowModeGeometry{0.32, 0.88, 720, 710}},
            {WindowSizeMode::Wide, WindowModeGeometry{0.5, 0.76, 1040, 780}}})},
  };
}

WindowPolicyRegistry &GetWindowPolicyRegistry() noexcept {
  static auto registry = BuildEmergencyWindowPolicyRegistry();
  return registry;
}

std::string &GetWindowPolicyRegistrySource() noexcept {
  static auto source = std::string{"emergency-fallback"};
  return source;
}

WindowPolicyDefinition const *FindWindowPolicyDefinition(WindowPolicyId policy) noexcept {
  auto const &registry = GetWindowPolicyRegistry();
  auto iterator = registry.find(policy);
  if (iterator == registry.end()) {
    return nullptr;
  }

  return &iterator->second;
}

WindowModeGeometry ResolveWindowModeGeometry(WindowPolicyId policy, WindowSizeMode mode) noexcept {
  if (auto definition = FindWindowPolicyDefinition(policy)) {
    if (auto iterator = definition->Geometry.find(mode); iterator != definition->Geometry.end()) {
      return iterator->second;
    }

    if (auto fallback = definition->Geometry.find(definition->DefaultMode); fallback != definition->Geometry.end()) {
      return fallback->second;
    }

    return WindowModeGeometry{0.5, 0.72, definition->MinWidth, definition->MinHeight};
  }

  return WindowModeGeometry{};
}

bool FileExists(std::wstring const &path) noexcept {
  try {
    return !path.empty() && std::filesystem::exists(std::filesystem::path(path));
  } catch (...) {
    return false;
  }
}

std::optional<std::wstring> FindWorkspaceWindowPolicyRegistryPath(
    std::wstring const &startDirectory) noexcept {
  try {
    auto probe = std::filesystem::path(startDirectory);
    while (!probe.empty()) {
      auto candidate = probe / "opapp-frontend" / "contracts" / "windowing" / "src" /
          "window-policy-registry.json";
      if (std::filesystem::exists(candidate)) {
        return candidate.wstring();
      }

      auto parent = probe.parent_path();
      if (parent == probe) {
        break;
      }

      probe = parent;
    }
  } catch (...) {
  }

  return std::nullopt;
}

std::optional<std::wstring> ResolveWindowPolicyRegistryPath(
    std::wstring const &appDirectory,
    bool bundledRuntime) noexcept {
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
      L"window-policy",
      L"path",
      L"",
      buffer,
      512,
      launchConfigPath.c_str());
  if (configLength != 0) {
    return std::wstring(buffer, configLength);
  }

  if (auto environmentValue = GetEnvironmentString(L"OPAPP_WINDOW_POLICY_REGISTRY_PATH")) {
    return environmentValue;
  }

  auto bundledPath = std::wstring(appDirectory) + L"\\Bundle\\window-policy-registry.json";
  if (bundledRuntime && FileExists(bundledPath)) {
    return bundledPath;
  }

  if (auto workspacePath = FindWorkspaceWindowPolicyRegistryPath(appDirectory)) {
    return workspacePath;
  }

  if (!bundledRuntime && FileExists(bundledPath)) {
    return bundledPath;
  }

  return std::nullopt;
}

std::optional<std::string> ReadUtf8File(std::wstring const &path) noexcept {
  try {
    std::ifstream input(std::filesystem::path(path), std::ios::binary);
    if (!input) {
      return std::nullopt;
    }

    return std::string((std::istreambuf_iterator<char>(input)), std::istreambuf_iterator<char>());
  } catch (...) {
    return std::nullopt;
  }
}

std::optional<WindowModeGeometry> ParseWindowModeGeometry(
    winrt::Windows::Data::Json::JsonObject const &geometryObject) noexcept {
  auto widthFactor = TryJsonValue<double>([&]() { return geometryObject.GetNamedNumber(L"widthFactor"); });
  auto aspectRatio = TryJsonValue<double>([&]() { return geometryObject.GetNamedNumber(L"aspectRatio"); });
  auto minWidth = TryJsonValue<double>([&]() { return geometryObject.GetNamedNumber(L"minWidth"); });
  auto minHeight = TryJsonValue<double>([&]() { return geometryObject.GetNamedNumber(L"minHeight"); });

  if (!widthFactor || !aspectRatio || !minWidth || !minHeight) {
    return std::nullopt;
  }

  return WindowModeGeometry{*widthFactor, *aspectRatio, static_cast<int>(*minWidth), static_cast<int>(*minHeight)};
}

std::optional<WindowPolicyDefinition> ParseWindowPolicyDefinition(
    winrt::Windows::Data::Json::JsonObject const &policyObject,
    WindowPolicyId policyId) noexcept {
  auto defaultModeName = TryJsonValue<winrt::hstring>([&]() { return policyObject.GetNamedString(L"defaultMode"); });
  auto minWidth = TryJsonValue<double>([&]() { return policyObject.GetNamedNumber(L"minWidth"); });
  auto minHeight = TryJsonValue<double>([&]() { return policyObject.GetNamedNumber(L"minHeight"); });
  auto defaultPlacement = TryJsonValue<winrt::hstring>([&]() { return policyObject.GetNamedString(L"defaultPlacement"); });
  auto rememberWindowRect = TryJsonValue<bool>([&]() { return policyObject.GetNamedBoolean(L"rememberWindowRect"); });
  auto allowManualResize = TryJsonValue<bool>([&]() { return policyObject.GetNamedBoolean(L"allowManualResize"); });
  auto geometryObject = TryJsonValue<winrt::Windows::Data::Json::JsonObject>([&]() { return policyObject.GetNamedObject(L"geometry"); });

  if (!defaultModeName || !minWidth || !minHeight || !defaultPlacement || !rememberWindowRect ||
      !allowManualResize || !geometryObject) {
    return std::nullopt;
  }

  auto defaultMode = ParseWindowSizeMode(winrt::to_string(*defaultModeName));
  if (!defaultMode) {
    return std::nullopt;
  }

  auto balancedGeometry = TryJsonValue<winrt::Windows::Data::Json::JsonObject>([&]() {
    return geometryObject->GetNamedObject(L"balanced");
  });
  auto compactGeometry = TryJsonValue<winrt::Windows::Data::Json::JsonObject>([&]() {
    return geometryObject->GetNamedObject(L"compact");
  });
  auto wideGeometry = TryJsonValue<winrt::Windows::Data::Json::JsonObject>([&]() {
    return geometryObject->GetNamedObject(L"wide");
  });

  if (!balancedGeometry || !compactGeometry || !wideGeometry) {
    return std::nullopt;
  }

  auto balanced = ParseWindowModeGeometry(*balancedGeometry);
  auto compact = ParseWindowModeGeometry(*compactGeometry);
  auto wide = ParseWindowModeGeometry(*wideGeometry);
  if (!balanced || !compact || !wide) {
    return std::nullopt;
  }

  WindowPolicyDefinition definition{};
  definition.Policy = policyId;
  definition.DefaultMode = *defaultMode;
  definition.MinWidth = static_cast<int>(*minWidth);
  definition.MinHeight = static_cast<int>(*minHeight);
  definition.DefaultPlacement = defaultPlacement->c_str();
  definition.RememberWindowRect = *rememberWindowRect;
  definition.AllowManualResize = *allowManualResize;

  // Optional field: defaultMaximized (defaults to false if absent)
  auto defaultMaximized = TryJsonValue<bool>([&]() { return policyObject.GetNamedBoolean(L"defaultMaximized"); });
  definition.DefaultMaximized = defaultMaximized.value_or(false);

  definition.Geometry = {
      {WindowSizeMode::Balanced, *balanced},
      {WindowSizeMode::Compact, *compact},
      {WindowSizeMode::Wide, *wide},
  };
  return definition;
}

std::optional<WindowPolicyRegistry> LoadWindowPolicyRegistryFromPath(
    std::wstring const &path) noexcept {
  auto contents = ReadUtf8File(path);
  if (!contents) {
    return std::nullopt;
  }

  auto rootObject = TryJsonValue<winrt::Windows::Data::Json::JsonObject>([&]() {
    return winrt::Windows::Data::Json::JsonObject::Parse(winrt::to_hstring(*contents));
  });
  if (!rootObject) {
    return std::nullopt;
  }

  struct NamedPolicy {
    wchar_t const *Key;
    WindowPolicyId Policy;
  };

  WindowPolicyRegistry registry{};
  for (auto namedPolicy : {NamedPolicy{L"main", WindowPolicyId::Main},
                           NamedPolicy{L"settings", WindowPolicyId::Settings},
                           NamedPolicy{L"tool", WindowPolicyId::Tool}}) {
    auto policyObject = TryJsonValue<winrt::Windows::Data::Json::JsonObject>([&]() {
      return rootObject->GetNamedObject(namedPolicy.Key);
    });
    if (!policyObject) {
      return std::nullopt;
    }

    auto definition = ParseWindowPolicyDefinition(*policyObject, namedPolicy.Policy);
    if (!definition) {
      return std::nullopt;
    }

    registry.emplace(namedPolicy.Policy, std::move(*definition));
  }

  return registry;
}

} // namespace

bool IsWindowPolicyDefaultMaximized(WindowPolicyId policy) noexcept {
  if (auto definition = FindWindowPolicyDefinition(policy)) {
    return definition->DefaultMaximized;
  }
  return false;
}

WindowSizeMode ResolveWindowSizeMode(
    WindowPolicyId policy,
    WindowPreferences const &preferences) noexcept {
  switch (policy) {
    case WindowPolicyId::Main:
      return preferences.MainWindowMode;
    case WindowPolicyId::Settings:
      return preferences.SettingsWindowMode;
    case WindowPolicyId::Tool:
      break;
  }

  if (auto definition = FindWindowPolicyDefinition(policy)) {
    return definition->DefaultMode;
  }

  return WindowSizeMode::Balanced;
}

WindowMetrics ResolveWindowMetrics(
    int workAreaX,
    int workAreaY,
    int workAreaWidth,
    int workAreaHeight,
    WindowPolicyId policy,
    WindowSizeMode mode) noexcept {
  WindowMetrics metrics{};

  int maxWidth = std::max(900, workAreaWidth - 48);
  int maxHeight = std::max(720, workAreaHeight - 48);
  auto geometry = ResolveWindowModeGeometry(policy, mode);

  int minWidth = std::min(geometry.MinWidth, maxWidth);
  int width = std::clamp(static_cast<int>(workAreaWidth * geometry.WidthFactor), minWidth, maxWidth);

  int minHeight = std::min(geometry.MinHeight, maxHeight);
  int height = std::clamp(static_cast<int>(width * geometry.AspectRatio), minHeight, maxHeight);

  metrics.Width = width;
  metrics.Height = height;
  metrics.X = workAreaX + std::max(0, (workAreaWidth - width) / 2);
  metrics.Y = workAreaY + std::max(0, (workAreaHeight - height) / 2);
  return metrics;
}

bool InitializeWindowPolicyRegistry(
    std::wstring const &appDirectory,
    bool bundledRuntime) noexcept {
  auto &registry = GetWindowPolicyRegistry();
  auto &source = GetWindowPolicyRegistrySource();

  if (auto registryPath = ResolveWindowPolicyRegistryPath(appDirectory, bundledRuntime)) {
    if (auto loadedRegistry = LoadWindowPolicyRegistryFromPath(*registryPath)) {
      registry = std::move(*loadedRegistry);
      source = ToUtf8(*registryPath);
      AppendLog("WindowPolicyRegistrySource=" + source);
      return true;
    }

    AppendLog("WindowPolicyRegistryLoadFailed path=" + ToUtf8(*registryPath));
  } else {
    AppendLog("WindowPolicyRegistryLoadFailed path=<not-found>");
  }

  if (bundledRuntime) {
    source = "registry-load-failed";
    AppendLog("WindowPolicyRegistrySource=" + source);
    return false;
  }

  registry = BuildEmergencyWindowPolicyRegistry();
  source = "emergency-fallback";
  AppendLog("WindowPolicyRegistrySource=" + source);
  return true;
}

} // namespace OpappWindowsHost


