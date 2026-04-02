#include "pch.h"

#include <algorithm>
#include <cwctype>
#include <filesystem>
#include <fstream>
#include <optional>
#include <sstream>
#include <thread>
#include <vector>

#include <winrt/Windows.Data.Json.h>

#include "NativeModules.h"

namespace OpappWindowsHostModules {

namespace {

namespace fs = std::filesystem;
namespace json = winrt::Windows::Data::Json;

constexpr wchar_t kAgentRuntimeDirectoryName[] = L"agent-runtime";
constexpr wchar_t kTrustedWorkspaceTargetFileName[] = L"workspace-target.json";
constexpr std::size_t kDefaultWorkspaceSearchLimit = 100;
constexpr std::size_t kMaxWorkspaceSearchLimit = 200;

struct TrustedWorkspaceTarget {
  fs::path RootPath;
  std::wstring DisplayName;
};

struct WorkspaceEntry {
  std::wstring Name;
  std::wstring RelativePath;
  bool IsDirectory;
  std::optional<uintmax_t> SizeBytes;
};

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

std::wstring FoldCase(std::wstring value) noexcept {
  std::transform(
      value.begin(),
      value.end(),
      value.begin(),
      [](wchar_t ch) { return static_cast<wchar_t>(std::towlower(ch)); });
  return value;
}

std::wstring TrimWhitespace(std::wstring value) {
  auto const first = value.find_first_not_of(L" \t\r\n");
  if (first == std::wstring::npos) {
    return {};
  }

  auto const last = value.find_last_not_of(L" \t\r\n");
  return value.substr(first, (last - first) + 1);
}

bool IsPathWithinRoot(
    fs::path const &rootPath,
    fs::path const &resolvedPath,
    bool allowRoot) noexcept {
  try {
    auto rel = resolvedPath.lexically_normal().lexically_relative(rootPath.lexically_normal());
    if (rel.empty()) {
      return allowRoot;
    }

    return *rel.begin() != fs::path(L"..");
  } catch (...) {
    return false;
  }
}

bool IsPathSafe(fs::path const &dataDir, fs::path const &resolved) noexcept {
  return IsPathWithinRoot(dataDir, resolved, false);
}

std::optional<fs::path> ResolveUserPath(std::string const &relativePath) noexcept {
  auto dataDir = GetUserDataDir();
  if (dataDir.empty()) {
    return std::nullopt;
  }
  auto dataDirPath = fs::path(dataDir);
  auto resolved = dataDirPath / fs::path(winrt::to_hstring(relativePath).c_str());
  if (!IsPathSafe(dataDirPath, resolved)) {
    return std::nullopt;
  }
  return resolved.lexically_normal();
}

std::optional<fs::path> ResolveManagedPath(
    fs::path const &rootPath,
    std::string const &relativePath,
    bool allowRoot) noexcept {
  try {
    auto relative = fs::path(winrt::to_hstring(relativePath).c_str());
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

bool WriteTextFileAtomically(
    fs::path const &targetPath,
    std::string const &content) noexcept {
  try {
    std::error_code ec;
    fs::create_directories(targetPath.parent_path(), ec);
    if (ec) {
      return false;
    }

    auto tempPath = targetPath;
    tempPath += L".tmp";
    {
      std::ofstream stream(tempPath, std::ios::binary | std::ios::trunc);
      if (!stream.is_open()) {
        return false;
      }

      stream.write(content.data(), static_cast<std::streamsize>(content.size()));
      if (!stream.good()) {
        return false;
      }
    }

    if (MoveFileExW(
            tempPath.c_str(),
            targetPath.c_str(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) == 0) {
      fs::remove(tempPath, ec);
      return false;
    }

    return true;
  } catch (...) {
    return false;
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

std::wstring BuildWorkspaceDisplayName(fs::path const &rootPath) {
  auto fileName = rootPath.filename().wstring();
  if (!fileName.empty()) {
    return fileName;
  }

  auto portable = rootPath.lexically_normal().generic_wstring();
  return portable.empty() ? rootPath.wstring() : portable;
}

std::optional<std::wstring> ReadJsonString(
    json::JsonObject const &payload,
    wchar_t const *key) noexcept {
  if (!payload.HasKey(key)) {
    return std::nullopt;
  }

  auto value = payload.GetNamedValue(key);
  if (value.ValueType() != json::JsonValueType::String) {
    return std::nullopt;
  }

  auto text = std::wstring(value.GetString().c_str());
  return text.empty() ? std::nullopt : std::optional<std::wstring>(text);
}

std::string ToPortableString(fs::path const &targetPath) {
  return winrt::to_string(winrt::hstring{targetPath.lexically_normal().generic_wstring()});
}

std::string SerializeTrustedWorkspaceTarget(TrustedWorkspaceTarget const &target) {
  json::JsonObject payload;
  payload.Insert(
      L"rootPath",
      json::JsonValue::CreateStringValue(
          winrt::to_hstring(ToPortableString(target.RootPath))));
  payload.Insert(
      L"displayName",
      json::JsonValue::CreateStringValue(winrt::hstring{target.DisplayName}));
  payload.Insert(L"trusted", json::JsonValue::CreateBooleanValue(true));
  return winrt::to_string(payload.Stringify());
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
    auto payload = json::JsonObject::Parse(winrt::to_hstring(*raw));
    auto rootPathValue = ReadJsonString(payload, L"rootPath");
    if (!rootPathValue || !payload.GetNamedBoolean(L"trusted", false)) {
      return std::nullopt;
    }

    auto normalizedRoot =
        NormalizeExistingDirectory(winrt::to_string(winrt::hstring{*rootPathValue}));
    if (!normalizedRoot) {
      return std::nullopt;
    }

    auto displayName =
        ReadJsonString(payload, L"displayName").value_or(BuildWorkspaceDisplayName(*normalizedRoot));
    return TrustedWorkspaceTarget{
        *normalizedRoot,
        displayName,
    };
  } catch (...) {
    return std::nullopt;
  }
}

bool PersistTrustedWorkspaceTarget(TrustedWorkspaceTarget const &target) noexcept {
  auto dataDir = GetUserDataDirPath();
  if (!dataDir) {
    return false;
  }

  return WriteTextFileAtomically(
      GetTrustedWorkspaceTargetPath(*dataDir),
      SerializeTrustedWorkspaceTarget(target));
}

bool ClearPersistedTrustedWorkspaceTarget() noexcept {
  auto dataDir = GetUserDataDirPath();
  if (!dataDir) {
    return false;
  }

  std::error_code ec;
  fs::remove(GetTrustedWorkspaceTargetPath(*dataDir), ec);
  return !ec;
}

std::optional<WorkspaceEntry> BuildWorkspaceEntry(
    fs::path const &workspaceRoot,
    fs::path const &targetPath) noexcept {
  try {
    std::error_code ec;
    auto status = fs::status(targetPath, ec);
    if (ec || status.type() == fs::file_type::not_found) {
      return std::nullopt;
    }

    auto const isDirectory = fs::is_directory(status);
    auto const isFile = fs::is_regular_file(status);
    if (!isDirectory && !isFile) {
      return std::nullopt;
    }

    auto relative = targetPath.lexically_normal().lexically_relative(workspaceRoot.lexically_normal());
    auto relativePath = relative.empty() ? std::wstring{} : relative.generic_wstring();
    auto name = targetPath.filename().wstring();
    if (name.empty()) {
      name = BuildWorkspaceDisplayName(targetPath);
    }

    std::optional<uintmax_t> sizeBytes;
    if (isFile) {
      auto size = fs::file_size(targetPath, ec);
      if (!ec) {
        sizeBytes = size;
      }
    }

    return WorkspaceEntry{
        name,
        relativePath,
        isDirectory,
        sizeBytes,
    };
  } catch (...) {
    return std::nullopt;
  }
}

json::JsonObject SerializeWorkspaceEntryObject(WorkspaceEntry const &entry) {
  json::JsonObject payload;
  payload.Insert(
      L"name",
      json::JsonValue::CreateStringValue(winrt::hstring{entry.Name}));
  payload.Insert(
      L"relativePath",
      json::JsonValue::CreateStringValue(winrt::hstring{entry.RelativePath}));
  payload.Insert(
      L"kind",
      json::JsonValue::CreateStringValue(
          entry.IsDirectory ? winrt::hstring{L"directory"} : winrt::hstring{L"file"}));
  if (entry.SizeBytes.has_value()) {
    payload.Insert(
        L"sizeBytes",
        json::JsonValue::CreateNumberValue(static_cast<double>(*entry.SizeBytes)));
  } else {
    payload.Insert(L"sizeBytes", json::JsonValue::CreateNullValue());
  }
  return payload;
}

std::string SerializeWorkspaceEntry(WorkspaceEntry const &entry) {
  return winrt::to_string(SerializeWorkspaceEntryObject(entry).Stringify());
}

std::string SerializeWorkspaceEntries(std::vector<WorkspaceEntry> const &entries) {
  json::JsonArray payload;
  for (auto const &entry : entries) {
    payload.Append(SerializeWorkspaceEntryObject(entry));
  }

  return winrt::to_string(payload.Stringify());
}

bool CompareWorkspaceEntries(WorkspaceEntry const &left, WorkspaceEntry const &right) {
  if (left.IsDirectory != right.IsDirectory) {
    return left.IsDirectory && !right.IsDirectory;
  }

  auto const leftName = FoldCase(left.Name);
  auto const rightName = FoldCase(right.Name);
  if (leftName == rightName) {
    return left.RelativePath < right.RelativePath;
  }

  return leftName < rightName;
}

std::vector<WorkspaceEntry> ListWorkspaceDirectoryEntries(
    fs::path const &workspaceRoot,
    fs::path const &directoryPath) noexcept {
  std::vector<WorkspaceEntry> entries;

  try {
    std::error_code ec;
    fs::directory_iterator iterator(
        directoryPath,
        fs::directory_options::skip_permission_denied,
        ec);
    for (; !ec && iterator != fs::directory_iterator(); iterator.increment(ec)) {
      auto entry = BuildWorkspaceEntry(workspaceRoot, iterator->path());
      if (entry) {
        entries.push_back(std::move(*entry));
      }
    }
  } catch (...) {
    entries.clear();
  }

  std::sort(entries.begin(), entries.end(), CompareWorkspaceEntries);
  return entries;
}

bool ShouldSkipSearchDirectory(fs::path const &path) noexcept {
  static constexpr wchar_t const *kIgnoredDirectories[] = {
      L".git",
      L"node_modules",
      L".pnpm",
      L".yarn",
      L".next",
      L".dist",
      L".tmp",
      L"dist",
      L"build",
  };

  auto name = FoldCase(path.filename().wstring());
  for (auto const *ignoredName : kIgnoredDirectories) {
    if (name == ignoredName) {
      return true;
    }
  }

  return false;
}

bool ContainsCaseInsensitive(
    std::wstring const &haystack,
    std::wstring const &query) noexcept {
  if (query.empty()) {
    return true;
  }

  return FoldCase(haystack).find(FoldCase(query)) != std::wstring::npos;
}

std::size_t NormalizeWorkspaceSearchLimit(int64_t requestedLimit) noexcept {
  if (requestedLimit <= 0) {
    return kDefaultWorkspaceSearchLimit;
  }

  if (requestedLimit > static_cast<int64_t>(kMaxWorkspaceSearchLimit)) {
    return kMaxWorkspaceSearchLimit;
  }

  return static_cast<std::size_t>(requestedLimit);
}

std::vector<WorkspaceEntry> SearchWorkspaceEntries(
    fs::path const &workspaceRoot,
    fs::path const &directoryPath,
    std::wstring const &query,
    std::size_t maxResults) noexcept {
  std::vector<WorkspaceEntry> matches;

  try {
    std::error_code ec;
    fs::recursive_directory_iterator iterator(
        directoryPath,
        fs::directory_options::skip_permission_denied,
        ec);
    auto const end = fs::recursive_directory_iterator{};
    while (!ec && iterator != end && matches.size() < maxResults) {
      auto const currentPath = iterator->path();
      bool const isDirectory = iterator->is_directory(ec);
      if (!ec && isDirectory && ShouldSkipSearchDirectory(currentPath)) {
        iterator.disable_recursion_pending();
      }
      ec.clear();

      auto entry = BuildWorkspaceEntry(workspaceRoot, currentPath);
      if (entry) {
        auto const candidate =
            entry->RelativePath.empty() ? entry->Name : entry->RelativePath;
        if (ContainsCaseInsensitive(candidate, query) ||
            ContainsCaseInsensitive(entry->Name, query)) {
          matches.push_back(std::move(*entry));
        }
      }

      iterator.increment(ec);
    }
  } catch (...) {
    matches.clear();
  }

  std::sort(matches.begin(), matches.end(), CompareWorkspaceEntries);
  return matches;
}

} // namespace

REACT_MODULE(OpappFilesystemModule, L"OpappFilesystem")
struct OpappFilesystemModule {
  REACT_INIT(Initialize)
  void Initialize(winrt::Microsoft::ReactNative::ReactContext const &reactContext) noexcept {
    m_reactContext = reactContext;
  }

  REACT_METHOD(GetUserDataPath, L"getUserDataPath")
  void GetUserDataPath(
      winrt::Microsoft::ReactNative::ReactPromise<std::string> &&result) noexcept {
    try {
      auto dataDir = GetUserDataDir();
      if (dataDir.empty()) {
        result.Reject(L"Unable to resolve user data directory.");
        return;
      }
      std::error_code ec;
      fs::create_directories(fs::path(dataDir), ec);
      result.Resolve(winrt::to_string(winrt::hstring{dataDir}));
    } catch (...) {
      result.Reject(L"Unexpected error in getUserDataPath.");
    }
  }

  REACT_METHOD(ReadFile, L"readFile")
  void ReadFile(
      std::string relativePath,
      winrt::Microsoft::ReactNative::ReactPromise<std::optional<std::string>> &&result) noexcept {
    try {
      auto resolved = ResolveUserPath(relativePath);
      if (!resolved) {
        result.Reject(L"Path traversal detected or invalid path.");
        return;
      }
      auto contents = ReadFileContents(*resolved);
      if (!contents) {
        result.Resolve(std::nullopt);
        return;
      }

      result.Resolve(*contents);
    } catch (...) {
      result.Reject(L"Unexpected I/O error in readFile.");
    }
  }

  REACT_METHOD(WriteFile, L"writeFile")
  void WriteFile(
      std::string relativePath,
      std::string content,
      winrt::Microsoft::ReactNative::ReactPromise<void> &&result) noexcept {
    try {
      auto resolved = ResolveUserPath(relativePath);
      if (!resolved) {
        result.Reject(L"Path traversal detected or invalid path.");
        return;
      }
      if (!WriteTextFileAtomically(*resolved, content)) {
        result.Reject(L"Atomic write failed.");
        return;
      }

      result.Resolve();
    } catch (...) {
      result.Reject(L"Unexpected I/O error in writeFile.");
    }
  }

  REACT_METHOD(DeleteFile, L"deleteFile")
  void DeleteFile(
      std::string relativePath,
      winrt::Microsoft::ReactNative::ReactPromise<bool> &&result) noexcept {
    try {
      auto resolved = ResolveUserPath(relativePath);
      if (!resolved) {
        result.Reject(L"Path traversal detected or invalid path.");
        return;
      }
      std::error_code ec;
      bool removed = fs::remove(*resolved, ec);
      if (ec) {
        result.Reject(L"I/O error during deleteFile.");
        return;
      }
      result.Resolve(removed);
    } catch (...) {
      result.Reject(L"Unexpected I/O error in deleteFile.");
    }
  }

  REACT_METHOD(FileExists, L"fileExists")
  void FileExists(
      std::string relativePath,
      winrt::Microsoft::ReactNative::ReactPromise<bool> &&result) noexcept {
    try {
      auto resolved = ResolveUserPath(relativePath);
      if (!resolved) {
        result.Reject(L"Path traversal detected or invalid path.");
        return;
      }
      std::error_code ec;
      bool exists = fs::is_regular_file(*resolved, ec);
      result.Resolve(!ec && exists);
    } catch (...) {
      result.Reject(L"Unexpected I/O error in fileExists.");
    }
  }

  REACT_METHOD(GetTrustedWorkspaceTarget, L"getTrustedWorkspaceTarget")
  void GetTrustedWorkspaceTarget(
      winrt::Microsoft::ReactNative::ReactPromise<std::optional<std::string>> &&result) noexcept {
    try {
      std::thread([result = std::move(result)]() mutable noexcept {
        auto target = ReadTrustedWorkspaceTarget();
        if (!target) {
          result.Resolve(std::nullopt);
          return;
        }

        result.Resolve(SerializeTrustedWorkspaceTarget(*target));
      }).detach();
    } catch (...) {
      result.Reject(L"Failed to schedule getTrustedWorkspaceTarget.");
    }
  }

  REACT_METHOD(SetTrustedWorkspaceRoot, L"setTrustedWorkspaceRoot")
  void SetTrustedWorkspaceRoot(
      std::string rootPath,
      winrt::Microsoft::ReactNative::ReactPromise<std::string> &&result) noexcept {
    try {
      std::thread([rootPath = std::move(rootPath), result = std::move(result)]() mutable noexcept {
        auto normalizedRoot = NormalizeExistingDirectory(rootPath);
        if (!normalizedRoot) {
          result.Reject(L"Trusted workspace root must be an existing directory.");
          return;
        }

        TrustedWorkspaceTarget target{
            *normalizedRoot,
            BuildWorkspaceDisplayName(*normalizedRoot),
        };
        if (!PersistTrustedWorkspaceTarget(target)) {
          result.Reject(L"Failed to persist trusted workspace root.");
          return;
        }

        result.Resolve(SerializeTrustedWorkspaceTarget(target));
      }).detach();
    } catch (...) {
      result.Reject(L"Failed to schedule setTrustedWorkspaceRoot.");
    }
  }

  REACT_METHOD(ClearTrustedWorkspaceRoot, L"clearTrustedWorkspaceRoot")
  void ClearTrustedWorkspaceRoot(
      winrt::Microsoft::ReactNative::ReactPromise<void> &&result) noexcept {
    try {
      std::thread([result = std::move(result)]() mutable noexcept {
        if (!ClearPersistedTrustedWorkspaceTarget()) {
          result.Reject(L"Failed to clear trusted workspace root.");
          return;
        }

        result.Resolve();
      }).detach();
    } catch (...) {
      result.Reject(L"Failed to schedule clearTrustedWorkspaceRoot.");
    }
  }

  REACT_METHOD(ReadWorkspaceFile, L"readWorkspaceFile")
  void ReadWorkspaceFile(
      std::string relativePath,
      winrt::Microsoft::ReactNative::ReactPromise<std::optional<std::string>> &&result) noexcept {
    try {
      std::thread([relativePath = std::move(relativePath), result = std::move(result)]() mutable noexcept {
        auto workspaceTarget = ReadTrustedWorkspaceTarget();
        if (!workspaceTarget) {
          result.Reject(L"No trusted workspace root is configured.");
          return;
        }

        auto resolved = ResolveManagedPath(workspaceTarget->RootPath, relativePath, false);
        if (!resolved) {
          result.Reject(L"Workspace path escapes the trusted workspace root.");
          return;
        }

        std::error_code ec;
        if (!fs::is_regular_file(*resolved, ec) || ec) {
          result.Resolve(std::nullopt);
          return;
        }

        auto contents = ReadFileContents(*resolved);
        if (!contents) {
          result.Resolve(std::nullopt);
          return;
        }

        result.Resolve(*contents);
      }).detach();
    } catch (...) {
      result.Reject(L"Failed to schedule readWorkspaceFile.");
    }
  }

  REACT_METHOD(ListWorkspaceDirectory, L"listWorkspaceDirectory")
  void ListWorkspaceDirectory(
      std::string relativePath,
      winrt::Microsoft::ReactNative::ReactPromise<std::string> &&result) noexcept {
    try {
      std::thread([relativePath = std::move(relativePath), result = std::move(result)]() mutable noexcept {
        auto workspaceTarget = ReadTrustedWorkspaceTarget();
        if (!workspaceTarget) {
          result.Reject(L"No trusted workspace root is configured.");
          return;
        }

        auto resolved = ResolveManagedPath(workspaceTarget->RootPath, relativePath, true);
        if (!resolved) {
          result.Reject(L"Workspace path escapes the trusted workspace root.");
          return;
        }

        std::error_code ec;
        if (!fs::exists(*resolved, ec) || ec || !fs::is_directory(*resolved, ec) || ec) {
          result.Reject(L"Workspace directory does not exist.");
          return;
        }

        result.Resolve(
            SerializeWorkspaceEntries(
                ListWorkspaceDirectoryEntries(workspaceTarget->RootPath, *resolved)));
      }).detach();
    } catch (...) {
      result.Reject(L"Failed to schedule listWorkspaceDirectory.");
    }
  }

  REACT_METHOD(StatWorkspacePath, L"statWorkspacePath")
  void StatWorkspacePath(
      std::string relativePath,
      winrt::Microsoft::ReactNative::ReactPromise<std::optional<std::string>> &&result) noexcept {
    try {
      std::thread([relativePath = std::move(relativePath), result = std::move(result)]() mutable noexcept {
        auto workspaceTarget = ReadTrustedWorkspaceTarget();
        if (!workspaceTarget) {
          result.Reject(L"No trusted workspace root is configured.");
          return;
        }

        auto resolved = ResolveManagedPath(workspaceTarget->RootPath, relativePath, true);
        if (!resolved) {
          result.Reject(L"Workspace path escapes the trusted workspace root.");
          return;
        }

        auto entry = BuildWorkspaceEntry(workspaceTarget->RootPath, *resolved);
        if (!entry) {
          result.Resolve(std::nullopt);
          return;
        }

        result.Resolve(SerializeWorkspaceEntry(*entry));
      }).detach();
    } catch (...) {
      result.Reject(L"Failed to schedule statWorkspacePath.");
    }
  }

  REACT_METHOD(SearchWorkspacePaths, L"searchWorkspacePaths")
  void SearchWorkspacePaths(
      std::string query,
      std::string relativePath,
      int64_t limit,
      winrt::Microsoft::ReactNative::ReactPromise<std::string> &&result) noexcept {
    try {
      std::thread([query = std::move(query),
                   relativePath = std::move(relativePath),
                   limit,
                   result = std::move(result)]() mutable noexcept {
        auto workspaceTarget = ReadTrustedWorkspaceTarget();
        if (!workspaceTarget) {
          result.Reject(L"No trusted workspace root is configured.");
          return;
        }

        auto searchRoot = ResolveManagedPath(workspaceTarget->RootPath, relativePath, true);
        if (!searchRoot) {
          result.Reject(L"Workspace path escapes the trusted workspace root.");
          return;
        }

        std::error_code ec;
        if (!fs::exists(*searchRoot, ec) || ec || !fs::is_directory(*searchRoot, ec) || ec) {
          result.Reject(L"Workspace search root does not exist.");
          return;
        }

        auto normalizedQuery =
            TrimWhitespace(std::wstring(winrt::to_hstring(query).c_str()));
        if (normalizedQuery.empty()) {
          result.Resolve(std::string("[]"));
          return;
        }

        result.Resolve(
            SerializeWorkspaceEntries(
                SearchWorkspaceEntries(
                    workspaceTarget->RootPath,
                    *searchRoot,
                    normalizedQuery,
                    NormalizeWorkspaceSearchLimit(limit))));
      }).detach();
    } catch (...) {
      result.Reject(L"Failed to schedule searchWorkspacePaths.");
    }
  }

 private:
  winrt::Microsoft::ReactNative::ReactContext m_reactContext;
};

} // namespace OpappWindowsHostModules
