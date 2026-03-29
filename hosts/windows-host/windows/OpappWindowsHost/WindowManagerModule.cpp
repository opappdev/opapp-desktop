#include "pch.h"
#include "WindowManager.h"

#include "NativeModules.h"
#include <winrt/Windows.Data.Json.h>

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

  REACT_METHOD(CanOpenBundle, L"canOpenBundle")
  void CanOpenBundle(
      std::string bundleId,
      winrt::Microsoft::ReactNative::ReactPromise<bool> &&result) noexcept {
    result.Resolve(
        OpappWindowsHost::CanOpenBundleTarget(
            std::wstring(winrt::to_hstring(bundleId))));
  }

  REACT_METHOD(GetOtaRemoteUrl, L"getOtaRemoteUrl")
  void GetOtaRemoteUrl(
      winrt::Microsoft::ReactNative::ReactPromise<std::string> &&result) noexcept {
    auto otaRemoteUrl = OpappWindowsHost::GetOtaRemoteUrl();
    result.Resolve(otaRemoteUrl ? OpappWindowsHost::ToUtf8(*otaRemoteUrl) : std::string{});
  }

  REACT_METHOD(GetStagedBundles, L"getStagedBundles")
  void GetStagedBundles(
      winrt::Microsoft::ReactNative::ReactPromise<std::string> &&result) noexcept {
    winrt::Windows::Data::Json::JsonArray payload;
    for (auto const &bundle : OpappWindowsHost::ListStagedBundles()) {
      winrt::Windows::Data::Json::JsonObject bundlePayload;
      bundlePayload.Insert(
          L"bundleId",
          winrt::Windows::Data::Json::JsonValue::CreateStringValue(bundle.BundleId));
      if (bundle.Version && !bundle.Version->empty()) {
        bundlePayload.Insert(
            L"version",
            winrt::Windows::Data::Json::JsonValue::CreateStringValue(*bundle.Version));
      } else {
        bundlePayload.Insert(L"version", winrt::Windows::Data::Json::JsonValue::CreateNullValue());
      }

      if (bundle.SourceKind && !bundle.SourceKind->empty()) {
        bundlePayload.Insert(
            L"sourceKind",
            winrt::Windows::Data::Json::JsonValue::CreateStringValue(*bundle.SourceKind));
      } else {
        bundlePayload.Insert(L"sourceKind", winrt::Windows::Data::Json::JsonValue::CreateNullValue());
      }

      payload.Append(bundlePayload);
    }

    result.Resolve(OpappWindowsHost::ToUtf8(payload.Stringify()));
  }

  REACT_METHOD(GetStagedBundleIds, L"getStagedBundleIds")
  void GetStagedBundleIds(
      winrt::Microsoft::ReactNative::ReactPromise<std::string> &&result) noexcept {
    winrt::Windows::Data::Json::JsonArray payload;
    for (auto const &bundleId : OpappWindowsHost::ListStagedBundleIds()) {
      payload.Append(winrt::Windows::Data::Json::JsonValue::CreateStringValue(bundleId));
    }

    result.Resolve(OpappWindowsHost::ToUtf8(payload.Stringify()));
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

  REACT_METHOD(GetStartupTargetPreference, L"getStartupTargetPreference")
  void GetStartupTargetPreference(
      winrt::Microsoft::ReactNative::ReactPromise<std::string> &&result) noexcept {
    result.Resolve(
        OpappWindowsHost::SerializeStartupTargetPreference(
            OpappWindowsHost::LoadStartupTargetPreference()));
  }

  REACT_METHOD(SetStartupTargetPreference, L"setStartupTargetPreference")
  void SetStartupTargetPreference(
      std::string surfaceId,
      std::string bundleId,
      std::string windowPolicy,
      std::string presentation,
      winrt::Microsoft::ReactNative::ReactPromise<std::string> &&result) noexcept {
    if (surfaceId.empty()) {
      result.Reject(L"Startup target surface id is required.");
      return;
    }

    if (bundleId.empty()) {
      result.Reject(L"Startup target bundle id is required.");
      return;
    }

    auto parsedPolicy = OpappWindowsHost::ParseWindowPolicy(windowPolicy);
    if (!parsedPolicy) {
      result.Reject(L"Unsupported startup target window policy.");
      return;
    }

    auto normalizedPresentation = OpappWindowsHost::NormalizeStartupTargetPresentation(
        std::wstring(winrt::to_hstring(presentation)));

    OpappWindowsHost::StartupTargetPreference preference{
        std::wstring(winrt::to_hstring(surfaceId)),
        std::wstring(winrt::to_hstring(bundleId)),
        parsedPolicy->Policy,
        normalizedPresentation,
    };

    if (!OpappWindowsHost::SaveStartupTargetPreference(preference)) {
      result.Reject(L"Failed to save startup target preference.");
      return;
    }

    result.Resolve(
        OpappWindowsHost::SerializeStartupTargetPreference(preference));
  }

  REACT_METHOD(ClearStartupTargetPreference, L"clearStartupTargetPreference")
  void ClearStartupTargetPreference(
      winrt::Microsoft::ReactNative::ReactPromise<void> &&result) noexcept {
    if (!OpappWindowsHost::DeleteStartupTargetPreference()) {
      result.Reject(L"Failed to clear startup target preference.");
      return;
    }

    result.Resolve();
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

  REACT_METHOD(SwitchCurrentWindowBundle, L"switchCurrentWindowBundle")
  void SwitchCurrentWindowBundle(
      std::string windowId,
      std::string bundleId,
      std::string sessionPayload,
      winrt::Microsoft::ReactNative::ReactPromise<void> &&result) noexcept {
    auto reactContext = m_reactContext;
    auto targetWindowId = std::wstring(winrt::to_hstring(windowId));
    auto targetBundleId = std::wstring(winrt::to_hstring(bundleId));
    auto targetSessionPayload = std::wstring(winrt::to_hstring(sessionPayload));

    reactContext.UIDispatcher().Post([targetWindowId,
                                      targetBundleId,
                                      targetSessionPayload,
                                      result = std::move(result)]() mutable {
      auto error = OpappWindowsHost::SwitchMainWindowToBundle(
          targetWindowId,
          targetBundleId,
          targetSessionPayload);
      if (error) {
        result.Reject(winrt::to_hstring(*error).c_str());
        return;
      }

      result.Resolve();
    });
  }

  REACT_METHOD(GetDiagnosticsLogPath, L"getDiagnosticsLogPath")
  void GetDiagnosticsLogPath(
      winrt::Microsoft::ReactNative::ReactPromise<std::string> &&result) noexcept {
    result.Resolve(OpappWindowsHost::GetHostLogPath());
  }

  REACT_METHOD(GetDiagnosticsLogTail, L"getDiagnosticsLogTail")
  void GetDiagnosticsLogTail(
      int64_t maxLines,
      winrt::Microsoft::ReactNative::ReactPromise<std::string> &&result) noexcept {
    std::size_t resolvedMaxLines = 120;
    if (maxLines > 0) {
      resolvedMaxLines = static_cast<std::size_t>(maxLines > 1000 ? 1000 : maxLines);
    }

    result.Resolve(OpappWindowsHost::ReadLogTail(resolvedMaxLines));
  }

 private:
  winrt::Microsoft::ReactNative::ReactContext m_reactContext;
};

} // namespace OpappWindowsHostModules
