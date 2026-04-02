#include "pch.h"
#include "WindowManager.h"
#include "NativeModules.h"

#include <algorithm>
#include <filesystem>
#include <fstream>
#include <functional>
#include <map>
#include <memory>
#include <set>
#include <cwctype>

#include <winrt/Windows.Data.Json.h>

namespace OpappWindowsHost {
namespace {

struct BundleManifestMetadata {
  std::optional<std::wstring> BundleId;
  std::optional<std::wstring> EntryFile;
  std::optional<std::wstring> Version;
  std::optional<std::wstring> SourceKind;
};

struct OtaStateMetadata {
  std::optional<std::wstring> BundleId;
  std::optional<std::wstring> HostBundleDir;
  std::optional<std::wstring> StagedAt;
  std::optional<std::wstring> Version;
};

struct OtaLastRunMetadata {
  std::optional<std::wstring> BundleId;
  std::optional<std::wstring> CurrentVersion;
  std::optional<std::wstring> RecordedAt;
  std::optional<std::wstring> RemoteBase;
  std::optional<std::wstring> StagedAt;
  std::optional<std::wstring> Status;
  std::optional<std::wstring> Version;
};

template <typename TValue, typename TGetter>
std::optional<TValue> TryJsonValue(TGetter &&getter) noexcept {
  try {
    return getter();
  } catch (...) {
    return std::nullopt;
  }
}

std::optional<std::wstring> ReadBundleManifestStringField(
    winrt::Windows::Data::Json::JsonObject const &jsonObject,
    wchar_t const *fieldName) noexcept {
  try {
    auto value = jsonObject.GetNamedString(fieldName);
    std::wstring normalized(value.c_str(), value.size());
    if (normalized.empty()) {
      return std::nullopt;
    }

    return normalized;
  } catch (...) {
    return std::nullopt;
  }
}

std::optional<BundleManifestMetadata> ReadBundleManifestMetadata(std::wstring const &bundleRoot) noexcept {
  try {
    auto manifestPath = std::filesystem::path(bundleRoot) / L"bundle-manifest.json";
    std::ifstream stream(manifestPath, std::ios::binary);
    if (!stream.is_open()) {
      return std::nullopt;
    }

    std::string contents((std::istreambuf_iterator<char>(stream)), std::istreambuf_iterator<char>());
    auto jsonObject = winrt::Windows::Data::Json::JsonObject::Parse(winrt::to_hstring(contents));

    BundleManifestMetadata metadata;
    metadata.BundleId = ReadBundleManifestStringField(jsonObject, L"bundleId");
    metadata.EntryFile = ReadBundleManifestStringField(jsonObject, L"entryFile");
    metadata.Version = ReadBundleManifestStringField(jsonObject, L"version");
    metadata.SourceKind = ReadBundleManifestStringField(jsonObject, L"sourceKind");

    constexpr std::wstring_view kBundleSuffix = L".bundle";
    if (metadata.EntryFile &&
        metadata.EntryFile->size() > kBundleSuffix.size() &&
        metadata.EntryFile->substr(metadata.EntryFile->size() - kBundleSuffix.size()) == kBundleSuffix) {
      metadata.EntryFile =
          metadata.EntryFile->substr(0, metadata.EntryFile->size() - kBundleSuffix.size());
    }

    if (metadata.EntryFile && metadata.EntryFile->empty()) {
      metadata.EntryFile = std::nullopt;
    }

    return metadata;
  } catch (...) {
    return std::nullopt;
  }
}

std::optional<winrt::Windows::Data::Json::JsonObject> ReadJsonObjectFile(
    std::filesystem::path const &jsonPath) noexcept {
  try {
    std::ifstream stream(jsonPath, std::ios::binary);
    if (!stream.is_open()) {
      return std::nullopt;
    }

    std::string contents((std::istreambuf_iterator<char>(stream)), std::istreambuf_iterator<char>());
    return winrt::Windows::Data::Json::JsonObject::Parse(winrt::to_hstring(contents));
  } catch (...) {
    return std::nullopt;
  }
}

std::optional<OtaStateMetadata> ReadOtaStateMetadata(std::wstring const &appDirectory) noexcept {
  auto otaStateObject = ReadJsonObjectFile(ResolveOtaCacheRoot(appDirectory) / L"ota-state.json");
  if (!otaStateObject) {
    return std::nullopt;
  }

  OtaStateMetadata metadata;
  metadata.BundleId = ReadBundleManifestStringField(*otaStateObject, L"bundleId");
  metadata.HostBundleDir = ReadBundleManifestStringField(*otaStateObject, L"hostBundleDir");
  metadata.StagedAt = ReadBundleManifestStringField(*otaStateObject, L"stagedAt");
  metadata.Version = ReadBundleManifestStringField(*otaStateObject, L"version");
  return metadata;
}

std::optional<OtaLastRunMetadata> ReadOtaLastRunMetadata(std::wstring const &appDirectory) noexcept {
  auto otaLastRunObject = ReadJsonObjectFile(ResolveOtaCacheRoot(appDirectory) / L"last-run.json");
  if (!otaLastRunObject) {
    return std::nullopt;
  }

  OtaLastRunMetadata metadata;
  metadata.BundleId = ReadBundleManifestStringField(*otaLastRunObject, L"bundleId");
  metadata.CurrentVersion = ReadBundleManifestStringField(*otaLastRunObject, L"currentVersion");
  metadata.RecordedAt = ReadBundleManifestStringField(*otaLastRunObject, L"recordedAt");
  metadata.RemoteBase = ReadBundleManifestStringField(*otaLastRunObject, L"remoteBase");
  metadata.StagedAt = ReadBundleManifestStringField(*otaLastRunObject, L"stagedAt");
  metadata.Status = ReadBundleManifestStringField(*otaLastRunObject, L"status");
  metadata.Version = ReadBundleManifestStringField(*otaLastRunObject, L"version");
  return metadata;
}

std::wstring NormalizePathForComparison(std::filesystem::path const &targetPath) noexcept {
  auto normalizedPath = targetPath.lexically_normal().wstring();
  std::transform(
      normalizedPath.begin(),
      normalizedPath.end(),
      normalizedPath.begin(),
      [](wchar_t ch) { return static_cast<wchar_t>(std::towlower(ch)); });
  return normalizedPath;
}

bool OtaStateMatchesBundle(
    OtaStateMetadata const &otaState,
    std::filesystem::path const &bundleRoot,
    std::wstring const &bundleId,
    std::optional<std::wstring> const &bundleVersion) noexcept {
  if (!otaState.BundleId || otaState.BundleId->empty() || *otaState.BundleId != bundleId) {
    return false;
  }

  if (!otaState.HostBundleDir || otaState.HostBundleDir->empty()) {
    return false;
  }

  if (bundleVersion && (!otaState.Version || otaState.Version->empty() || *otaState.Version != *bundleVersion)) {
    return false;
  }

  return NormalizePathForComparison(std::filesystem::path(*otaState.HostBundleDir)) ==
      NormalizePathForComparison(bundleRoot);
}

bool OtaLastRunMatchesBundle(
    OtaLastRunMetadata const &lastRun,
    std::wstring const &bundleId,
    std::optional<std::wstring> const &bundleVersion) noexcept {
  if (!lastRun.BundleId || lastRun.BundleId->empty() || *lastRun.BundleId != bundleId) {
    return false;
  }

  if (!bundleVersion || bundleVersion->empty()) {
    return true;
  }

  return
      (lastRun.Version && !lastRun.Version->empty() && *lastRun.Version == *bundleVersion) ||
      (lastRun.CurrentVersion && !lastRun.CurrentVersion->empty() && *lastRun.CurrentVersion == *bundleVersion);
}

std::optional<std::wstring> ReadBundleManifestEntryFile(std::wstring const &bundleRoot) noexcept {
  auto metadata = ReadBundleManifestMetadata(bundleRoot);
  if (!metadata) {
    return std::nullopt;
  }

  return metadata->EntryFile;
}

RECT GetWindowWorkArea(HWND hwnd) noexcept {
  RECT workArea{0, 0, 1920, 1080};
  HMONITOR monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
  MONITORINFO monitorInfo{};
  monitorInfo.cbSize = sizeof(monitorInfo);

  if (GetMonitorInfoW(monitor, &monitorInfo)) {
    workArea = monitorInfo.rcWork;
  }

  return workArea;
}

struct HostedSurfaceWindow : public std::enable_shared_from_this<HostedSurfaceWindow> {
  static constexpr PCWSTR WindowClassName = L"OPAPP_SURFACE_WINDOW";

