#pragma once

#include <optional>
#include <string>

namespace OpappWindowsHost {

std::optional<std::string> RunScenePreviewWindow(std::wstring const &previewFile) noexcept;

} // namespace OpappWindowsHost
