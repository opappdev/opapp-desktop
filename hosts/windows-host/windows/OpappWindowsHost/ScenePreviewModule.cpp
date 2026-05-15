#include "pch.h"
#include "HostCore.h"
#include "ScenePreviewWindow.h"

#include "NativeModules.h"

#include <atomic>
#include <filesystem>
#include <thread>

namespace {

constexpr wchar_t kDefaultTamaScenePreviewRelativePath[] =
    L"opapp-frontend\\apps\\companion-app\\.private-companion\\runtime\\TKunimiSwim2024\\preview\\scene-preview.json";

std::optional<std::filesystem::path> ExistingPreviewPath(std::filesystem::path const &path) noexcept {
  try {
    if (!path.empty() && std::filesystem::exists(path) && std::filesystem::is_regular_file(path)) {
      return path;
    }
  } catch (...) {
  }

  return std::nullopt;
}

std::optional<std::filesystem::path> FindPreviewFromSeed(std::filesystem::path seed) noexcept {
  try {
    if (seed.empty()) {
      return std::nullopt;
    }

    if (std::filesystem::is_regular_file(seed)) {
      seed = seed.parent_path();
    }

    for (auto current = seed; !current.empty(); current = current.parent_path()) {
      if (auto previewPath = ExistingPreviewPath(current / kDefaultTamaScenePreviewRelativePath)) {
        return previewPath;
      }

      auto parent = current.parent_path();
      if (parent == current) {
        break;
      }
    }
  } catch (...) {
  }

  return std::nullopt;
}

std::optional<std::filesystem::path> ResolveDefaultScenePreviewPath() noexcept {
  if (auto configuredPreviewFile = OpappWindowsHost::GetScenePreviewFile()) {
    if (auto previewPath = ExistingPreviewPath(*configuredPreviewFile)) {
      return previewPath;
    }
  }

  try {
    if (auto previewPath = FindPreviewFromSeed(std::filesystem::current_path())) {
      return previewPath;
    }
  } catch (...) {
  }

  try {
    WCHAR appPath[MAX_PATH];
    auto length = GetModuleFileNameW(nullptr, appPath, MAX_PATH);
    if (length > 0 && length < MAX_PATH) {
      if (auto previewPath = FindPreviewFromSeed(std::filesystem::path(appPath))) {
        return previewPath;
      }
    }
  } catch (...) {
  }

  return std::nullopt;
}

std::atomic<uint32_t> g_scenePreviewLaunchId{0};

} // namespace

namespace OpappWindowsHostModules {

REACT_MODULE(OpappScenePreviewModule, L"OpappScenePreview")
struct OpappScenePreviewModule {
  REACT_METHOD(GetDefaultPreviewFile, L"getDefaultPreviewFile")
  void GetDefaultPreviewFile(
      winrt::Microsoft::ReactNative::ReactPromise<std::string> &&result) noexcept {
    auto previewPath = ResolveDefaultScenePreviewPath();
    result.Resolve(previewPath ? OpappWindowsHost::ToUtf8(previewPath->wstring()) : std::string{});
  }

  REACT_METHOD(OpenPreview, L"openPreview")
  void OpenPreview(
      std::string previewFile,
      winrt::Microsoft::ReactNative::ReactPromise<std::string> &&result) noexcept {
    auto previewPath = std::filesystem::path(std::wstring(winrt::to_hstring(previewFile))).lexically_normal();
    if (previewPath.empty()) {
      result.Reject(L"Scene preview file is required.");
      return;
    }

    if (!ExistingPreviewPath(previewPath)) {
      result.Reject(L"Scene preview file does not exist.");
      return;
    }

    auto launchId = g_scenePreviewLaunchId.fetch_add(1, std::memory_order_relaxed) + 1;
    auto launchLabel = std::string("scene-preview-") + std::to_string(launchId);

    try {
      std::thread([previewPath, launchLabel]() noexcept {
        OpappWindowsHost::AppendLog(
            "ScenePreview.Module.Start id=" + launchLabel + " file=" + OpappWindowsHost::ToUtf8(previewPath.wstring()));
        if (auto error = OpappWindowsHost::RunScenePreviewWindow(previewPath.wstring())) {
          OpappWindowsHost::AppendLog("ScenePreview.Module.Failed id=" + launchLabel + " reason=" + *error);
          return;
        }

        OpappWindowsHost::AppendLog("ScenePreview.Module.Done id=" + launchLabel);
      }).detach();
    } catch (...) {
      result.Reject(L"Failed to launch scene preview window.");
      return;
    }

    result.Resolve(launchLabel);
  }
};

} // namespace OpappWindowsHostModules
