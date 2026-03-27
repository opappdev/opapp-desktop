# bridge-filesystem-windows

Windows native module implementation contract for `@opapp/framework-filesystem`.

## Native Module Name

`OpappFilesystem`

Register with `REACT_MODULE(OpappFilesystemModule, L"OpappFilesystem")`.

## Base Path

All `relativePath` arguments are resolved relative to the app's writable user
data directory (e.g., `%LOCALAPPDATA%\OPApp\`). The module must reject any path
that escapes this root (path traversal prevention).

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

## Security Notes

- All paths must be validated to stay within `<dataDir>` (no `..` traversal).
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
