#include "pch.h"

#include <array>
#include <atomic>
#include <cwctype>
#include <filesystem>
#include <fstream>
#include <map>
#include <mutex>
#include <optional>
#include <sstream>
#include <string_view>
#include <thread>
#include <unordered_map>
#include <utility>
#include <vector>

#include <winrt/Windows.Data.Json.h>

#include "NativeModules.h"

namespace OpappWindowsHostModules {

namespace {

namespace fs = std::filesystem;
using JSValueObject = winrt::Microsoft::ReactNative::JSValueObject;
using ReactContext = winrt::Microsoft::ReactNative::ReactContext;
using JsonObject = winrt::Windows::Data::Json::JsonObject;
using JsonValueType = winrt::Windows::Data::Json::JsonValueType;

constexpr wchar_t kEventEmitterName[] = L"RCTDeviceEventEmitter";
constexpr wchar_t kEventName[] = L"opapp.agentTerminal";
constexpr wchar_t kAgentRuntimeDirectoryName[] = L"agent-runtime";
constexpr wchar_t kTrustedWorkspaceTargetFileName[] = L"workspace-target.json";
constexpr std::size_t kTerminalReadChunkSize = 4096;

enum class TerminalShellKind {
  PowerShell,
  Cmd,
};

struct TrustedWorkspaceTarget {
  fs::path RootPath;
};

struct TerminalLaunchRequest {
  std::string Command;
  std::wstring CommandWide;
  std::wstring RelativeCwd;
  std::unordered_map<std::wstring, std::wstring> Env;
  TerminalShellKind Shell{TerminalShellKind::PowerShell};
};

struct TerminalSessionState {
  std::string SessionId;
  ReactContext Context{nullptr};
  std::mutex Mutex;
  HANDLE ProcessHandle{nullptr};
  HANDLE JobHandle{nullptr};
  HANDLE StdinWriteHandle{nullptr};
  std::string Command;
  std::string Cwd;
};

struct ShellLaunchSpec {
  std::wstring Executable;
  std::vector<std::wstring> Arguments;
};

std::atomic_uint64_t g_nextSessionId{1};
std::mutex g_sessionsMutex;
std::unordered_map<std::string, std::shared_ptr<TerminalSessionState>> g_sessions;

std::string GenerateSessionId() {
  return "terminal-" + std::to_string(g_nextSessionId.fetch_add(1, std::memory_order_relaxed));
}

std::string WideToUtf8(std::wstring const &value) noexcept {
  return winrt::to_string(winrt::hstring(value));
}

std::wstring TrimWhitespace(std::wstring value) {
  auto const first = value.find_first_not_of(L" \t\r\n");
  if (first == std::wstring::npos) {
    return {};
  }

  auto const last = value.find_last_not_of(L" \t\r\n");
  return value.substr(first, (last - first) + 1);
}

std::string TrimWhitespaceUtf8(std::string const &value) {
  return WideToUtf8(TrimWhitespace(std::wstring(winrt::to_hstring(value).c_str())));
}

std::wstring FoldCase(std::wstring value) noexcept {
  std::transform(
      value.begin(),
      value.end(),
      value.begin(),
      [](wchar_t ch) { return static_cast<wchar_t>(std::towlower(ch)); });
  return value;
}

std::string BuildIsoTimestamp() {
  SYSTEMTIME utc{};
  GetSystemTime(&utc);

  char buffer[40] = {};
  sprintf_s(
      buffer,
      "%04u-%02u-%02uT%02u:%02u:%02u.%03uZ",
      utc.wYear,
      utc.wMonth,
      utc.wDay,
      utc.wHour,
      utc.wMinute,
      utc.wSecond,
      utc.wMilliseconds);
  return buffer;
}

void CloseHandleIfValid(HANDLE &handle) noexcept {
  if (handle != nullptr && handle != INVALID_HANDLE_VALUE) {
    CloseHandle(handle);
  }
  handle = nullptr;
}

void CloseOwnedHandle(HANDLE handle) noexcept {
  if (handle != nullptr && handle != INVALID_HANDLE_VALUE) {
    CloseHandle(handle);
  }
}

std::wstring QuoteCommandLineArgument(std::wstring const &argument) {
  if (argument.empty()) {
    return L"\"\"";
  }

  if (argument.find_first_of(L" \t\n\v\"") == std::wstring::npos) {
    return argument;
  }

  std::wstring quoted = L"\"";
  std::size_t backslashCount = 0;
  for (wchar_t ch : argument) {
    if (ch == L'\\') {
      backslashCount += 1;
      continue;
    }

    if (ch == L'"') {
      quoted.append(backslashCount * 2 + 1, L'\\');
      quoted.push_back(L'"');
      backslashCount = 0;
      continue;
    }

    quoted.append(backslashCount, L'\\');
    backslashCount = 0;
    quoted.push_back(ch);
  }

  quoted.append(backslashCount * 2, L'\\');
  quoted.push_back(L'"');
  return quoted;
}

std::wstring BuildCommandLine(
    std::wstring const &executable,
    std::vector<std::wstring> const &arguments) {
  std::wstring commandLine = QuoteCommandLineArgument(executable);
  for (auto const &argument : arguments) {
    commandLine.push_back(L' ');
    commandLine += QuoteCommandLineArgument(argument);
  }

  return commandLine;
}

std::string Base64Encode(std::vector<uint8_t> const &bytes) {
  static constexpr char kAlphabet[] =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

  std::string encoded;
  encoded.reserve(((bytes.size() + 2) / 3) * 4);

  for (std::size_t index = 0; index < bytes.size(); index += 3) {
    uint32_t chunk = static_cast<uint32_t>(bytes[index]) << 16;
    bool const hasSecond = index + 1 < bytes.size();
    bool const hasThird = index + 2 < bytes.size();
    if (hasSecond) {
      chunk |= static_cast<uint32_t>(bytes[index + 1]) << 8;
    }
    if (hasThird) {
      chunk |= static_cast<uint32_t>(bytes[index + 2]);
    }

    encoded.push_back(kAlphabet[(chunk >> 18) & 0x3F]);
    encoded.push_back(kAlphabet[(chunk >> 12) & 0x3F]);
    encoded.push_back(hasSecond ? kAlphabet[(chunk >> 6) & 0x3F] : '=');
    encoded.push_back(hasThird ? kAlphabet[chunk & 0x3F] : '=');
  }

  return encoded;
}

std::wstring BuildPowerShellBootstrapScript(std::wstring const &command) {
  return std::wstring(
             L"[Console]::InputEncoding = [System.Text.Encoding]::UTF8;"
             L"[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;"
             L"$OutputEncoding = [System.Text.Encoding]::UTF8;"
             L"& {\n") +
      command + L"\n}";
}

ShellLaunchSpec BuildShellLaunchSpec(TerminalLaunchRequest const &request) {
  if (request.Shell == TerminalShellKind::Cmd) {
    return ShellLaunchSpec{
        L"cmd.exe",
        {
            L"/d",
            L"/s",
            L"/c",
            std::wstring(L"chcp 65001>nul & ") + request.CommandWide,
        },
    };
  }

  auto script = BuildPowerShellBootstrapScript(request.CommandWide);
  auto scriptBytes = reinterpret_cast<uint8_t const *>(script.data());
  std::vector<uint8_t> encodedBytes(
      scriptBytes,
      scriptBytes + (script.size() * sizeof(wchar_t)));

  return ShellLaunchSpec{
      L"powershell.exe",
      {
          L"-NoLogo",
          L"-NoProfile",
          L"-NonInteractive",
          L"-ExecutionPolicy",
          L"Bypass",
          L"-EncodedCommand",
          std::wstring(winrt::to_hstring(Base64Encode(encodedBytes)).c_str()),
      },
  };
}

std::wstring GetUserDataDir() noexcept {
  wchar_t localAppData[MAX_PATH] = {};
  DWORD len = GetEnvironmentVariableW(L"LOCALAPPDATA", localAppData, MAX_PATH);
  if (len == 0 || len >= MAX_PATH) {
    return {};
  }

  return (fs::path(localAppData) / L"OPApp").wstring();
}

std::optional<fs::path> GetUserDataDirPath() noexcept {
  auto dataDir = GetUserDataDir();
  if (dataDir.empty()) {
    return std::nullopt;
  }

  return fs::path(dataDir);
}

fs::path GetAgentRuntimeDir(fs::path const &dataDir) {
  return dataDir / kAgentRuntimeDirectoryName;
}

fs::path GetTrustedWorkspaceTargetPath(fs::path const &dataDir) {
  return GetAgentRuntimeDir(dataDir) / kTrustedWorkspaceTargetFileName;
}

bool IsPathWithinRoot(
    fs::path const &rootPath,
    fs::path const &resolvedPath,
    bool allowRoot) noexcept {
  try {
    auto rel =
        resolvedPath.lexically_normal().lexically_relative(rootPath.lexically_normal());
    if (rel.empty()) {
      return allowRoot;
    }

    return *rel.begin() != fs::path(L"..");
  } catch (...) {
    return false;
  }
}

std::optional<fs::path> ResolveManagedPath(
    fs::path const &rootPath,
    std::wstring const &relativePath,
    bool allowRoot) noexcept {
  try {
    auto relative = fs::path(relativePath);
    if (relative.is_absolute() || relative.has_root_name() || relative.has_root_directory()) {
      return std::nullopt;
    }

    auto resolved = (rootPath / relative).lexically_normal();
    if (!IsPathWithinRoot(rootPath, resolved, allowRoot)) {
      return std::nullopt;
    }

    return resolved;
  } catch (...) {
    return std::nullopt;
  }
}

std::optional<std::string> ReadFileContents(fs::path const &path) noexcept {
  try {
    std::ifstream stream(path, std::ios::binary);
    if (!stream.is_open()) {
      return std::nullopt;
    }

    std::ostringstream buffer;
    buffer << stream.rdbuf();
    if (!stream.good() && !stream.eof()) {
      return std::nullopt;
    }

    return buffer.str();
  } catch (...) {
    return std::nullopt;
  }
}

std::optional<fs::path> NormalizeExistingDirectory(std::string const &rawPath) noexcept {
  try {
    auto candidate = fs::path(winrt::to_hstring(rawPath).c_str());
    if (candidate.empty()) {
      return std::nullopt;
    }

    std::error_code ec;
    auto absolutePath = candidate.is_absolute() ? candidate : fs::absolute(candidate, ec);
    if (ec) {
      return std::nullopt;
    }

    auto normalizedPath = fs::weakly_canonical(absolutePath, ec);
    if (ec) {
      return std::nullopt;
    }

    if (!fs::exists(normalizedPath, ec) || ec) {
      return std::nullopt;
    }

    if (!fs::is_directory(normalizedPath, ec) || ec) {
      return std::nullopt;
    }

    return normalizedPath.lexically_normal();
  } catch (...) {
    return std::nullopt;
  }
}

std::optional<TrustedWorkspaceTarget> ReadTrustedWorkspaceTarget() noexcept {
  auto dataDir = GetUserDataDirPath();
  if (!dataDir) {
    return std::nullopt;
  }

  auto raw = ReadFileContents(GetTrustedWorkspaceTargetPath(*dataDir));
  if (!raw || raw->empty()) {
    return std::nullopt;
  }

  try {
    auto payload = JsonObject::Parse(winrt::to_hstring(*raw));
    auto rootPath = payload.GetNamedString(L"rootPath", L"");
    if (rootPath.empty() || !payload.GetNamedBoolean(L"trusted", false)) {
      return std::nullopt;
    }

    auto normalizedRoot =
        NormalizeExistingDirectory(winrt::to_string(rootPath));
    if (!normalizedRoot) {
      return std::nullopt;
    }

    return TrustedWorkspaceTarget{*normalizedRoot};
  } catch (...) {
    return std::nullopt;
  }
}

std::optional<fs::path> ResolveTerminalCwd(
    TerminalLaunchRequest const &request,
    std::wstring &error) noexcept {
  auto workspaceTarget = ReadTrustedWorkspaceTarget();
  if (!workspaceTarget) {
    error = L"Trusted workspace root is not configured.";
    return std::nullopt;
  }

  auto resolved = request.RelativeCwd.empty()
      ? std::optional<fs::path>(workspaceTarget->RootPath)
      : ResolveManagedPath(workspaceTarget->RootPath, request.RelativeCwd, true);
  if (!resolved) {
    error = L"Terminal cwd escapes the trusted workspace root.";
    return std::nullopt;
  }

  std::error_code ec;
  if (!fs::exists(*resolved, ec) || ec || !fs::is_directory(*resolved, ec) || ec) {
    error = L"Terminal cwd must resolve to an existing directory.";
    return std::nullopt;
  }

  return resolved->lexically_normal();
}

struct WideCaseInsensitiveLess {
  bool operator()(std::wstring const &left, std::wstring const &right) const noexcept {
    return FoldCase(left) < FoldCase(right);
  }
};

std::vector<wchar_t> BuildEnvironmentBlock(
    std::unordered_map<std::wstring, std::wstring> const &overrides) noexcept {
  std::map<std::wstring, std::wstring, WideCaseInsensitiveLess> merged;

  auto *environmentBlock = GetEnvironmentStringsW();
  if (environmentBlock != nullptr) {
    auto const *cursor = environmentBlock;
    while (*cursor != L'\0') {
      std::wstring entry(cursor);
      auto separator = entry.find(L'=');
      if (separator != std::wstring::npos && separator > 0) {
        merged[entry.substr(0, separator)] = entry.substr(separator + 1);
      }
      cursor += entry.size() + 1;
    }
    FreeEnvironmentStringsW(environmentBlock);
  }

  for (auto const &[key, value] : overrides) {
    if (key.empty() || key.find(L'=') != std::wstring::npos) {
      continue;
    }

    merged[key] = value;
  }

  std::vector<wchar_t> block;
  for (auto const &[key, value] : merged) {
    std::wstring entry = key + L"=" + value;
    block.insert(block.end(), entry.begin(), entry.end());
    block.push_back(L'\0');
  }
  block.push_back(L'\0');
  return block;
}

std::size_t ExpectedUtf8SequenceLength(uint8_t leadByte) {
  if ((leadByte & 0x80) == 0x00) {
    return 1;
  }

  if ((leadByte & 0xE0) == 0xC0) {
    return 2;
  }

  if ((leadByte & 0xF0) == 0xE0) {
    return 3;
  }

  if ((leadByte & 0xF8) == 0xF0) {
    return 4;
  }

  return 1;
}

bool IsUtf8ContinuationByte(uint8_t value) {
  return (value & 0xC0) == 0x80;
}

std::size_t ResolveSafeUtf8PrefixLength(std::vector<uint8_t> const &buffer) {
  if (buffer.empty()) {
    return 0;
  }

  std::size_t index = buffer.size();
  std::size_t continuationCount = 0;
  while (index > 0 && continuationCount < 3 && IsUtf8ContinuationByte(buffer[index - 1])) {
    --index;
    ++continuationCount;
  }

  if (index == 0) {
    return 0;
  }

  auto leadIndex = index - 1;
  auto expectedLength = ExpectedUtf8SequenceLength(buffer[leadIndex]);
  if (expectedLength <= 1) {
    return buffer.size();
  }

  auto actualLength = buffer.size() - leadIndex;
  return actualLength < expectedLength ? leadIndex : buffer.size();
}

std::optional<std::string> DrainUtf8Chunk(std::vector<uint8_t> &buffer) {
  auto safePrefixLength = ResolveSafeUtf8PrefixLength(buffer);
  if (safePrefixLength == 0) {
    return std::nullopt;
  }

  std::string chunk(
      reinterpret_cast<char const *>(buffer.data()),
      reinterpret_cast<char const *>(buffer.data()) + safePrefixLength);
  buffer.erase(buffer.begin(), buffer.begin() + static_cast<std::ptrdiff_t>(safePrefixLength));
  return chunk;
}

void RegisterSession(std::shared_ptr<TerminalSessionState> const &session) {
  std::scoped_lock lock(g_sessionsMutex);
  g_sessions[session->SessionId] = session;
}

std::shared_ptr<TerminalSessionState> FindSession(std::string const &sessionId) {
  std::scoped_lock lock(g_sessionsMutex);
  auto iterator = g_sessions.find(sessionId);
  return iterator == g_sessions.end() ? nullptr : iterator->second;
}

void UnregisterSession(std::string const &sessionId) {
  std::scoped_lock lock(g_sessionsMutex);
  g_sessions.erase(sessionId);
}

void EmitSessionPayload(
    std::shared_ptr<TerminalSessionState> const &session,
    JSValueObject &&payload) noexcept {
  ReactContext context{nullptr};
  {
    std::scoped_lock lock(session->Mutex);
    context = session->Context;
  }

  try {
    if (!context) {
      return;
    }

    context.EmitJSEvent(
        kEventEmitterName,
        kEventName,
        std::move(payload));
  } catch (...) {
  }
}

void EmitSessionEvent(
    std::shared_ptr<TerminalSessionState> const &session,
    std::string eventName,
    std::optional<std::string> text = std::nullopt,
    std::optional<int> exitCode = std::nullopt) noexcept {
  std::string command;
  std::string cwd;
  {
    std::scoped_lock lock(session->Mutex);
    command = session->Command;
    cwd = session->Cwd;
  }

  JSValueObject payload{
      {"sessionId", session->SessionId},
      {"type", "event"},
      {"event", std::move(eventName)},
      {"createdAt", BuildIsoTimestamp()},
  };
  if (!command.empty()) {
    payload.insert_or_assign("command", command);
  }
  if (!cwd.empty()) {
    payload.insert_or_assign("cwd", cwd);
  }
  if (text.has_value()) {
    payload.insert_or_assign("text", *text);
  }
  if (exitCode.has_value()) {
    payload.insert_or_assign("exitCode", static_cast<int64_t>(*exitCode));
  }

  EmitSessionPayload(session, std::move(payload));
}

void CloseSessionStdin(std::shared_ptr<TerminalSessionState> const &session) noexcept {
  HANDLE stdinWriteHandle = nullptr;
  {
    std::scoped_lock lock(session->Mutex);
    stdinWriteHandle = session->StdinWriteHandle;
    session->StdinWriteHandle = nullptr;
  }

  CloseOwnedHandle(stdinWriteHandle);
}

void CloseSessionHandles(std::shared_ptr<TerminalSessionState> const &session) noexcept {
  HANDLE processHandle = nullptr;
  HANDLE jobHandle = nullptr;
  HANDLE stdinWriteHandle = nullptr;
  {
    std::scoped_lock lock(session->Mutex);
    processHandle = session->ProcessHandle;
    jobHandle = session->JobHandle;
    stdinWriteHandle = session->StdinWriteHandle;
    session->ProcessHandle = nullptr;
    session->JobHandle = nullptr;
    session->StdinWriteHandle = nullptr;
  }

  CloseOwnedHandle(stdinWriteHandle);
  CloseOwnedHandle(processHandle);
  CloseOwnedHandle(jobHandle);
}

void CancelSessionProcess(std::shared_ptr<TerminalSessionState> const &session) noexcept {
  HANDLE processHandle = nullptr;
  HANDLE jobHandle = nullptr;
  {
    std::scoped_lock lock(session->Mutex);
    processHandle = session->ProcessHandle;
    jobHandle = session->JobHandle;
  }

  if (jobHandle != nullptr && jobHandle != INVALID_HANDLE_VALUE) {
    TerminateJobObject(jobHandle, 1);
    return;
  }

  if (processHandle != nullptr && processHandle != INVALID_HANDLE_VALUE) {
    TerminateProcess(processHandle, 1);
  }
}

std::optional<HANDLE> CreateKillOnCloseJob() noexcept {
  HANDLE jobHandle = CreateJobObjectW(nullptr, nullptr);
  if (jobHandle == nullptr) {
    return std::nullopt;
  }

  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(
          jobHandle,
          JobObjectExtendedLimitInformation,
          &limits,
          sizeof(limits))) {
    CloseHandle(jobHandle);
    return std::nullopt;
  }