  HostedSurfaceWindow(
      winrt::Microsoft::ReactNative::ReactNativeHost reactNativeHost,
      LaunchSurfaceConfig launchSurface) noexcept
      : m_reactNativeHost(std::move(reactNativeHost)), m_launchSurface(std::move(launchSurface)) {}

  static void RegisterWindowClass() noexcept {
    static bool registered = false;
    if (registered) {
      return;
    }

    WNDCLASSEXW windowClass{};
    windowClass.cbSize = sizeof(WNDCLASSEXW);
    windowClass.style = CS_HREDRAW | CS_VREDRAW;
    windowClass.lpfnWndProc = &HostedSurfaceWindow::WndProc;
    windowClass.hInstance = GetModuleHandleW(nullptr);
    windowClass.hCursor = LoadCursor(nullptr, IDC_ARROW);
    windowClass.hbrBackground = reinterpret_cast<HBRUSH>(COLOR_WINDOW + 1);
    windowClass.lpszClassName = WindowClassName;

    RegisterClassExW(&windowClass);
    registered = true;
  }

  bool CreateAndShow() noexcept {
    RegisterWindowClass();

    m_compositionHost = React::CompositionHwndHost();
    winrt::Microsoft::ReactNative::ReactViewOptions viewOptions;
    viewOptions.ComponentName(L"OpappWindowsHost");
    viewOptions.InitialProps(CreateLaunchProps(m_launchSurface));
    m_compositionHost.ReactViewHost(
        winrt::Microsoft::ReactNative::ReactCoreInjection::MakeViewHost(m_reactNativeHost, viewOptions));

    m_hwnd = CreateWindowExW(
        0,
        WindowClassName,
        GetWindowTitle(m_launchSurface).c_str(),
        WS_OVERLAPPEDWINDOW,
        CW_USEDEFAULT,
        CW_USEDEFAULT,
        1280,
        900,
        nullptr,
        nullptr,
        GetModuleHandleW(nullptr),
        this);

    if (!m_hwnd) {
      AppendLog(
          "SecondaryWindowOpenFailed surface=" + ToUtf8(m_launchSurface.SurfaceId) + " reason=create-window");
      return false;
    }

    ApplyInitialPlacement();
    ShowWindow(m_hwnd, SW_SHOW);
    BringWindowToTop(m_hwnd);
    SetForegroundWindow(m_hwnd);
    SetFocus(m_hwnd);
    return true;
  }

  HWND Hwnd() const noexcept {
    return m_hwnd;
  }

  std::wstring const &WindowId() const noexcept {
    return m_launchSurface.WindowId;
  }

  std::wstring const &SurfaceId() const noexcept {
    return m_launchSurface.SurfaceId;
  }

  WindowPolicyId Policy() const noexcept {
    return m_launchSurface.Policy;
  }

  LaunchSurfaceConfig LaunchSurface() const noexcept {
    return m_launchSurface;
  }

  void ApplyMetricsMode(WindowSizeMode mode) noexcept {
    m_launchSurface.MetricsMode = mode;
    if (m_hwnd) {
      ApplyInitialPlacement();
    }
  }

  void Activate() noexcept {
    if (!m_hwnd) {
      return;
    }

    ShowWindow(m_hwnd, IsIconic(m_hwnd) ? SW_RESTORE : SW_SHOW);
    BringWindowToTop(m_hwnd);
    SetForegroundWindow(m_hwnd);
    SetFocus(m_hwnd);
  }

  void SetCloseCallback(std::function<void(HWND)> callback) noexcept {
    m_onClosed = std::move(callback);
  }

 private:
  void ApplyInitialPlacement() noexcept {
    auto workArea = GetWindowWorkArea(m_hwnd);
    auto metrics = ResolveWindowMetrics(
        workArea.left,
        workArea.top,
        workArea.right - workArea.left,
        workArea.bottom - workArea.top,
        m_launchSurface.Policy,
        m_launchSurface.MetricsMode);

    SetWindowPos(
        m_hwnd,
        nullptr,
        metrics.X,
        metrics.Y,
        metrics.Width,
        metrics.Height,
        SWP_NOZORDER | SWP_NOACTIVATE);

    AppendLog(
        "SecondaryWindowRect surface=" + ToUtf8(m_launchSurface.SurfaceId) + " policy=" +
        ToUtf8(m_launchSurface.Policy) + " mode=" + ToUtf8(m_launchSurface.MetricsMode) + " rect=" +
        std::to_string(metrics.X) + "," + std::to_string(metrics.Y) + " " + std::to_string(metrics.Width) +
        "x" + std::to_string(metrics.Height));
  }

  LRESULT HandleMessage(HWND hwnd, UINT message, WPARAM wparam, LPARAM lparam) noexcept {
    if (m_compositionHost) {
      auto translated = static_cast<LRESULT>(m_compositionHost.TranslateMessage(message, wparam, lparam));
      if (translated) {
        return translated;
      }
    }

    switch (message) {
      case WM_CREATE:
        m_compositionHost.Initialize(reinterpret_cast<uint64_t>(hwnd));
        return 0;
      case WM_CLOSE:
        DestroyWindow(hwnd);
        return 0;
      case WM_NCDESTROY:
        SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
        if (m_onClosed) {
          m_onClosed(hwnd);
        }
        m_hwnd = nullptr;
        return 0;
      default:
        return DefWindowProcW(hwnd, message, wparam, lparam);
    }
  }

  static LRESULT CALLBACK WndProc(HWND hwnd, UINT message, WPARAM wparam, LPARAM lparam) noexcept {
    HostedSurfaceWindow *self = reinterpret_cast<HostedSurfaceWindow *>(GetWindowLongPtrW(hwnd, GWLP_USERDATA));

    if (message == WM_NCCREATE) {
      auto createStruct = reinterpret_cast<CREATESTRUCTW *>(lparam);
      self = static_cast<HostedSurfaceWindow *>(createStruct->lpCreateParams);
      SetWindowLongPtrW(hwnd, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(self));
      if (self) {
        self->m_hwnd = hwnd;
      }
      return TRUE;
    }

    if (!self) {
      return DefWindowProcW(hwnd, message, wparam, lparam);
    }

    return self->HandleMessage(hwnd, message, wparam, lparam);
  }

