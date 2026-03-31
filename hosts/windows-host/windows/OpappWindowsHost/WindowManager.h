#pragma once

#include <optional>
#include <string>
#include <vector>

#include <winrt/Microsoft.ReactNative.h>
#include <winrt/Microsoft.UI.Windowing.h>

#include "HostCore.h"

namespace OpappWindowsHost {

struct StagedBundleDescriptor {
  std::wstring BundleId;
  std::optional<std::wstring> Version;
  std::optional<std::wstring> SourceKind;
  std::optional<std::wstring> ProvenanceKind;
  std::optional<std::wstring> ProvenanceStatus;
  std::optional<std::wstring> ProvenanceStagedAt;
};

winrt::Microsoft::ReactNative::JSValueArgWriter CreateLaunchProps(
    LaunchSurfaceConfig const &launchSurface,
    std::optional<AutoOpenSurfaceConfig> const &autoOpenSurface = std::nullopt) noexcept;

void InitializeWindowManager(
    winrt::Microsoft::ReactNative::ReactNativeHost const &reactNativeHost,
    std::wstring const &appDirectory,
    bool bundledRuntime) noexcept;
std::optional<std::string> GetCurrentManagedWindowPayload() noexcept;
bool FocusManagedWindow(std::wstring const &windowId) noexcept;
bool CloseManagedWindow(std::wstring const &windowId) noexcept;
bool CanOpenBundleTarget(std::wstring const &bundleId) noexcept;
std::optional<std::string> GetCachedOtaRemoteCatalogPayload() noexcept;
std::optional<std::string> GetBundleUpdateStatusesPayload(
    std::vector<std::wstring> const &bundleIds = {}) noexcept;
std::optional<std::string> RunBundleUpdatePayload(
    std::wstring const &bundleId) noexcept;
std::vector<StagedBundleDescriptor> ListStagedBundles() noexcept;
std::vector<std::wstring> ListStagedBundleIds() noexcept;
std::optional<std::string> OpenManagedWindow(LaunchSurfaceConfig const &launchSurface) noexcept;
std::optional<std::string> SwitchMainWindowToBundle(
    std::wstring const &windowId,
    std::wstring const &bundleId,
    std::wstring const &sessionPayload) noexcept;
std::optional<std::string> QueueManagedWindowOpen(
    winrt::Microsoft::ReactNative::IReactDispatcher const &uiDispatcher,
    LaunchSurfaceConfig const &launchSurface) noexcept;
std::vector<LaunchSurfaceConfig> LoadRestorableSecondarySurfaces(
    std::optional<LaunchSurfaceConfig> const &startupSecondarySurface = std::nullopt) noexcept;
void ConfigureInitialWindow(
    winrt::Microsoft::ReactNative::ReactNativeWin32App const &reactNativeWin32App,
    LaunchSurfaceConfig const &launchSurface) noexcept;
bool ApplySavedPreferencesToCurrentWindow(
    std::wstring const &currentWindowId,
    WindowPreferences const &preferences) noexcept;

} // namespace OpappWindowsHost