  return jobHandle;
}

std::optional<TerminalLaunchRequest> ParseLaunchRequest(
    std::string const &requestJson,
    std::wstring &error) noexcept {
  TerminalLaunchRequest request;

  try {
    auto json = JsonObject::Parse(winrt::to_hstring(requestJson));

    auto command = TrimWhitespace(std::wstring(json.GetNamedString(L"command", L"").c_str()));
    if (command.empty()) {
      error = L"Terminal command is required.";
      return std::nullopt;
    }
    request.CommandWide = command;
    request.Command = WideToUtf8(command);

    if (json.HasKey(L"cwd")) {
      auto cwdValue = json.Lookup(L"cwd");
      if (cwdValue.ValueType() == JsonValueType::String) {
        request.RelativeCwd = TrimWhitespace(std::wstring(cwdValue.GetString().c_str()));
      }
    }

    auto shell = FoldCase(std::wstring(json.GetNamedString(L"shell", L"powershell").c_str()));
    if (shell == L"cmd") {
      request.Shell = TerminalShellKind::Cmd;
    } else if (shell == L"powershell" || shell.empty()) {
      request.Shell = TerminalShellKind::PowerShell;
    } else {
      error = L"Terminal shell must be either 'powershell' or 'cmd'.";
      return std::nullopt;
    }

    if (json.HasKey(L"env")) {
      auto envValue = json.Lookup(L"env");
      if (envValue.ValueType() != JsonValueType::Object) {
        error = L"Terminal env must be an object.";
        return std::nullopt;
      }

      auto envObject = envValue.GetObject();
      for (auto const &entry : envObject) {
        if (entry.Value().ValueType() != JsonValueType::String) {
          continue;
        }

        auto key = TrimWhitespace(std::wstring(entry.Key()));
        if (key.empty() || key.find(L'=') != std::wstring::npos) {
          continue;
        }

        request.Env[key] = std::wstring(entry.Value().GetString());
      }
    }
  } catch (...) {
    error = L"Unable to parse the terminal session payload.";
    return std::nullopt;
  }

  return request;
}

bool LaunchTerminalProcess(
    std::shared_ptr<TerminalSessionState> const &session,
    TerminalLaunchRequest const &request,
    std::wstring &error,
    HANDLE &stdoutReadHandle,
    HANDLE &stderrReadHandle) noexcept {
  HANDLE stdoutReadLocal = nullptr;
  HANDLE stdoutWriteLocal = nullptr;
  HANDLE stderrReadLocal = nullptr;
  HANDLE stderrWriteLocal = nullptr;
  HANDLE stdinReadLocal = nullptr;
  HANDLE stdinWriteLocal = nullptr;
  HANDLE processHandle = nullptr;
  HANDLE jobHandle = nullptr;

  auto cleanup = [&]() noexcept {
    CloseHandleIfValid(stdoutReadLocal);
    CloseHandleIfValid(stdoutWriteLocal);
    CloseHandleIfValid(stderrReadLocal);
    CloseHandleIfValid(stderrWriteLocal);
    CloseHandleIfValid(stdinReadLocal);
    CloseHandleIfValid(stdinWriteLocal);
    CloseHandleIfValid(processHandle);
    CloseHandleIfValid(jobHandle);
  };

  SECURITY_ATTRIBUTES securityAttributes{};
  securityAttributes.nLength = sizeof(securityAttributes);
  securityAttributes.bInheritHandle = TRUE;

  if (!CreatePipe(&stdoutReadLocal, &stdoutWriteLocal, &securityAttributes, 0) ||
      !SetHandleInformation(stdoutReadLocal, HANDLE_FLAG_INHERIT, 0) ||
      !CreatePipe(&stderrReadLocal, &stderrWriteLocal, &securityAttributes, 0) ||
      !SetHandleInformation(stderrReadLocal, HANDLE_FLAG_INHERIT, 0) ||
      !CreatePipe(&stdinReadLocal, &stdinWriteLocal, &securityAttributes, 0) ||
      !SetHandleInformation(stdinWriteLocal, HANDLE_FLAG_INHERIT, 0)) {
    error = L"Failed to create terminal pipes.";
    cleanup();
    return false;
  }

  auto cwdPath = ResolveTerminalCwd(request, error);
  if (!cwdPath) {
    cleanup();
    return false;
  }

  auto launchSpec = BuildShellLaunchSpec(request);
  auto commandLine = BuildCommandLine(launchSpec.Executable, launchSpec.Arguments);
  std::vector<wchar_t> mutableCommandLine(commandLine.begin(), commandLine.end());
  mutableCommandLine.push_back(L'\0');

  auto environmentBlock = request.Env.empty()
      ? std::vector<wchar_t>{}
      : BuildEnvironmentBlock(request.Env);

  STARTUPINFOW startupInfo{};
  startupInfo.cb = sizeof(startupInfo);
  startupInfo.dwFlags = STARTF_USESTDHANDLES;
  startupInfo.hStdInput = stdinReadLocal;
  startupInfo.hStdOutput = stdoutWriteLocal;
  startupInfo.hStdError = stderrWriteLocal;

  PROCESS_INFORMATION processInfo{};
  auto cwdString = cwdPath->wstring();
  auto const creationFlags =
      CREATE_NO_WINDOW | (request.Env.empty() ? 0 : CREATE_UNICODE_ENVIRONMENT);
  BOOL ok = CreateProcessW(
      nullptr,
      mutableCommandLine.data(),
      nullptr,
      nullptr,
      TRUE,
      creationFlags,
      request.Env.empty() ? nullptr : environmentBlock.data(),
      cwdString.c_str(),
      &startupInfo,
      &processInfo);

  CloseHandleIfValid(stdoutWriteLocal);
  CloseHandleIfValid(stderrWriteLocal);
  CloseHandleIfValid(stdinReadLocal);

  if (!ok) {
    error = L"Failed to launch the terminal session.";
    cleanup();
    return false;
  }

  processHandle = processInfo.hProcess;
  CloseOwnedHandle(processInfo.hThread);

  auto createdJob = CreateKillOnCloseJob();
  if (!createdJob) {
    error = L"Failed to create a terminal job object.";
    cleanup();
    return false;
  }
  jobHandle = *createdJob;

  if (!AssignProcessToJobObject(jobHandle, processHandle)) {
    error = L"Failed to assign the terminal session to a job object.";
    cleanup();
    return false;
  }

  {
    std::scoped_lock lock(session->Mutex);
    session->ProcessHandle = processHandle;
    session->JobHandle = jobHandle;
    session->StdinWriteHandle = stdinWriteLocal;
    session->Command = request.Command;
    session->Cwd = WideToUtf8(cwdPath->generic_wstring());
  }

  processHandle = nullptr;
  jobHandle = nullptr;
  stdinWriteLocal = nullptr;
  stdoutReadHandle = stdoutReadLocal;
  stderrReadHandle = stderrReadLocal;
  stdoutReadLocal = nullptr;
  stderrReadLocal = nullptr;
  return true;
}

void ReadPipeStream(
    std::shared_ptr<TerminalSessionState> const &session,
    HANDLE pipeHandle,
    std::string eventName) noexcept {
  try {
    std::vector<uint8_t> utf8Buffer;
    std::array<uint8_t, kTerminalReadChunkSize> readBuffer{};
    while (true) {
      DWORD bytesRead = 0;
      BOOL ok = ReadFile(
          pipeHandle,
          readBuffer.data(),
          static_cast<DWORD>(readBuffer.size()),
          &bytesRead,
          nullptr);
      if (!ok || bytesRead == 0) {
        break;
      }

      utf8Buffer.insert(
          utf8Buffer.end(),
          readBuffer.begin(),
          readBuffer.begin() + static_cast<std::ptrdiff_t>(bytesRead));

      while (auto chunk = DrainUtf8Chunk(utf8Buffer)) {
        EmitSessionEvent(session, eventName, std::move(*chunk));
      }
    }

    if (!utf8Buffer.empty()) {
      EmitSessionEvent(
          session,
          eventName,
          std::string(
              reinterpret_cast<char const *>(utf8Buffer.data()),
              reinterpret_cast<char const *>(utf8Buffer.data()) + utf8Buffer.size()));
    }
  } catch (...) {
  }

  CloseOwnedHandle(pipeHandle);
}

void RunTerminalSession(
    std::shared_ptr<TerminalSessionState> const &session,
    HANDLE stdoutReadHandle,
    HANDLE stderrReadHandle) noexcept {
  auto stdoutReader = std::thread(
      [session, stdoutReadHandle]() mutable noexcept {
        ReadPipeStream(session, stdoutReadHandle, "stdout");
      });
  auto stderrReader = std::thread(
      [session, stderrReadHandle]() mutable noexcept {
        ReadPipeStream(session, stderrReadHandle, "stderr");
      });

  HANDLE processHandle = nullptr;
  {
    std::scoped_lock lock(session->Mutex);
    processHandle = session->ProcessHandle;
  }

  DWORD waitResult = processHandle == nullptr
      ? WAIT_FAILED
      : WaitForSingleObject(processHandle, INFINITE);

  CloseSessionStdin(session);

  if (stdoutReader.joinable()) {
    stdoutReader.join();
  }
  if (stderrReader.joinable()) {
    stderrReader.join();
  }

  int exitCode = 1;
  if (waitResult == WAIT_OBJECT_0 && processHandle != nullptr) {
    DWORD processExitCode = 1;
    if (GetExitCodeProcess(processHandle, &processExitCode) != 0) {
      exitCode = static_cast<int>(processExitCode);
    }
  }

  EmitSessionEvent(session, "exit", std::nullopt, exitCode);
  UnregisterSession(session->SessionId);
  CloseSessionHandles(session);
}

} // namespace