 private:
  winrt::Microsoft::ReactNative::ReactNativeHost m_reactNativeHost{nullptr};
  React::CompositionHwndHost m_compositionHost{nullptr};
  LaunchSurfaceConfig m_launchSurface;
  HWND m_hwnd{nullptr};
  std::function<void(HWND)> m_onClosed;
};

struct WindowManagerState {
  winrt::Microsoft::ReactNative::ReactNativeHost ReactNativeHost{nullptr};
  winrt::Microsoft::UI::Windowing::AppWindow MainAppWindow{nullptr};
  std::optional<LaunchSurfaceConfig> MainLaunchSurface;
  HWND MainWindowHandle{nullptr};
  WNDPROC MainWindowProc{nullptr};
  std::map<HWND, std::shared_ptr<HostedSurfaceWindow>> HostedWindows;
  std::set<std::wstring> PendingSessionCleanupWindowIds;
  std::wstring AppDirectory;
  bool BundledRuntime{false};
  std::wstring CurrentBundleId{L"opapp.companion.main"};
};

WindowManagerState &GetWindowManagerState() noexcept {
  static WindowManagerState state{};
  return state;
}

std::string DescribeMainWindowHandle(HWND hwnd) noexcept {
  return std::to_string(reinterpret_cast<uintptr_t>(hwnd));
}

void AppendMainWindowLifecycleLog(
    char const *type,
    HWND hwnd,
    WPARAM wparam,
    LPARAM lparam) noexcept {
  auto &state = GetWindowManagerState();
  auto logLine =
      std::string("MainWindowMessage type=") + type + " hwnd=" + DescribeMainWindowHandle(hwnd);

  if (state.MainLaunchSurface) {
    logLine +=
        " window=" + ToUtf8(state.MainLaunchSurface->WindowId) +
        " surface=" + ToUtf8(state.MainLaunchSurface->SurfaceId);
  }

  logLine +=
      " wparam=" + std::to_string(static_cast<uintptr_t>(wparam)) +
      " lparam=" + std::to_string(static_cast<intptr_t>(lparam));
  AppendLog(logLine);
}

LRESULT CALLBACK MainWindowDiagnosticWndProc(
    HWND hwnd,
    UINT message,
    WPARAM wparam,
    LPARAM lparam) noexcept {
  switch (message) {
    case WM_SYSCOMMAND:
      if ((wparam & 0xFFF0u) == SC_CLOSE) {
        AppendMainWindowLifecycleLog("WM_SYSCOMMAND/SC_CLOSE", hwnd, wparam, lparam);
      }
      break;
    case WM_QUERYENDSESSION:
      AppendMainWindowLifecycleLog("WM_QUERYENDSESSION", hwnd, wparam, lparam);
      break;
    case WM_ENDSESSION:
      AppendMainWindowLifecycleLog("WM_ENDSESSION", hwnd, wparam, lparam);
      break;
    case WM_CLOSE:
      AppendMainWindowLifecycleLog("WM_CLOSE", hwnd, wparam, lparam);
      break;
    case WM_DESTROY:
      AppendMainWindowLifecycleLog("WM_DESTROY", hwnd, wparam, lparam);
      break;
    case WM_NCDESTROY:
      AppendMainWindowLifecycleLog("WM_NCDESTROY", hwnd, wparam, lparam);
      break;
    default:
      break;
  }

  auto &state = GetWindowManagerState();
  auto originalProc = state.MainWindowProc;
  auto result =
      originalProc ? CallWindowProcW(originalProc, hwnd, message, wparam, lparam)
                   : DefWindowProcW(hwnd, message, wparam, lparam);

  if (message == WM_NCDESTROY && state.MainWindowHandle == hwnd) {
    state.MainWindowHandle = nullptr;
    state.MainWindowProc = nullptr;
    AppendLog("MainWindowHookDetached hwnd=" + DescribeMainWindowHandle(hwnd));
  }

  return result;
}

std::optional<std::wstring> ResolveBundleRootPath(
    WindowManagerState const &state,
    std::wstring const &bundleId) noexcept {
  if (!state.BundledRuntime || state.AppDirectory.empty()) {
    return std::nullopt;
  }

  try {
    auto bundleRoot = std::filesystem::path(state.AppDirectory) / L"Bundle";
    if (!bundleId.empty() && bundleId != L"opapp.companion.main") {
      bundleRoot /= L"bundles";
      bundleRoot /= bundleId;
    }

    if (!std::filesystem::exists(bundleRoot)) {
      return std::nullopt;
    }

    return bundleRoot.wstring();
  } catch (...) {
    return std::nullopt;
  }
}

std::optional<HWND> TryGetMainWindowHandle() noexcept {
  auto &state = GetWindowManagerState();
  if (!state.MainAppWindow) {
    return std::nullopt;
  }

  try {
    auto hwnd = winrt::Microsoft::UI::GetWindowFromWindowId(state.MainAppWindow.Id());
    if (hwnd != nullptr) {
      return hwnd;
    }
  } catch (...) {
  }

  return std::nullopt;
}

void EnsureMainWindowDiagnosticsHook() noexcept {
  auto &state = GetWindowManagerState();
  auto hwnd = TryGetMainWindowHandle();
  if (!hwnd) {
    AppendLog("MainWindowHookInstallFailed reason=missing-hwnd");
    return;
  }

  if (state.MainWindowHandle == *hwnd && state.MainWindowProc != nullptr) {
    return;
  }

  SetLastError(0);
  auto previousProc = reinterpret_cast<WNDPROC>(
      SetWindowLongPtrW(*hwnd, GWLP_WNDPROC, reinterpret_cast<LONG_PTR>(&MainWindowDiagnosticWndProc)));
  auto installError = GetLastError();
  if (!previousProc && installError != 0) {
    AppendLog(
        "MainWindowHookInstallFailed hwnd=" + DescribeMainWindowHandle(*hwnd) +
        " error=" + std::to_string(installError));
    return;
  }

  state.MainWindowHandle = *hwnd;
  state.MainWindowProc = previousProc;
  AppendLog("MainWindowHookInstalled hwnd=" + DescribeMainWindowHandle(*hwnd));
}

std::shared_ptr<HostedSurfaceWindow> FindHostedWindowById(std::wstring const &windowId) noexcept {
  auto &state = GetWindowManagerState();
  for (auto const &[hwnd, window] : state.HostedWindows) {
    if (window && window->WindowId() == windowId) {
      return window;
    }
  }

  return nullptr;
}

struct ActiveSessionTarget {
  std::wstring SurfaceId;
  WindowPolicyId Policy{WindowPolicyId::Main};
};

std::optional<ActiveSessionTarget> ExtractActiveSessionTargetFromPayload(
    std::wstring const &sessionPayload) noexcept {
  try {
    auto sessionObject = winrt::Windows::Data::Json::JsonObject::Parse(sessionPayload);
    auto activeTabIdValue = TryJsonValue<winrt::Windows::Data::Json::IJsonValue>([&]() {
      return sessionObject.GetNamedValue(L"activeTabId");
    });
    auto tabsValue = TryJsonValue<winrt::Windows::Data::Json::IJsonValue>([&]() {
      return sessionObject.GetNamedValue(L"tabs");
    });
    if (!activeTabIdValue || !tabsValue) {
      return std::nullopt;
    }

    if (activeTabIdValue->ValueType() != winrt::Windows::Data::Json::JsonValueType::String ||
        tabsValue->ValueType() != winrt::Windows::Data::Json::JsonValueType::Array) {
      return std::nullopt;
    }

    auto activeTabId = activeTabIdValue->GetString();
    auto tabs = tabsValue->GetArray();
    for (uint32_t index = 0; index < tabs.Size(); ++index) {
      auto tabValue = tabs.GetAt(index);
      if (tabValue.ValueType() != winrt::Windows::Data::Json::JsonValueType::Object) {
        continue;
      }

      auto tabObject = tabValue.GetObject();
      auto tabIdValue = TryJsonValue<winrt::Windows::Data::Json::IJsonValue>([&]() {
        return tabObject.GetNamedValue(L"tabId");
      });
      auto surfaceIdValue = TryJsonValue<winrt::Windows::Data::Json::IJsonValue>([&]() {
        return tabObject.GetNamedValue(L"surfaceId");
      });
      if (!tabIdValue || !surfaceIdValue) {
        continue;
      }

      if (tabIdValue->ValueType() != winrt::Windows::Data::Json::JsonValueType::String ||
          surfaceIdValue->ValueType() != winrt::Windows::Data::Json::JsonValueType::String) {
        continue;
      }

      if (tabIdValue->GetString() != activeTabId) {
        continue;
      }

      auto policy = WindowPolicyId::Main;
      auto policyValue = TryJsonValue<winrt::Windows::Data::Json::IJsonValue>([&]() {
        return tabObject.GetNamedValue(L"policy");
      });
      if (policyValue && policyValue->ValueType() == winrt::Windows::Data::Json::JsonValueType::String) {
        if (auto parsedPolicy = ParseWindowPolicy(ToUtf8(policyValue->GetString()))) {
          policy = parsedPolicy->Policy;
        }
      }

      return ActiveSessionTarget{std::wstring(surfaceIdValue->GetString()), policy};
    }
  } catch (...) {
  }

  return std::nullopt;
}

std::optional<std::wstring> ExtractActiveSurfaceIdFromSessionPayload(
    std::wstring const &sessionPayload) noexcept {
  if (auto target = ExtractActiveSessionTargetFromPayload(sessionPayload)) {
    return target->SurfaceId;
  }

  return std::nullopt;
}

std::wstring ResolveActiveSurfaceId(LaunchSurfaceConfig const &launchSurface) noexcept {
  if (auto storedState = ReadSessionState(launchSurface.WindowId)) {
    if (auto activeSurfaceId = ExtractActiveSurfaceIdFromSessionPayload(*storedState)) {
      return *activeSurfaceId;
    }
  }

  return launchSurface.SurfaceId;
}

std::string SerializeCurrentWindowPayload(LaunchSurfaceConfig const &launchSurface) noexcept {
  auto payload = winrt::Windows::Data::Json::JsonObject();
  payload.Insert(L"windowId", winrt::Windows::Data::Json::JsonValue::CreateStringValue(launchSurface.WindowId));
  payload.Insert(L"activeSurfaceId", winrt::Windows::Data::Json::JsonValue::CreateStringValue(ResolveActiveSurfaceId(launchSurface)));
  payload.Insert(L"windowPolicy", winrt::Windows::Data::Json::JsonValue::CreateStringValue(WindowPolicyName(launchSurface.Policy)));
  return ToUtf8(payload.Stringify());
}

void ApplyAppWindowPlacement(
    winrt::Microsoft::UI::Windowing::AppWindow const &appWindow,
    LaunchSurfaceConfig const &launchSurface,
    std::string const &logPrefix) noexcept {
  auto displayArea = winrt::Microsoft::UI::Windowing::DisplayArea::GetFromWindowId(
      appWindow.Id(),
      winrt::Microsoft::UI::Windowing::DisplayAreaFallback::Primary);

  if (!displayArea) {
    appWindow.Resize({1360, 900});
    AppendLog(logPrefix + "=0,0 1360x900 (fallback)");
    return;
  }

  auto workArea = displayArea.WorkArea();
  AppendLog(
      "WorkArea=" + std::to_string(workArea.Width) + "x" + std::to_string(workArea.Height));

  auto metrics = ResolveWindowMetrics(
      workArea.X,
      workArea.Y,
      workArea.Width,
      workArea.Height,
      launchSurface.Policy,
      launchSurface.MetricsMode);

  appWindow.MoveAndResize(
      winrt::Windows::Graphics::RectInt32{metrics.X, metrics.Y, metrics.Width, metrics.Height});
  AppendLog(
      logPrefix + "=" + std::to_string(metrics.X) + "," + std::to_string(metrics.Y) + " " +
      std::to_string(metrics.Width) + "x" + std::to_string(metrics.Height) + " mode=" +
      ToUtf8(launchSurface.MetricsMode));
}

} // namespace

winrt::Microsoft::ReactNative::JSValueArgWriter CreateLaunchProps(
    LaunchSurfaceConfig const &launchSurface,
    std::optional<AutoOpenSurfaceConfig> const &autoOpenSurface) noexcept {
  auto mainDevSmokeScenario =
      launchSurface.WindowId == L"window.main" ? GetMainDevSmokeScenario() : std::nullopt;
  auto mainDevSmokeBaseUrl =
      launchSurface.WindowId == L"window.main" ? GetMainDevSmokeBaseUrl() : std::nullopt;

  return [windowId = launchSurface.WindowId,
          surfaceId = launchSurface.SurfaceId,
          policy = launchSurface.Policy,
          autoOpenSurface,
          mainDevSmokeBaseUrl,
          mainDevSmokeScenario](winrt::Microsoft::ReactNative::IJSValueWriter const &writer) {
    writer.WriteObjectBegin();
    writer.WritePropertyName(L"windowId");
    writer.WriteString(windowId);
    writer.WritePropertyName(L"surfaceId");
    writer.WriteString(surfaceId);
    writer.WritePropertyName(L"windowPolicy");
    writer.WriteString(WindowPolicyName(policy));

    if (auto storedSession = ReadSessionState(windowId)) {
      writer.WritePropertyName(L"initialSessionPayload");
      writer.WriteString(*storedSession);
    }

    if (mainDevSmokeScenario || mainDevSmokeBaseUrl || autoOpenSurface) {
      writer.WritePropertyName(L"initialProps");
      writer.WriteObjectBegin();

      if (mainDevSmokeScenario) {
        writer.WritePropertyName(L"devSmokeScenario");
        writer.WriteString(*mainDevSmokeScenario);
      }

      if (mainDevSmokeBaseUrl) {
        writer.WritePropertyName(L"devSmokeBaseUrl");
        writer.WriteString(*mainDevSmokeBaseUrl);
      }

      if (autoOpenSurface) {
        writer.WritePropertyName(L"autoOpenSurfaceId");
        writer.WriteString(autoOpenSurface->SurfaceId);
        writer.WritePropertyName(L"autoOpenWindowPolicy");
        writer.WriteString(WindowPolicyName(autoOpenSurface->Policy));
        writer.WritePropertyName(L"autoOpenPresentation");
        writer.WriteString(autoOpenSurface->Presentation);
        if (autoOpenSurface->BundleId) {
          writer.WritePropertyName(L"autoOpenBundleId");
          writer.WriteString(*autoOpenSurface->BundleId);
        }

        if (
            autoOpenSurface->DevSmokeScenario ||
            autoOpenSurface->DevSmokeBaseUrl ||
            autoOpenSurface->SmokeSaveMainWindowMode ||
            autoOpenSurface->SmokeSaveSettingsWindowMode ||
            autoOpenSurface->SmokeSaveSettingsPresentation) {
          writer.WritePropertyName(L"autoOpenInitialProps");
          writer.WriteObjectBegin();

          if (autoOpenSurface->DevSmokeScenario) {
            writer.WritePropertyName(L"devSmokeScenario");
            writer.WriteString(*autoOpenSurface->DevSmokeScenario);
          }

          if (autoOpenSurface->DevSmokeBaseUrl) {
            writer.WritePropertyName(L"devSmokeBaseUrl");
            writer.WriteString(*autoOpenSurface->DevSmokeBaseUrl);
          }

          if (autoOpenSurface->SmokeSaveMainWindowMode) {
            writer.WritePropertyName(L"smokeSaveMainWindowMode");
            writer.WriteString(*autoOpenSurface->SmokeSaveMainWindowMode);
          }

          if (autoOpenSurface->SmokeSaveSettingsWindowMode) {
            writer.WritePropertyName(L"smokeSaveSettingsWindowMode");
            writer.WriteString(*autoOpenSurface->SmokeSaveSettingsWindowMode);
          }

          if (autoOpenSurface->SmokeSaveSettingsPresentation) {
            writer.WritePropertyName(L"smokeSaveSettingsPresentation");
            writer.WriteString(*autoOpenSurface->SmokeSaveSettingsPresentation);
          }

          writer.WriteObjectEnd();
        }
      }

      writer.WriteObjectEnd();
    }

    writer.WriteObjectEnd();
  };
}

void InitializeWindowManager(
    winrt::Microsoft::ReactNative::ReactNativeHost const &reactNativeHost,
    std::wstring const &appDirectory,
    bool bundledRuntime) noexcept {
  auto &state = GetWindowManagerState();
  state.ReactNativeHost = reactNativeHost;
  state.AppDirectory = appDirectory;
  state.BundledRuntime = bundledRuntime;
  state.CurrentBundleId = L"opapp.companion.main";
}

std::optional<std::string> GetCurrentManagedWindowPayload() noexcept {
  auto foregroundWindow = GetForegroundWindow();
  if (!foregroundWindow) {
    return std::nullopt;
  }

  auto rootWindow = GetAncestor(foregroundWindow, GA_ROOT);
  auto &state = GetWindowManagerState();

  if (auto mainWindowHandle = TryGetMainWindowHandle(); mainWindowHandle && rootWindow == *mainWindowHandle && state.MainLaunchSurface) {
    return SerializeCurrentWindowPayload(*state.MainLaunchSurface);
  }

  auto iterator = state.HostedWindows.find(rootWindow);
  if (iterator != state.HostedWindows.end() && iterator->second) {
    return SerializeCurrentWindowPayload(iterator->second->LaunchSurface());
  }

  return std::nullopt;
}

bool FocusManagedWindow(std::wstring const &windowId) noexcept {
  auto &state = GetWindowManagerState();

  if (state.MainLaunchSurface && state.MainLaunchSurface->WindowId == windowId) {
    if (auto mainWindowHandle = TryGetMainWindowHandle()) {
      ShowWindow(*mainWindowHandle, IsIconic(*mainWindowHandle) ? SW_RESTORE : SW_SHOW);
      BringWindowToTop(*mainWindowHandle);
      SetForegroundWindow(*mainWindowHandle);
      SetFocus(*mainWindowHandle);
      AppendLog("WindowFocused window=" + ToUtf8(windowId));
      return true;
    }

    return false;
  }

  if (auto window = FindHostedWindowById(windowId)) {
    window->Activate();
    AppendLog("WindowFocused window=" + ToUtf8(windowId));
    return true;
  }

  return false;
}

bool CloseManagedWindow(std::wstring const &windowId) noexcept {
  auto &state = GetWindowManagerState();

  if (state.MainLaunchSurface && state.MainLaunchSurface->WindowId == windowId) {
    if (auto mainWindowHandle = TryGetMainWindowHandle()) {
      AppendLog("WindowCloseRequested window=" + ToUtf8(windowId));
      PostMessageW(*mainWindowHandle, WM_CLOSE, 0, 0);
      return true;
    }

    return false;
  }

  if (auto window = FindHostedWindowById(windowId)) {
    state.PendingSessionCleanupWindowIds.insert(windowId);
    AppendLog("WindowCloseRequested window=" + ToUtf8(windowId));
    PostMessageW(window->Hwnd(), WM_CLOSE, 0, 0);
    return true;
  }

  return false;
}

bool CachedOtaIndexContainsBundle(
    std::wstring const &appDirectory,
    std::wstring const &bundleId) noexcept {
  if (appDirectory.empty() || bundleId.empty()) {
    return false;
  }

  auto indexObject = ReadJsonObjectFile(ResolveOtaCacheRoot(appDirectory) / L"index.json");
  if (!indexObject) {
    return false;
  }

  auto bundlesObject = indexObject->GetNamedObject(L"bundles", nullptr);
  return bundlesObject && bundlesObject.HasKey(winrt::hstring(bundleId));
}

bool CanOpenBundleTarget(std::wstring const &bundleId) noexcept {
  auto &state = GetWindowManagerState();
  if (!state.BundledRuntime) {
    return true;
  }

  auto normalizedBundleId = bundleId;
  if (normalizedBundleId.empty()) {
    normalizedBundleId = L"opapp.companion.main";
  }

  auto bundleRootPath = ResolveBundleRootPath(state, normalizedBundleId);
  if (bundleRootPath) {
    if (normalizedBundleId == L"opapp.companion.main") {
      return true;
    }

    if (ReadBundleManifestEntryFile(*bundleRootPath).has_value()) {
      return true;
    }
  }

  if (normalizedBundleId == L"opapp.companion.main") {
    return true;
  }

  if (GetOtaDisableNativeUpdate() || !GetOtaRemoteUrl()) {
    return false;
  }

  return CachedOtaIndexContainsBundle(state.AppDirectory, normalizedBundleId);
}

std::optional<std::string> GetCachedOtaRemoteCatalogPayload() noexcept {
  auto &state = GetWindowManagerState();
  if (!state.BundledRuntime || state.AppDirectory.empty()) {
    return std::nullopt;
  }

  try {
    auto cacheRoot = ResolveOtaCacheRoot(state.AppDirectory);
    auto indexObject = ReadJsonObjectFile(cacheRoot / L"index.json");
    if (!indexObject) {
      return std::nullopt;
    }

    auto jsonObject = winrt::Windows::Data::Json::JsonObject();
    auto manifestsObject = winrt::Windows::Data::Json::JsonObject();
    auto otaLastRun = ReadOtaLastRunMetadata(state.AppDirectory);
    if (otaLastRun && otaLastRun->RemoteBase && !otaLastRun->RemoteBase->empty()) {
      jsonObject.Insert(
          L"remoteUrl",
          winrt::Windows::Data::Json::JsonValue::CreateStringValue(*otaLastRun->RemoteBase));
    } else {
      jsonObject.Insert(
          L"remoteUrl",
          winrt::Windows::Data::Json::JsonValue::CreateNullValue());
    }

    auto bundlesObject = indexObject->GetNamedObject(L"bundles", nullptr);
    if (bundlesObject) {
      for (auto const &bundleEntry : bundlesObject) {
        auto bundleId = std::wstring(bundleEntry.Key().c_str());
        auto bundleVersionsObject = winrt::Windows::Data::Json::JsonObject();
        auto bundleCacheRoot = cacheRoot / bundleId;
        if (!std::filesystem::exists(bundleCacheRoot) ||
            !std::filesystem::is_directory(bundleCacheRoot)) {
          manifestsObject.Insert(
              winrt::hstring(bundleId),
              winrt::Windows::Data::Json::JsonValue::Parse(bundleVersionsObject.Stringify()));
          continue;
        }

        for (auto const &versionEntry : std::filesystem::directory_iterator(bundleCacheRoot)) {
          if (!versionEntry.is_directory()) {
            continue;
          }

          auto version = versionEntry.path().filename().wstring();
          if (version.empty() || version == L"previous") {
            continue;
          }

          auto manifestObject =
              ReadJsonObjectFile(versionEntry.path() / L"windows" / L"bundle-manifest.json");
          if (!manifestObject) {
            continue;
          }

          bundleVersionsObject.Insert(
              version,
              winrt::Windows::Data::Json::JsonValue::Parse(manifestObject->Stringify()));
        }

        manifestsObject.Insert(
            winrt::hstring(bundleId),
            winrt::Windows::Data::Json::JsonValue::Parse(bundleVersionsObject.Stringify()));
      }
    }

    jsonObject.Insert(
        L"index",
        winrt::Windows::Data::Json::JsonValue::Parse(indexObject->Stringify()));
    jsonObject.Insert(
        L"manifests",
        winrt::Windows::Data::Json::JsonValue::Parse(manifestsObject.Stringify()));
    return ToUtf8(jsonObject.Stringify());
  } catch (...) {
    return std::nullopt;
  }
}

std::optional<std::string> GetBundleUpdateStatusesPayload(
    std::vector<std::wstring> const &bundleIds) noexcept {
  auto &state = GetWindowManagerState();
  if (!state.BundledRuntime || state.AppDirectory.empty()) {
    return std::nullopt;
  }

  try {
    winrt::Windows::Data::Json::JsonArray payload;
    for (auto const &status :
         ResolveBundleUpdateStatuses(state.AppDirectory, bundleIds)) {
      winrt::Windows::Data::Json::JsonObject statusObject;
      statusObject.Insert(
          L"bundleId",
          winrt::Windows::Data::Json::JsonValue::CreateStringValue(status.BundleId));

      auto insertOptionalString = [&](wchar_t const *key, std::optional<std::wstring> const &value) {
        if (value && !value->empty()) {
          statusObject.Insert(
              key,
              winrt::Windows::Data::Json::JsonValue::CreateStringValue(*value));
        } else {
          statusObject.Insert(key, winrt::Windows::Data::Json::JsonValue::CreateNullValue());
        }
      };

      insertOptionalString(L"remoteUrl", status.RemoteUrl);
      insertOptionalString(L"channel", status.Channel);
      insertOptionalString(L"currentVersion", status.CurrentVersion);
      insertOptionalString(L"latestVersion", status.LatestVersion);
      insertOptionalString(L"version", status.Version);
      insertOptionalString(L"previousVersion", status.PreviousVersion);
      insertOptionalString(L"stagedAt", status.StagedAt);
      insertOptionalString(L"recordedAt", status.RecordedAt);
      insertOptionalString(L"errorMessage", status.ErrorMessage);
      statusObject.Insert(
          L"status",
          winrt::Windows::Data::Json::JsonValue::CreateStringValue(status.Status));

      if (status.HasUpdate.has_value()) {
        statusObject.Insert(
            L"hasUpdate",
            winrt::Windows::Data::Json::JsonValue::CreateBooleanValue(*status.HasUpdate));
      } else {
        statusObject.Insert(L"hasUpdate", winrt::Windows::Data::Json::JsonValue::CreateNullValue());
      }

      if (status.InRollout.has_value()) {
        statusObject.Insert(
            L"inRollout",
            winrt::Windows::Data::Json::JsonValue::CreateBooleanValue(*status.InRollout));
      } else {
        statusObject.Insert(L"inRollout", winrt::Windows::Data::Json::JsonValue::CreateNullValue());
      }

      if (status.RolloutPercent.has_value()) {
        statusObject.Insert(
            L"rolloutPercent",
            winrt::Windows::Data::Json::JsonValue::CreateNumberValue(*status.RolloutPercent));
      } else {
        statusObject.Insert(
            L"rolloutPercent",
            winrt::Windows::Data::Json::JsonValue::CreateNullValue());
      }

      if (status.ChannelsJson && !status.ChannelsJson->empty()) {
        statusObject.Insert(
            L"channels",
            winrt::Windows::Data::Json::JsonValue::Parse(winrt::hstring(*status.ChannelsJson)));
      } else {
        statusObject.Insert(L"channels", winrt::Windows::Data::Json::JsonValue::CreateNullValue());
      }

      payload.Append(statusObject);
    }

    return ToUtf8(payload.Stringify());
  } catch (...) {
    return std::nullopt;
  }
}

std::optional<std::string> RunBundleUpdatePayload(
    std::wstring const &bundleId) noexcept {
  auto &state = GetWindowManagerState();
  if (!state.BundledRuntime || state.AppDirectory.empty()) {
    return std::nullopt;
  }

  try {
    auto result = RunBundleUpdateNow(state.AppDirectory, bundleId);
    if (!result) {
      return std::nullopt;
    }

    winrt::Windows::Data::Json::JsonObject payload;
    payload.Insert(
        L"bundleId",
        winrt::Windows::Data::Json::JsonValue::CreateStringValue(result->BundleId));

    auto insertOptionalString = [&](wchar_t const *key, std::optional<std::wstring> const &value) {
      if (value && !value->empty()) {
        payload.Insert(
            key,
            winrt::Windows::Data::Json::JsonValue::CreateStringValue(*value));
      } else {
        payload.Insert(key, winrt::Windows::Data::Json::JsonValue::CreateNullValue());
      }
    };

    insertOptionalString(L"remoteUrl", result->RemoteUrl);
    insertOptionalString(L"channel", result->Channel);
    insertOptionalString(L"currentVersion", result->CurrentVersion);
    insertOptionalString(L"latestVersion", result->LatestVersion);
    insertOptionalString(L"version", result->Version);
    insertOptionalString(L"previousVersion", result->PreviousVersion);
    insertOptionalString(L"stagedAt", result->StagedAt);
    insertOptionalString(L"recordedAt", result->RecordedAt);
    insertOptionalString(L"errorMessage", result->ErrorMessage);
    payload.Insert(
        L"status",
        winrt::Windows::Data::Json::JsonValue::CreateStringValue(result->Status));

    if (result->HasUpdate.has_value()) {
      payload.Insert(
          L"hasUpdate",
          winrt::Windows::Data::Json::JsonValue::CreateBooleanValue(*result->HasUpdate));
    } else {
      payload.Insert(L"hasUpdate", winrt::Windows::Data::Json::JsonValue::CreateNullValue());
    }

    if (result->InRollout.has_value()) {
      payload.Insert(
          L"inRollout",
          winrt::Windows::Data::Json::JsonValue::CreateBooleanValue(*result->InRollout));
    } else {
      payload.Insert(L"inRollout", winrt::Windows::Data::Json::JsonValue::CreateNullValue());
    }

    if (result->RolloutPercent.has_value()) {
      payload.Insert(
          L"rolloutPercent",
          winrt::Windows::Data::Json::JsonValue::CreateNumberValue(*result->RolloutPercent));
    } else {
      payload.Insert(
          L"rolloutPercent",
          winrt::Windows::Data::Json::JsonValue::CreateNullValue());
    }

    if (result->ChannelsJson && !result->ChannelsJson->empty()) {
      payload.Insert(
          L"channels",
          winrt::Windows::Data::Json::JsonValue::Parse(winrt::hstring(*result->ChannelsJson)));
    } else {
      payload.Insert(L"channels", winrt::Windows::Data::Json::JsonValue::CreateNullValue());
    }

    return ToUtf8(payload.Stringify());
  } catch (...) {
    return std::nullopt;
  }
}

std::vector<StagedBundleDescriptor> ListStagedBundles() noexcept {
  std::vector<StagedBundleDescriptor> bundles;
  auto &state = GetWindowManagerState();
  if (!state.BundledRuntime || state.AppDirectory.empty()) {
    return bundles;
  }

  auto otaState = ReadOtaStateMetadata(state.AppDirectory);
  auto otaLastRun = ReadOtaLastRunMetadata(state.AppDirectory);

  try {
    auto bundlesRoot = std::filesystem::path(state.AppDirectory) / L"Bundle" / L"bundles";
    if (!std::filesystem::exists(bundlesRoot) || !std::filesystem::is_directory(bundlesRoot)) {
      return bundles;
    }

    std::set<std::wstring> seenBundleIds;
    for (auto const &entry : std::filesystem::directory_iterator(bundlesRoot)) {
      if (!entry.is_directory()) {
        continue;
      }

      auto bundleRoot = entry.path();
      auto manifest = ReadBundleManifestMetadata(bundleRoot.wstring());
      if (!manifest || !manifest->EntryFile) {
        continue;
      }

      auto fallbackBundleId = bundleRoot.filename().wstring();
      auto resolvedBundleId =
          manifest->BundleId && !manifest->BundleId->empty() ? *manifest->BundleId : fallbackBundleId;
      if (resolvedBundleId.empty() || resolvedBundleId == L"opapp.companion.main") {
        continue;
      }

      if (seenBundleIds.insert(resolvedBundleId).second) {
        std::optional<std::wstring> provenanceKind = L"host-staged-only";
        std::optional<std::wstring> provenanceStatus;
        std::optional<std::wstring> provenanceStagedAt;
        if (otaState && OtaStateMatchesBundle(*otaState, bundleRoot, resolvedBundleId, manifest->Version)) {
          provenanceKind = L"native-ota-applied";
          provenanceStagedAt = otaState->StagedAt;
          if (otaLastRun && OtaLastRunMatchesBundle(*otaLastRun, resolvedBundleId, manifest->Version)) {
            provenanceStatus = otaLastRun->Status;
            if ((!provenanceStagedAt || provenanceStagedAt->empty()) && otaLastRun->StagedAt) {
              provenanceStagedAt = otaLastRun->StagedAt;
            }
          }
        }

        bundles.push_back(StagedBundleDescriptor{
            std::move(resolvedBundleId),
            manifest->Version,
            manifest->SourceKind,
            provenanceKind,
            provenanceStatus,
            provenanceStagedAt,
        });
      }
    }

    std::sort(
        bundles.begin(),
        bundles.end(),
        [](StagedBundleDescriptor const &left, StagedBundleDescriptor const &right) {
          return left.BundleId < right.BundleId;
        });
  } catch (...) {
  }

  return bundles;
}

std::vector<std::wstring> ListStagedBundleIds() noexcept {
  std::vector<std::wstring> bundleIds;
  for (auto const &bundle : ListStagedBundles()) {
    bundleIds.push_back(bundle.BundleId);
  }

  return bundleIds;
}

std::optional<std::string> OpenManagedWindow(LaunchSurfaceConfig const &launchSurface) noexcept {
  auto &state = GetWindowManagerState();
  if (!state.ReactNativeHost) {
    return "Window manager is not initialized.";
  }

  for (auto const &[hwnd, window] : state.HostedWindows) {
    if (window && window->SurfaceId() == launchSurface.SurfaceId) {
      window->Activate();
      AppendLog(
          "SecondaryWindowReused surface=" + ToUtf8(launchSurface.SurfaceId) + " policy=" +
          ToUtf8(launchSurface.Policy) + " mode=" + ToUtf8(launchSurface.MetricsMode));
      return std::nullopt;
    }
  }

  auto window = std::make_shared<HostedSurfaceWindow>(state.ReactNativeHost, launchSurface);
  auto closeWindowId = launchSurface.WindowId;
  window->SetCloseCallback([closeWindowId](HWND hwnd) noexcept {
    auto &managerState = GetWindowManagerState();
    auto iterator = managerState.HostedWindows.find(hwnd);
    if (iterator != managerState.HostedWindows.end()) {
      auto clearPersistedSession = managerState.PendingSessionCleanupWindowIds.erase(closeWindowId) > 0;
      AppendLog("SecondaryWindowClosed hwnd=" + std::to_string(reinterpret_cast<uintptr_t>(hwnd)) + " window=" + ToUtf8(closeWindowId));
      if (clearPersistedSession) {
        DeleteSessionState(closeWindowId);
        AppendLog("SecondaryWindowSessionCleared window=" + ToUtf8(closeWindowId) + " reason=bridge-close");
      }
      managerState.HostedWindows.erase(iterator);
      return;
    }

    managerState.PendingSessionCleanupWindowIds.erase(closeWindowId);
  });

  if (!window->CreateAndShow()) {
    return "Failed to create native window.";
  }

  auto hwnd = window->Hwnd();
  state.HostedWindows.emplace(hwnd, std::move(window));
  AppendLog(
      "SecondaryWindowOpened surface=" + ToUtf8(launchSurface.SurfaceId) + " policy=" +
      ToUtf8(launchSurface.Policy) + " mode=" + ToUtf8(launchSurface.MetricsMode));
  return std::nullopt;
}

std::optional<std::string> SwitchMainWindowToBundle(
    std::wstring const &windowId,
    std::wstring const &bundleId,
    std::wstring const &sessionPayload) noexcept {
  auto &state = GetWindowManagerState();
  if (!state.ReactNativeHost) {
    return "Window manager is not initialized.";
  }

  if (!state.MainLaunchSurface || state.MainLaunchSurface->WindowId != windowId) {
    return "Only the main window supports bundle switching.";
  }

  if (!state.BundledRuntime) {
    return "Bundle switching is only supported in bundled runtime.";
  }

  auto activeTarget = ExtractActiveSessionTargetFromPayload(sessionPayload);
  if (!activeTarget) {
    return "Invalid session payload.";
  }

  auto normalizedBundleId = bundleId.empty() ? std::wstring(L"opapp.companion.main") : bundleId;
  auto bundleRootPath = ResolveBundleRootPath(state, normalizedBundleId);
  auto entryFile = bundleRootPath ? ReadBundleManifestEntryFile(*bundleRootPath) : std::nullopt;
  if (normalizedBundleId != L"opapp.companion.main" && (!bundleRootPath || !entryFile)) {
    AppendLog(
        "BundleSwitchRemoteHydration.Start window=" + ToUtf8(windowId) +
        " bundle=" + ToUtf8(normalizedBundleId));
    if (!EnsureRemoteBundleAvailable(state.AppDirectory, normalizedBundleId)) {
      return "Unable to hydrate the target bundle from remote.";
    }

    bundleRootPath = ResolveBundleRootPath(state, normalizedBundleId);
    entryFile = bundleRootPath ? ReadBundleManifestEntryFile(*bundleRootPath) : std::nullopt;
  }

  if (!bundleRootPath) {
    return "Unable to resolve the target bundle root.";
  }

  if (!entryFile && normalizedBundleId != L"opapp.companion.main") {
    return "Target bundle manifest is missing the entry file.";
  }

  if (!WriteSessionState(windowId, sessionPayload)) {
    return "Failed to persist the target window session.";
  }

  state.MainLaunchSurface->SurfaceId = activeTarget->SurfaceId;
  state.MainLaunchSurface->Policy = activeTarget->Policy;
  state.MainLaunchSurface->MetricsMode =
      ResolveWindowSizeMode(activeTarget->Policy, LoadWindowPreferences());
  state.CurrentBundleId = normalizedBundleId;

  if (state.MainAppWindow) {
    state.MainAppWindow.Title(GetWindowTitle(*state.MainLaunchSurface));
    ApplyAppWindowPlacement(state.MainAppWindow, *state.MainLaunchSurface, "WindowRectUpdated");
  }

  auto instanceSettings = state.ReactNativeHost.InstanceSettings();
  auto jsBundleFile = entryFile.value_or(L"index.windows");
  instanceSettings.BundleRootPath(bundleRootPath->c_str());
  instanceSettings.JavaScriptBundleFile(jsBundleFile.c_str());

  AppendLog(
      "BundleSwitchPrepared window=" + ToUtf8(windowId) + " bundle=" + ToUtf8(state.CurrentBundleId) +
      " surface=" + ToUtf8(activeTarget->SurfaceId) + " policy=" + ToUtf8(activeTarget->Policy) +
      " root=" + ToUtf8(*bundleRootPath) + " file=" + ToUtf8(jsBundleFile));

  state.ReactNativeHost.ReloadInstance();
  AppendLog(
      "BundleSwitchReloadRequested window=" + ToUtf8(windowId) + " bundle=" + ToUtf8(state.CurrentBundleId));
  return std::nullopt;
}

std::optional<std::string> QueueManagedWindowOpen(
    winrt::Microsoft::ReactNative::IReactDispatcher const &uiDispatcher,
    LaunchSurfaceConfig const &launchSurface) noexcept {
  if (!uiDispatcher) {
    return "Window dispatcher is not initialized.";
  }

  uiDispatcher.Post([launchSurface]() noexcept {
    if (auto error = OpenManagedWindow(launchSurface)) {
      AppendLog(
          "SecondaryWindowOpenFailed surface=" + ToUtf8(launchSurface.SurfaceId) + " reason=" + *error);
    }
  });

  AppendLog(
      "SecondaryWindowQueued surface=" + ToUtf8(launchSurface.SurfaceId) + " policy=" +
      ToUtf8(launchSurface.Policy) + " mode=" + ToUtf8(launchSurface.MetricsMode));
  return std::nullopt;
}

std::vector<LaunchSurfaceConfig> LoadRestorableSecondarySurfaces(
    std::optional<LaunchSurfaceConfig> const &startupSecondarySurface) noexcept {
  std::vector<LaunchSurfaceConfig> launchSurfaces;
  std::set<std::wstring> seenSurfaceIds;

  if (startupSecondarySurface) {
    seenSurfaceIds.insert(startupSecondarySurface->SurfaceId);
  }

  for (auto const &windowId : ReadStoredSessionWindowIds()) {
    if (windowId.rfind(L"window.secondary.", 0) != 0) {
      continue;
    }

    auto storedState = ReadSessionState(windowId);
    if (!storedState) {
      DeleteSessionState(windowId);
      continue;
    }

    auto target = ExtractActiveSessionTargetFromPayload(*storedState);
    if (!target) {
      DeleteSessionState(windowId);
      AppendLog("RestoredSecondaryWindowDiscarded window=" + ToUtf8(windowId) + " reason=invalid-session");
      continue;
    }

    if (!seenSurfaceIds.insert(target->SurfaceId).second) {
      continue;
    }

    auto launchSurface = BuildLaunchSurface(target->SurfaceId, target->Policy, windowId);
    AppendLog(
        "RestoredSecondaryWindowScheduled window=" + ToUtf8(windowId) + " surface=" +
        ToUtf8(launchSurface.SurfaceId) + " policy=" + ToUtf8(launchSurface.Policy) + " mode=" +
        ToUtf8(launchSurface.MetricsMode));
    launchSurfaces.push_back(std::move(launchSurface));
  }

  return launchSurfaces;
}

void ConfigureInitialWindow(
    winrt::Microsoft::ReactNative::ReactNativeWin32App const &reactNativeWin32App,
    LaunchSurfaceConfig const &launchSurface) noexcept {
  auto appWindow{reactNativeWin32App.AppWindow()};
  appWindow.Title(GetWindowTitle(launchSurface));

  auto &state = GetWindowManagerState();
  state.MainAppWindow = appWindow;
  state.MainLaunchSurface = launchSurface;
  EnsureMainWindowDiagnosticsHook();

  ApplyAppWindowPlacement(appWindow, launchSurface, "WindowRect");
}

bool ApplySavedPreferencesToCurrentWindow(
    std::wstring const &currentWindowId,
    WindowPreferences const &preferences) noexcept {
  if (currentWindowId.empty()) {
    return false;
  }

  auto &state = GetWindowManagerState();

  if (state.MainLaunchSurface && state.MainLaunchSurface->WindowId == currentWindowId && state.MainAppWindow) {
    state.MainLaunchSurface->MetricsMode =
        ResolveWindowSizeMode(state.MainLaunchSurface->Policy, preferences);
    ApplyAppWindowPlacement(state.MainAppWindow, *state.MainLaunchSurface, "WindowRectUpdated");
    AppendLog(
        "WindowPreferencesApplied window=" + ToUtf8(currentWindowId) + " mode=" +
        ToUtf8(state.MainLaunchSurface->MetricsMode));
    return true;
  }

  for (auto const &[hwnd, window] : state.HostedWindows) {
    if (!window || window->WindowId() != currentWindowId) {
      continue;
    }

    auto nextMode = ResolveWindowSizeMode(window->Policy(), preferences);
    window->ApplyMetricsMode(nextMode);
    AppendLog(
        "WindowPreferencesApplied window=" + ToUtf8(currentWindowId) + " mode=" + ToUtf8(nextMode));
    return true;
  }

  return false;
}

} // namespace OpappWindowsHost

