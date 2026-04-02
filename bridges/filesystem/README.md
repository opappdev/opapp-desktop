# bridge-filesystem-windows

Windows native module implementation contract for `@opapp/framework-filesystem`.

## Native Module Name

`OpappFilesystem`

Register with `REACT_MODULE(OpappFilesystemModule, L"OpappFilesystem")`.

## Base Path

All `relativePath` arguments are resolved relative to the app's writable user
data directory (e.g., `%LOCALAPPDATA%\OPApp\`). The module must reject any path
that escapes this root (path traversal prevention).

The bridge now also manages one persisted trusted workspace root under:

- `%LOCALAPPDATA%\OPApp\agent-runtime\workspace-target.json`

Workspace-scoped methods resolve their `relativePath` arguments against that
trusted workspace root and reject any path that escapes it.

## Methods

### `getUserDataPath() → Promise<string>`

Returns the absolute path to the app's writable user data directory.  
Creates the directory if it does not exist.

```cpp
REACT_METHOD(GetUserDataPath, L"getUserDataPath")
void GetUserDataPath(
    winrt::Microsoft::ReactNative::ReactPromise<std::string> &&result) noexcept;
```

---

### `readFile(relativePath: string) → Promise<string | null>`

Reads a UTF-8 text file at `<dataDir>/<relativePath>`.  
Returns `null` (resolves with null, not rejects) if the file does not exist.  
Rejects only on unexpected I/O errors.

```cpp
REACT_METHOD(ReadFile, L"readFile")
void ReadFile(
    std::string relativePath,
    winrt::Microsoft::ReactNative::ReactPromise<std::optional<std::string>> &&result) noexcept;
```

---

### `writeFile(relativePath: string, content: string) → Promise<void>`

Writes `content` as UTF-8 to `<dataDir>/<relativePath>`.  
Creates intermediate directories as needed.  
Overwrites existing files atomically (write to `.tmp`, then rename).

```cpp
REACT_METHOD(WriteFile, L"writeFile")
void WriteFile(
    std::string relativePath,
    std::string content,
    winrt::Microsoft::ReactNative::ReactPromise<void> &&result) noexcept;
```

---

### `deleteFile(relativePath: string) → Promise<boolean>`

Deletes the file at `<dataDir>/<relativePath>`.  
Returns `true` if the file existed and was deleted, `false` if it did not exist.  
Rejects on unexpected I/O errors.

```cpp
REACT_METHOD(DeleteFile, L"deleteFile")
void DeleteFile(
    std::string relativePath,
    winrt::Microsoft::ReactNative::ReactPromise<bool> &&result) noexcept;
```

---

### `fileExists(relativePath: string) → Promise<boolean>`

Returns `true` if a file exists at `<dataDir>/<relativePath>`, otherwise `false`.

```cpp
REACT_METHOD(FileExists, L"fileExists")
void FileExists(
    std::string relativePath,
    winrt::Microsoft::ReactNative::ReactPromise<bool> &&result) noexcept;
```

---

## Trusted Workspace Methods

### `getTrustedWorkspaceTarget() → Promise<string | null>`

Returns the persisted trusted workspace payload as JSON:

```json
{"rootPath":"D:/code/opappdev","displayName":"opappdev","trusted":true}
```

Returns `null` if no trusted workspace root is configured.

### `setTrustedWorkspaceRoot(rootPath: string) → Promise<string>`

Validates that `rootPath` is an existing directory, normalizes it, persists it
under `agent-runtime/workspace-target.json`, and returns the same JSON payload
shape as `getTrustedWorkspaceTarget()`.

### `clearTrustedWorkspaceRoot() → Promise<void>`

Removes the persisted trusted workspace root.

### `readWorkspaceFile(relativePath: string) → Promise<string | null>`

Reads a UTF-8 text file from the trusted workspace. Returns `null` when the
target file does not exist.

### `listWorkspaceDirectory(relativePath: string) → Promise<string>`

Lists one directory level from the trusted workspace and returns a JSON array of
entries:

```json
[{"name":"src","relativePath":"src","kind":"directory","sizeBytes":null}]
```

### `statWorkspacePath(relativePath: string) → Promise<string | null>`

Returns one JSON entry for the requested workspace path, or `null` if the path
does not exist.

### `searchWorkspacePaths(query: string, relativePath: string, limit: number) → Promise<string>`

Recursively searches names and relative paths under the trusted workspace and
returns the same JSON entry shape as `listWorkspaceDirectory(...)`.
The current native implementation skips heavy directories such as `.git` and
`node_modules` during recursive search.

---

## Security Notes

- All paths must be validated to stay within `<dataDir>` (no `..` traversal).
- Trusted workspace operations must validate and normalize the configured root
  before persisting it.
- Trusted workspace search must avoid unbounded traversal of heavy dependency or
  VCS directories by default.
- All I/O operations must be dispatched off the UI thread using
  `reactContext.DefaultDispatcher()` or a background thread pool.
- `writeFile` must use atomic rename to prevent partial writes.

## Registration

Register in `AutolinkedNativeModules.g.cpp` (or the equivalent manual
registration point in `HostCore.cpp`):

```cpp
#include "FilesystemModule.h"

// Inside AddPackages / GetPackage:
packageBuilder.AddTurboModule(
    L"OpappFilesystem",
    winrt::make<OpappWindowsHostModules::OpappFilesystemModuleFactory>());
```