REACT_MODULE(OpappAgentTerminalModule, L"OpappAgentTerminal")
struct OpappAgentTerminalModule {
  REACT_INIT(Initialize)
  void Initialize(ReactContext const &reactContext) noexcept {
    m_reactContext = reactContext;
  }

  REACT_METHOD(OpenSession, L"openSession")
  void OpenSession(
      std::string requestJson,
      winrt::Microsoft::ReactNative::ReactPromise<std::string> &&result) noexcept;

  REACT_METHOD(CancelSession, L"cancelSession")
  void CancelSession(
      std::string sessionId,
      winrt::Microsoft::ReactNative::ReactPromise<void> &&result) noexcept;

  REACT_METHOD(WriteSessionInput, L"writeSessionInput")
  void WriteSessionInput(
      std::string sessionId,
      std::string text,
      winrt::Microsoft::ReactNative::ReactPromise<void> &&result) noexcept;

  REACT_METHOD(AddListener, L"addListener")
  void AddListener(std::string const & /*eventName*/) noexcept {}

  REACT_METHOD(RemoveListeners, L"removeListeners")
  void RemoveListeners(double /*count*/) noexcept {}

 private:
  ReactContext m_reactContext{nullptr};
};

void OpappAgentTerminalModule::OpenSession(
    std::string requestJson,
    winrt::Microsoft::ReactNative::ReactPromise<std::string> &&result) noexcept {
  try {
    auto reactContext = m_reactContext;
    std::thread(
        [reactContext,
         requestJson = std::move(requestJson),
         result = std::move(result)]() mutable noexcept {
          std::wstring error;
          auto request = ParseLaunchRequest(requestJson, error);
          if (!request) {
            result.Reject(error.c_str());
            return;
          }

          auto session = std::make_shared<TerminalSessionState>();
          session->SessionId = GenerateSessionId();
          session->Context = reactContext;

          HANDLE stdoutReadHandle = nullptr;
          HANDLE stderrReadHandle = nullptr;
          if (!LaunchTerminalProcess(
                  session,
                  *request,
                  error,
                  stdoutReadHandle,
                  stderrReadHandle)) {
            result.Reject(error.c_str());
            return;
          }

          RegisterSession(session);
          result.Resolve(session->SessionId);
          EmitSessionEvent(session, "started");
          RunTerminalSession(session, stdoutReadHandle, stderrReadHandle);
        })
        .detach();
  } catch (...) {
    result.Reject(L"Failed to schedule openSession.");
  }
}

