#include "pch.h"
#include "WindowManager.h"

#include "NativeModules.h"

namespace OpappWindowsHostModules {

REACT_MODULE(OpappWindowManagerModule, L"OpappWindowManager")
struct OpappWindowManagerModule {
  REACT_INIT(Initialize)
  void Initialize(winrt::Microsoft::ReactNative::ReactContext const &reactContext) noexcept {
    m_reactContext = reactContext;
  }

  REACT_METHOD(OpenWindow, L"openWindow")
  void OpenWindow(
      std::string surfaceId,
      std::string windowPolicy,
      winrt::Microsoft::ReactNative::ReactPromise<std::string> &&result) noexcept {
    auto parsedPolicy = OpappWindowsHost::ParseWindowPolicy(windowPolicy);
    if (!parsedPolicy) {
      result.Reject(L"Unsupported window policy.");
      return;
    }

    auto reactContext = m_reactContext;
    auto launchSurface = OpappWindowsHost::BuildLaunchSurface(
        std::wstring(winrt::to_hstring(surfaceId)),
        parsedPolicy->Policy,
        OpappWindowsHost::BuildDynamicWindowId(),
        parsedPolicy->ModeOverride);

    reactContext.UIDispatcher().Post([launchSurface, result = std::move(result)]() mutable {
      auto error = OpappWindowsHost::OpenManagedWindow(launchSurface);
      if (error) {
        result.Reject(winrt::to_hstring(*error).c_str());
        return;
      }

      result.Resolve(OpappWindowsHost::ToUtf8(launchSurface.WindowId));
    });
  }

  REACT_METHOD(FocusWindow, L"focusWindow")
  void FocusWindow(
      std::string windowId,
      winrt::Microsoft::ReactNative::ReactPromise<void> &&result) noexcept {
    auto reactContext = m_reactContext;
    auto targetWindowId = std::wstring(winrt::to_hstring(windowId));

    reactContext.UIDispatcher().Post([targetWindowId, result = std::move(result)]() mutable {
      if (!OpappWindowsHost::FocusManagedWindow(targetWindowId)) {
        result.Reject(L"Unable to focus the requested window.");
        return;
      }

      result.Resolve();
    });
  }

  REACT_METHOD(CloseWindow, L"closeWindow")
  void CloseWindow(
      std::string windowId,
      winrt::Microsoft::ReactNative::ReactPromise<void> &&result) noexcept {
    auto reactContext = m_reactContext;
    auto targetWindowId = std::wstring(winrt::to_hstring(windowId));

    reactContext.UIDispatcher().Post([targetWindowId, result = std::move(result)]() mutable {
      if (!OpappWindowsHost::CloseManagedWindow(targetWindowId)) {
        result.Reject(L"Unable to close the requested window.");
        return;
      }

      result.Resolve();
    });
  }

  REACT_METHOD(GetCurrentWindow, L"getCurrentWindow")
  void GetCurrentWindow(winrt::Microsoft::ReactNative::ReactPromise<std::string> &&result) noexcept {
    auto currentWindow = OpappWindowsHost::GetCurrentManagedWindowPayload();
    result.Resolve(currentWindow ? *currentWindow : std::string{});
  }

  REACT_METHOD(GetWindowSession, L"getWindowSession")
  void GetWindowSession(
      std::string windowId,
      winrt::Microsoft::ReactNative::ReactPromise<std::string> &&result) noexcept {
    auto storedState = OpappWindowsHost::ReadSessionState(std::wstring(winrt::to_hstring(windowId)));
    result.Resolve(storedState ? OpappWindowsHost::ToUtf8(*storedState) : std::string{});
  }

  REACT_METHOD(GetWindowPreferences, L"getWindowPreferences")
  void GetWindowPreferences(winrt::Microsoft::ReactNative::ReactPromise<std::string> &&result) noexcept {
    result.Resolve(OpappWindowsHost::SerializeWindowPreferences(OpappWindowsHost::LoadWindowPreferences()));
  }

  REACT_METHOD(SetWindowPreferences, L"setWindowPreferences")
  void SetWindowPreferences(
      std::string mainWindowMode,
      std::string settingsWindowMode,
      std::string settingsPresentation,
      std::string currentWindowId,
      winrt::Microsoft::ReactNative::ReactPromise<std::string> &&result) noexcept {
    auto parsedMainWindowMode = OpappWindowsHost::ParseWindowSizeMode(mainWindowMode);
    if (!parsedMainWindowMode) {
      result.Reject(L"Unsupported main window mode.");
      return;
    }

    auto parsedSettingsWindowMode = OpappWindowsHost::ParseWindowSizeMode(settingsWindowMode);
    if (!parsedSettingsWindowMode) {
      result.Reject(L"Unsupported settings window mode.");
      return;
    }

    auto normalizedSettingsPresentation =
        OpappWindowsHost::NormalizeSettingsPresentation(std::wstring(winrt::to_hstring(settingsPresentation)));

    OpappWindowsHost::WindowPreferences preferences{
        *parsedMainWindowMode,
        *parsedSettingsWindowMode,
        normalizedSettingsPresentation,
    };

    if (!OpappWindowsHost::SaveWindowPreferences(preferences)) {
      result.Reject(L"Failed to save window preferences.");
      return;
    }

    OpappWindowsHost::ApplySavedPreferencesToCurrentWindow(std::wstring(winrt::to_hstring(currentWindowId)), preferences);
    result.Resolve(OpappWindowsHost::SerializeWindowPreferences(preferences));
  }

  REACT_METHOD(GetWindowSessionState, L"getWindowSessionState")
  void GetWindowSessionState(
      std::string windowId,
      winrt::Microsoft::ReactNative::ReactPromise<std::string> &&result) noexcept {
    auto storedState = OpappWindowsHost::ReadSessionState(std::wstring(winrt::to_hstring(windowId)));
    result.Resolve(storedState ? OpappWindowsHost::ToUtf8(*storedState) : std::string{});
  }

  REACT_METHOD(SetWindowSessionState, L"setWindowSessionState")
  void SetWindowSessionState(
      std::string windowId,
      std::string sessionPayload,
      winrt::Microsoft::ReactNative::ReactPromise<void> &&result) noexcept {
    if (!OpappWindowsHost::WriteSessionState(
            std::wstring(winrt::to_hstring(windowId)),
            std::wstring(winrt::to_hstring(sessionPayload)))) {
      result.Reject(L"Failed to save window session state.");
      return;
    }

    result.Resolve();
  }

 private:
  winrt::Microsoft::ReactNative::ReactContext m_reactContext;
};

} // namespace OpappWindowsHostModules
