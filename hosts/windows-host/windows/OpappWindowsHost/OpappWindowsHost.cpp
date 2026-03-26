// OpappWindowsHost.cpp : Defines the entry point for the application.
//

#include "pch.h"
#include "OpappWindowsHost.h"
#include "HostCore.h"
#include "WindowManager.h"

#include <MddBootstrap.h>
#include <WindowsAppSDK-VersionInfo.h>

#include "AutolinkedNativeModules.g.h"
#include "NativeModules.h"

#include <filesystem>
#include <fstream>
#include <winrt/Windows.Data.Json.h>

using namespace OpappWindowsHost;

namespace {

// Reads bundle-manifest.json from bundleRoot and returns the entryFile field
// with the ".bundle" suffix stripped (e.g. "index.windows.bundle" -> "index.windows"),
// or nullopt if the manifest cannot be read or parsed.
std::optional<std::wstring> ReadBundleManifestEntryFile(std::wstring const &bundleRoot) noexcept {
  try {
    auto manifestPath = std::filesystem::path(bundleRoot) / L"bundle-manifest.json";
    std::ifstream stream(manifestPath, std::ios::binary);
    if (!stream.is_open()) {
      return std::nullopt;
    }

    std::string contents((std::istreambuf_iterator<char>(stream)), std::istreambuf_iterator<char>());

    auto jsonObject = winrt::Windows::Data::Json::JsonObject::Parse(winrt::to_hstring(contents));
    auto entryFileHstr = jsonObject.GetNamedString(L"entryFile");
    std::wstring entryFile(entryFileHstr.c_str(), entryFileHstr.size());

    constexpr std::wstring_view kBundleSuffix = L".bundle";
    if (entryFile.size() > kBundleSuffix.size() &&
        entryFile.substr(entryFile.size() - kBundleSuffix.size()) == kBundleSuffix) {
      entryFile = entryFile.substr(0, entryFile.size() - kBundleSuffix.size());
    }

    if (entryFile.empty()) {
      return std::nullopt;
    }

    return entryFile;
  } catch (...) {
    return std::nullopt;
  }
}

void LogRedBoxError(std::string const &phase, winrt::Microsoft::ReactNative::IRedBoxErrorInfo const &info) noexcept {
  AppendLog(phase + ".Message=" + ToUtf8(info.Message()));
  AppendLog(phase + ".OriginalMessage=" + ToUtf8(info.OriginalMessage()));
  AppendLog(phase + ".Name=" + ToUtf8(info.Name()));
  AppendLog(phase + ".ComponentStack=" + ToUtf8(info.ComponentStack()));

  auto frames = info.Callstack();
  for (uint32_t i = 0; i < frames.Size(); ++i) {
    auto frame = frames.GetAt(i);
    AppendLog(
        phase + ".Frame[" + std::to_string(i) + "]=" + ToUtf8(frame.Method()) + " @ " + ToUtf8(frame.File()) +
        ":" + std::to_string(frame.Line()) + ":" + std::to_string(frame.Column()));
  }
}

struct WindowsAppRuntimeBootstrap {
  HMODULE Module{nullptr};
  decltype(&MddBootstrapShutdown) Shutdown{nullptr};
  bool Initialized{false};