void OpappAgentTerminalModule::CancelSession(
    std::string sessionId,
    winrt::Microsoft::ReactNative::ReactPromise<void> &&result) noexcept {
  auto session = FindSession(TrimWhitespaceUtf8(sessionId));
  if (session) {
    CancelSessionProcess(session);
  }

  result.Resolve();
}

void OpappAgentTerminalModule::WriteSessionInput(
    std::string sessionId,
    std::string text,
    winrt::Microsoft::ReactNative::ReactPromise<void> &&result) noexcept {
  auto session = FindSession(TrimWhitespaceUtf8(sessionId));
  if (!session) {
    result.Reject(L"Terminal session not found.");
    return;
  }

  HANDLE stdinWriteHandle = nullptr;
  {
    std::scoped_lock lock(session->Mutex);
    stdinWriteHandle = session->StdinWriteHandle;
  }

  if (stdinWriteHandle == nullptr || stdinWriteHandle == INVALID_HANDLE_VALUE) {
    result.Reject(L"Terminal session stdin is not available.");
    return;
  }

  if (!text.empty()) {
    DWORD bytesWritten = 0;
    if (!WriteFile(
            stdinWriteHandle,
            text.data(),
            static_cast<DWORD>(text.size()),
            &bytesWritten,
            nullptr)) {
      result.Reject(L"Failed to write terminal stdin.");
      return;
    }
  }

  EmitSessionEvent(session, "stdin", text);
  result.Resolve();
}

} // namespace OpappWindowsHostModules
