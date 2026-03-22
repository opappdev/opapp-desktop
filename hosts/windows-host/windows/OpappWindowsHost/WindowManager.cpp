#include "pch.h"
#include "WindowManager.h"
#include "NativeModules.h"

#include <functional>
#include <map>
#include <memory>
#include <set>

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
  std::map<HWND, std::shared_ptr<HostedSurfaceWindow>> HostedWindows;
  std::set<std::wstring> PendingSessionCleanupWindowIds;
};

WindowManagerState &GetWindowManagerState() noexcept {
  static WindowManagerState state{};
  return state;
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
  return [windowId = launchSurface.WindowId,
          surfaceId = launchSurface.SurfaceId,
          policy = launchSurface.Policy,
          autoOpenSurface](winrt::Microsoft::ReactNative::IJSValueWriter const &writer) {
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
    if (autoOpenSurface) {
      writer.WritePropertyName(L"initialProps");
      writer.WriteObjectBegin();
      writer.WritePropertyName(L"autoOpenSurfaceId");
      writer.WriteString(autoOpenSurface->SurfaceId);
      writer.WritePropertyName(L"autoOpenWindowPolicy");
      writer.WriteString(WindowPolicyName(autoOpenSurface->Policy));
      writer.WritePropertyName(L"autoOpenPresentation");
      writer.WriteString(autoOpenSurface->Presentation);

      if (
          autoOpenSurface->SmokeSaveMainWindowMode ||
          autoOpenSurface->SmokeSaveSettingsWindowMode ||
          autoOpenSurface->SmokeSaveSettingsPresentation) {
        writer.WritePropertyName(L"autoOpenInitialProps");
        writer.WriteObjectBegin();

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

      writer.WriteObjectEnd();
    }

    writer.WriteObjectEnd();
  };
}

void InitializeWindowManager(winrt::Microsoft::ReactNative::ReactNativeHost const &reactNativeHost) noexcept {
  auto &state = GetWindowManagerState();
  state.ReactNativeHost = reactNativeHost;
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

