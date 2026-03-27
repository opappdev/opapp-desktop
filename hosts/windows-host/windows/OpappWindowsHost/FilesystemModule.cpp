#include "pch.h"

#include <filesystem>
#include <fstream>
#include <sstream>

#include "NativeModules.h"

namespace OpappWindowsHostModules {

namespace {

namespace fs = std::filesystem;

std::wstring GetUserDataDir() noexcept {
  wchar_t localAppData[MAX_PATH] = {};
  DWORD len = GetEnvironmentVariableW(L"LOCALAPPDATA", localAppData, MAX_PATH);
  if (len == 0 || len >= MAX_PATH) {
    return {};
  }
  return (fs::path(localAppData) / L"OPApp").wstring();
}

bool IsPathSafe(fs::path const &dataDir, fs::path const &resolved) noexcept {
  try {
    auto rel = resolved.lexically_normal().lexically_relative(dataDir.lexically_normal());
    if (rel.empty()) {
      return false;
    }
    return *rel.begin() != fs::path(L"..");
  } catch (...) {
    return false;
  }
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
      std::ifstream stream(*resolved, std::ios::binary);
      if (!stream.is_open()) {
        result.Resolve(std::nullopt);
        return;
      }
      std::ostringstream buffer;
      buffer << stream.rdbuf();
      result.Resolve(buffer.str());
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
      std::error_code ec;
      fs::create_directories(resolved->parent_path(), ec);
      if (ec) {
        result.Reject(L"Failed to create parent directories.");
        return;
      }
      auto tmpPath = *resolved;
      tmpPath += L".tmp";
      {
        std::ofstream stream(tmpPath, std::ios::binary | std::ios::trunc);
        if (!stream.is_open()) {
          result.Reject(L"Failed to open temp file for writing.");
          return;
        }
        stream.write(content.data(), static_cast<std::streamsize>(content.size()));
        if (!stream.good()) {
          result.Reject(L"Write to temp file failed.");
          return;
        }
      }
      fs::rename(tmpPath, *resolved, ec);
      if (ec) {
        fs::remove(tmpPath, ec);
        result.Reject(L"Atomic rename failed.");
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

 private:
  winrt::Microsoft::ReactNative::ReactContext m_reactContext;
};

} // namespace OpappWindowsHostModules