  ~WindowsAppRuntimeBootstrap() noexcept {
    if (Initialized && Shutdown) {
      Shutdown();
      AppendLog("WinMain.BootstrapShutdown.Done");
    }

    if (Module) {
      FreeLibrary(Module);
    }
  }
};

bool HasPackageIdentity() noexcept {
  UINT32 packageFullNameLength = 0;
  auto result = GetCurrentPackageFullName(&packageFullNameLength, nullptr);
  return result != APPMODEL_ERROR_NO_PACKAGE;
}

WindowsAppRuntimeBootstrap InitializeWindowsAppRuntimeBootstrap() {
  AppendLog("WinMain.BootstrapInitialize");

  if (HasPackageIdentity()) {
    AppendLog("WinMain.BootstrapInitialize.SkipPackageIdentity");
    return {};
  }

  auto bootstrapModule = LoadLibraryW(L"Microsoft.WindowsAppRuntime.Bootstrap.dll");
  if (!bootstrapModule) {
    throw winrt::hresult_error(
        HRESULT_FROM_WIN32(GetLastError()),
        L"LoadLibrary(Microsoft.WindowsAppRuntime.Bootstrap.dll) failed");
  }

  auto initialize = reinterpret_cast<decltype(&MddBootstrapInitialize2)>(
      GetProcAddress(bootstrapModule, "MddBootstrapInitialize2"));
  auto shutdown =
      reinterpret_cast<decltype(&MddBootstrapShutdown)>(GetProcAddress(bootstrapModule, "MddBootstrapShutdown"));
  if (!initialize || !shutdown) {
    auto error = GetLastError();
    FreeLibrary(bootstrapModule);
    throw winrt::hresult_error(
        HRESULT_FROM_WIN32(error == 0 ? ERROR_PROC_NOT_FOUND : error),
        L"GetProcAddress(MddBootstrap*) failed");
  }

  PACKAGE_VERSION minVersion{};
  minVersion.Version = WINDOWSAPPSDK_RUNTIME_VERSION_UINT64;
  auto hr = initialize(
      WINDOWSAPPSDK_RELEASE_MAJORMINOR,
      WINDOWSAPPSDK_RELEASE_VERSION_TAG_W,
      minVersion,
      MddBootstrapInitializeOptions_None);
  if (FAILED(hr)) {
    FreeLibrary(bootstrapModule);
    throw winrt::hresult_error(hr, L"MddBootstrapInitialize2 failed");
  }

  AppendLog("WinMain.BootstrapInitialize.Done");
  return WindowsAppRuntimeBootstrap{bootstrapModule, shutdown, true};
}

struct LoggingRedBoxHandler
    : winrt::implements<LoggingRedBoxHandler, winrt::Microsoft::ReactNative::IRedBoxHandler> {
  LoggingRedBoxHandler(winrt::Microsoft::ReactNative::IRedBoxHandler innerHandler) noexcept
      : m_innerHandler(std::move(innerHandler)) {}

  void ShowNewError(
      winrt::Microsoft::ReactNative::IRedBoxErrorInfo const &info,
      winrt::Microsoft::ReactNative::RedBoxErrorType type) noexcept {
    AppendLog(std::string("RedBox.ShowNewError type=") + std::to_string(static_cast<int>(type)));
    LogRedBoxError("RedBox", info);

    if (m_innerHandler && m_innerHandler.IsDevSupportEnabled()) {
      m_innerHandler.ShowNewError(info, type);
    }
  }

  bool IsDevSupportEnabled() noexcept {
    return true;
  }

  void UpdateError(winrt::Microsoft::ReactNative::IRedBoxErrorInfo const &info) noexcept {
    AppendLog("RedBox.UpdateError");
    LogRedBoxError("RedBoxUpdate", info);

    if (m_innerHandler && m_innerHandler.IsDevSupportEnabled()) {
      m_innerHandler.UpdateError(info);
    }
  }

  void DismissRedBox() noexcept {
    AppendLog("RedBox.DismissRedBox");

    if (m_innerHandler && m_innerHandler.IsDevSupportEnabled()) {
      m_innerHandler.DismissRedBox();
    }
  }

 private:
  winrt::Microsoft::ReactNative::IRedBoxHandler m_innerHandler{nullptr};
};

} // namespace

// A PackageProvider containing any turbo modules you define within this app project
struct CompReactPackageProvider
    : winrt::implements<CompReactPackageProvider, winrt::Microsoft::ReactNative::IReactPackageProvider> {
 public: // IReactPackageProvider
  void CreatePackage(winrt::Microsoft::ReactNative::IReactPackageBuilder const &packageBuilder) noexcept {
    AddAttributedModules(packageBuilder, true);
  }
};

