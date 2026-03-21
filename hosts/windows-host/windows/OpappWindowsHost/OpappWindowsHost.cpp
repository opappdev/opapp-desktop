// OpappWindowsHost.cpp : Defines the entry point for the application.
//

#include "pch.h"
#include "OpappWindowsHost.h"

#include "AutolinkedNativeModules.g.h"

#include "NativeModules.h"

#include <string>

namespace {

std::string ToUtf8(winrt::hstring const &value) {
  return winrt::to_string(value);
}

std::string ToUtf8(std::wstring const &value) {
  return winrt::to_string(winrt::hstring{value});
}

std::string GetLogPath() {
  char tempPath[MAX_PATH] = {};
  auto length = GetTempPathA(MAX_PATH, tempPath);
  if (length == 0 || length > MAX_PATH) {
    return "opapp-windows-host.log";
  }

  return std::string(tempPath) + "opapp-windows-host.log";
}

void ResetLog() noexcept {
  auto logPath = GetLogPath();
  HANDLE file = CreateFileA(
      logPath.c_str(),
      GENERIC_WRITE,
      FILE_SHARE_READ | FILE_SHARE_WRITE,
      nullptr,
      CREATE_ALWAYS,
      FILE_ATTRIBUTE_NORMAL,
      nullptr);

  if (file != INVALID_HANDLE_VALUE) {
    CloseHandle(file);
  }
}

void AppendLog(std::string const &message) noexcept {
  SYSTEMTIME timestamp{};
  GetLocalTime(&timestamp);

  char prefix[64] = {};
  sprintf_s(
      prefix,
      "[%04d-%02d-%02d %02d:%02d:%02d.%03d] ",
      timestamp.wYear,
      timestamp.wMonth,
      timestamp.wDay,
      timestamp.wHour,
      timestamp.wMinute,
      timestamp.wSecond,
      timestamp.wMilliseconds);

  auto line = std::string(prefix) + message + "\r\n";
  auto logPath = GetLogPath();

  HANDLE file = CreateFileA(
      logPath.c_str(),
      FILE_APPEND_DATA,
      FILE_SHARE_READ | FILE_SHARE_WRITE,
      nullptr,
      OPEN_ALWAYS,
      FILE_ATTRIBUTE_NORMAL,
      nullptr);

  if (file != INVALID_HANDLE_VALUE) {
    DWORD written = 0;
    WriteFile(file, line.data(), static_cast<DWORD>(line.size()), &written, nullptr);
    CloseHandle(file);
  }

  OutputDebugStringA(line.c_str());
}

std::string BoolString(bool value) {
  return value ? "true" : "false";
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
_Use_decl_annotations_ int CALLBACK WinMain(HINSTANCE instance, HINSTANCE, PSTR /* commandLine */, int showCmd) {
  ResetLog();

  winrt::init_apartment(winrt::apartment_type::single_threaded);
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);

  WCHAR appDirectory[MAX_PATH];
  GetModuleFileNameW(NULL, appDirectory, MAX_PATH);
  PathCchRemoveFileSpec(appDirectory, MAX_PATH);

  auto reactNativeWin32App{winrt::Microsoft::ReactNative::ReactNativeAppBuilder().Build()};
  auto settings{reactNativeWin32App.ReactNativeHost().InstanceSettings()};

  settings.EnableDefaultCrashHandler(true);
  settings.NativeLogger([](winrt::Microsoft::ReactNative::LogLevel level, winrt::hstring const &message) {
    AppendLog(
        std::string("NativeLogger[") + std::to_string(static_cast<int>(level)) + "] " + ToUtf8(message));
  });
  settings.InstanceLoaded([](auto const &, winrt::Microsoft::ReactNative::InstanceLoadedEventArgs const &args) {
    AppendLog(std::string("InstanceLoaded failed=") + BoolString(args.Failed()));
  });
  settings.RedBoxHandler(winrt::make<LoggingRedBoxHandler>(
      winrt::Microsoft::ReactNative::RedBoxHelper::CreateDefaultHandler(reactNativeWin32App.ReactNativeHost())));

  RegisterAutolinkedNativeModulePackages(settings.PackageProviders());
  settings.PackageProviders().Append(winrt::make<CompReactPackageProvider>());

#if BUNDLE
  settings.BundleRootPath(std::wstring(appDirectory).append(L"\\Bundle").c_str());
  settings.JavaScriptBundleFile(L"index.windows");
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

  auto appWindow{reactNativeWin32App.AppWindow()};
  appWindow.Title(L"OpappWindowsHost");
  appWindow.Resize({1000, 1000});

  auto viewOptions{reactNativeWin32App.ReactViewOptions()};
  viewOptions.ComponentName(L"OpappWindowsHost");

  reactNativeWin32App.Start();
}