// The entry point of the Win32 application
_Use_decl_annotations_ int CALLBACK WinMain(HINSTANCE /*instance*/, HINSTANCE, PSTR /*commandLine*/, int /*showCmd*/) {
  try {
    ResetLog();
    AppendLog("WinMain.Start");

    winrt::init_apartment(winrt::apartment_type::single_threaded);
    SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);

    WCHAR appDirectory[MAX_PATH];
    GetModuleFileNameW(NULL, appDirectory, MAX_PATH);
    PathCchRemoveFileSpec(appDirectory, MAX_PATH);

#if BUNDLE
    if (!InitializeWindowPolicyRegistry(appDirectory, true)) {
      AppendLog("FatalWindowPolicyRegistryLoadFailure");
      return -1;
    }
#else
    InitializeWindowPolicyRegistry(appDirectory, false);
#endif

    auto windowsAppRuntimeBootstrap = InitializeWindowsAppRuntimeBootstrap();

    auto launchSurface = GetInitialLaunchSurface();
    AppendLog(
        "LaunchSurface surface=" + ToUtf8(launchSurface.SurfaceId) + " policy=" +
        ToUtf8(launchSurface.Policy) + " mode=" + ToUtf8(launchSurface.MetricsMode));

    AppendLog("WinMain.BuildReactNativeApp");
    auto reactNativeWin32App{winrt::Microsoft::ReactNative::ReactNativeAppBuilder().Build()};
    AppendLog("WinMain.BuildReactNativeApp.Done");
    auto reactNativeHost = reactNativeWin32App.ReactNativeHost();
    InitializeWindowManager(reactNativeHost);
    AppendLog("WinMain.WindowManagerInitialized");

    auto settings{reactNativeHost.InstanceSettings()};
    auto startupSecondarySurface = GetSecondaryStartupSurface();
    auto restoredSecondarySurfaces = LoadRestorableSecondarySurfaces(startupSecondarySurface);
    auto startupInitialOpenSurface = GetInitialAutoOpenSurface();

    settings.EnableDefaultCrashHandler(true);
    settings.NativeLogger([](winrt::Microsoft::ReactNative::LogLevel level, winrt::hstring const &message) {
      AppendLog(
          std::string("NativeLogger[") + std::to_string(static_cast<int>(level)) + "] " + ToUtf8(message));
    });
    settings.InstanceLoaded([settings, startupSecondarySurface, restoredSecondarySurfaces](
                                auto const &,
                                winrt::Microsoft::ReactNative::InstanceLoadedEventArgs const &args) {
      AppendLog(std::string("InstanceLoaded failed=") + BoolString(args.Failed()));

      if (args.Failed()) {
        return;
      }

      if (startupSecondarySurface) {
        if (auto error = QueueManagedWindowOpen(settings.UIDispatcher(), *startupSecondarySurface)) {
          AppendLog(
              "SecondaryStartupSurfaceFailed surface=" + ToUtf8(startupSecondarySurface->SurfaceId) + " reason=" +
              *error);
        }
      }

      for (auto const &restoredSecondarySurface : restoredSecondarySurfaces) {
        if (auto error = QueueManagedWindowOpen(settings.UIDispatcher(), restoredSecondarySurface)) {
          AppendLog(
              "RestoredSecondaryWindowFailed window=" + ToUtf8(restoredSecondarySurface.WindowId) + " surface=" +
              ToUtf8(restoredSecondarySurface.SurfaceId) + " reason=" + *error);
        }
      }
    });
    settings.RedBoxHandler(winrt::make<LoggingRedBoxHandler>(
        winrt::Microsoft::ReactNative::RedBoxHelper::CreateDefaultHandler(reactNativeHost)));

    RegisterAutolinkedNativeModulePackages(settings.PackageProviders());
    settings.PackageProviders().Append(winrt::make<CompReactPackageProvider>());

#if BUNDLE
    auto bundleRootPath = std::wstring(appDirectory).append(L"\\Bundle");
    settings.BundleRootPath(bundleRootPath.c_str());

    std::wstring jsBundleFile = L"index.windows";
    if (auto entryFile = ReadBundleManifestEntryFile(bundleRootPath)) {
      jsBundleFile = *entryFile;
      AppendLog("BundleManifestSource=manifest entryFile=" + ToUtf8(jsBundleFile));
    } else {
      AppendLog("BundleManifestSource=hardcoded-fallback entryFile=" + ToUtf8(jsBundleFile));
    }

    settings.JavaScriptBundleFile(jsBundleFile.c_str());
    settings.UseFastRefresh(false);
    AppendLog(
        std::string("Runtime=Bundle root=") + ToUtf8(settings.BundleRootPath()) + " file=" +
        ToUtf8(settings.JavaScriptBundleFile()));
#else
    settings.JavaScriptBundleFile(L"index");
    settings.UseFastRefresh(true);
    AppendLog("Runtime=Metro");
#endif
#if _DEBUG
    settings.UseDirectDebugger(true);
    settings.UseDeveloperSupport(true);
    AppendLog("DeveloperSupport=Enabled");
#else
    settings.UseDirectDebugger(false);
    settings.UseDeveloperSupport(false);
    AppendLog("DeveloperSupport=Disabled");
#endif

    AppendLog("WinMain.ConfigureInitialWindow");
    ConfigureInitialWindow(reactNativeWin32App, launchSurface);
    AppendLog("WinMain.ConfigureInitialWindow.Done");

    if (startupInitialOpenSurface) {
      AppendLog(
          "InitialOpenSurface surface=" + ToUtf8(startupInitialOpenSurface->SurfaceId) + " policy=" +
          ToUtf8(startupInitialOpenSurface->Policy) + " presentation=" +
          ToUtf8(startupInitialOpenSurface->Presentation));
    }

    if (startupSecondarySurface) {
      AppendLog(
          "SecondaryStartupSurface surface=" + ToUtf8(startupSecondarySurface->SurfaceId) + " policy=" +
          ToUtf8(startupSecondarySurface->Policy) + " mode=" + ToUtf8(startupSecondarySurface->MetricsMode));
    }

    auto viewOptions{reactNativeWin32App.ReactViewOptions()};
    viewOptions.ComponentName(L"OpappWindowsHost");
    viewOptions.InitialProps(CreateLaunchProps(launchSurface, startupInitialOpenSurface));

    AppendLog("WinMain.StartReactNativeApp");
    reactNativeWin32App.Start();
    AppendLog("WinMain.StartReactNativeApp.Done");
    return 0;
  } catch (winrt::hresult_error const &error) {
    AppendLog(
        "WinMain.HResultError code=" + std::to_string(static_cast<int32_t>(error.code().value)) +
        " message=" + ToUtf8(error.message()));
    return -1;
  } catch (std::exception const &error) {
    AppendLog(std::string("WinMain.StdException message=") + error.what());
    return -1;
  } catch (...) {
    AppendLog("WinMain.UnknownException");
    return -1;
  }
}




