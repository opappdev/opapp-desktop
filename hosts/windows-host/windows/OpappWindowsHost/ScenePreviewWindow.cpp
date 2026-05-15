#include "pch.h"
#include "ScenePreviewWindow.h"
#include "HostCore.h"

#include <DirectXMath.h>
#include <d3d11.h>
#include <d3dcompiler.h>
#include <dcomp.h>
#include <dxgi1_2.h>
#include <wincodec.h>
#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <optional>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <vector>
#include <windowsx.h>

#include <winrt/Windows.Data.Json.h>
#include <winrt/Windows.Foundation.Numerics.h>

#pragma comment(lib, "d3d11.lib")
#pragma comment(lib, "d3dcompiler.lib")
#pragma comment(lib, "dcomp.lib")
#pragma comment(lib, "dxgi.lib")
#pragma comment(lib, "windowscodecs.lib")

namespace OpappWindowsHost {
namespace {
using winrt::Windows::Data::Json::JsonArray;
using winrt::Windows::Data::Json::JsonObject;
using winrt::Windows::Foundation::Numerics::float3;

constexpr wchar_t kScenePreviewWindowClassName[] = L"OPAppScenePreviewWindow";
constexpr float kDefaultZoom = 1.0f;
constexpr float kMinZoom = 0.35f;
constexpr float kMaxZoom = 2.8f;
constexpr float kWindowScale = 420.0f;
constexpr DXGI_FORMAT kSwapChainFormat = DXGI_FORMAT_B8G8R8A8_UNORM;
constexpr DXGI_FORMAT kTextureFormat = DXGI_FORMAT_R8G8B8A8_UNORM;
constexpr DXGI_FORMAT kDepthFormat = DXGI_FORMAT_D24_UNORM_S8_UINT;

struct PreviewMeshPart {
  std::wstring Name;
  std::wstring MaterialName;
  std::filesystem::path PositionsFile;
  std::filesystem::path NormalsFile;
  std::filesystem::path Uv0File;
  std::filesystem::path IndicesFile;
  std::optional<std::filesystem::path> TextureFile;
  float3 BoundsMin{0.0f, 0.0f, 0.0f};
  float3 BoundsMax{0.0f, 0.0f, 0.0f};
  float3 TransformOffset{0.0f, 0.0f, 0.0f};
  std::optional<DirectX::XMFLOAT4> TintOverride;
  float LightingFloor{-1.0f};
  float EmissiveBoost{-1.0f};
  float AlphaCutoff{-1.0f};
};

struct PreviewFaceState {
  std::wstring Key;
  std::wstring Label;
  std::vector<PreviewMeshPart> Meshes;
};

struct ScenePreviewManifest {
  std::wstring DisplayName;
  std::filesystem::path RuntimeRoot;
  float3 ModelCenter{0.0f, 0.0f, 0.0f};
  float3 ModelSize{1.0f, 1.0f, 1.0f};
  bool HasModelBounds{false};
  float3 ViewTranslation{0.0f, 0.0f, 0.0f};
  float3 RotationDegrees{0.0f, 180.0f, 0.0f};
  float Scale{1.0f};
  std::vector<PreviewMeshPart> Meshes;
  std::wstring DefaultFaceStateKey;
  std::vector<PreviewFaceState> FaceStates;
  struct MotionKeyframe {
    float Time{0.0f};
    float3 Translation{0.0f, 0.0f, 0.0f};
    float3 RotationDegrees{0.0f, 0.0f, 0.0f};
  };
  struct MotionProfile {
    std::vector<std::wstring> Prefixes;
    float3 TranslationAmplitude{0.0f, 0.0f, 0.0f};
    float3 RotationDegreesAmplitude{0.0f, 0.0f, 0.0f};
    float Phase{0.0f};
    float Frequency{1.0f};
    std::wstring Anchor{L"mesh-center"};
    std::vector<MotionKeyframe> Keyframes;
  };
  struct AnimationConfig {
    bool Enabled{false};
    float LoopSeconds{0.0f};
    MotionProfile GlobalMotion{};
    std::vector<MotionProfile> MeshMotions;
    std::vector<std::wstring> Notes;
  };
  AnimationConfig Animation{};
};

struct PreviewVertex { DirectX::XMFLOAT3 Position; DirectX::XMFLOAT3 Normal; DirectX::XMFLOAT2 Uv; };
struct alignas(16) SceneConstants {
  DirectX::XMFLOAT4X4 World;
  DirectX::XMFLOAT4X4 WorldViewProjection;
  DirectX::XMFLOAT4 Tint;
  DirectX::XMFLOAT4 Options;
  DirectX::XMFLOAT4 LightDirection;
};
struct GpuMeshPart {
  std::wstring Name;
  std::wstring MaterialName;
  uint32_t IndexCount{0};
  DirectX::XMFLOAT4 Tint{1.0f, 1.0f, 1.0f, 1.0f};
  float LightingFloor{-1.0f};
  float EmissiveBoost{-1.0f};
  float AlphaCutoff{-1.0f};
  bool UseTexture{false};
  float3 BoundsMin{0.0f, 0.0f, 0.0f};
  float3 BoundsMax{0.0f, 0.0f, 0.0f};
  float3 TransformOffset{0.0f, 0.0f, 0.0f};
  winrt::com_ptr<ID3D11Buffer> VertexBuffer;
  winrt::com_ptr<ID3D11Buffer> IndexBuffer;
  winrt::com_ptr<ID3D11ShaderResourceView> TextureView;
};

struct GpuFaceState {
  std::wstring Key;
  std::wstring Label;
  std::vector<GpuMeshPart> Meshes;
};

std::optional<std::wstring> ReadTextFile(std::filesystem::path const &path) noexcept {
  try {
    std::ifstream stream(path, std::ios::binary);
    if (!stream.is_open()) return std::nullopt;
    std::string contents((std::istreambuf_iterator<char>(stream)), std::istreambuf_iterator<char>());
    auto text = winrt::to_hstring(contents);
    return std::wstring(text.c_str(), text.size());
  } catch (...) { return std::nullopt; }
}

std::optional<std::vector<uint8_t>> ReadBinaryFile(std::filesystem::path const &path) noexcept {
  try {
    std::ifstream stream(path, std::ios::binary);
    if (!stream.is_open()) return std::nullopt;
    stream.seekg(0, std::ios::end);
    auto length = stream.tellg();
    stream.seekg(0, std::ios::beg);
    if (length < 0) return std::nullopt;
    std::vector<uint8_t> bytes(static_cast<size_t>(length));
    if (!bytes.empty()) stream.read(reinterpret_cast<char *>(bytes.data()), static_cast<std::streamsize>(bytes.size()));
    return bytes;
  } catch (...) { return std::nullopt; }
}

template <typename T>
std::optional<std::vector<T>> ReadPodFile(std::filesystem::path const &path) noexcept {
  auto bytes = ReadBinaryFile(path);
  if (!bytes || bytes->empty() || (bytes->size() % sizeof(T)) != 0) return std::nullopt;
  std::vector<T> values(bytes->size() / sizeof(T));
  std::memcpy(values.data(), bytes->data(), bytes->size());
  return values;
}

std::optional<float> ReadJsonNumber(JsonArray const &array, uint32_t index) noexcept {
  try { return static_cast<float>(array.GetAt(index).GetNumber()); } catch (...) { return std::nullopt; }
}

std::optional<float3> ReadFloat3(JsonObject const &value, wchar_t const *field) noexcept {
  try {
    auto values = value.GetNamedArray(field);
    if (values.Size() < 3) return std::nullopt;
    auto x = ReadJsonNumber(values, 0); auto y = ReadJsonNumber(values, 1); auto z = ReadJsonNumber(values, 2);
    if (!x || !y || !z) return std::nullopt;
    return float3{*x, *y, *z};
  } catch (...) { return std::nullopt; }
}

std::optional<float3> ReadFloat3(JsonArray const &values) noexcept {
  try {
    if (values.Size() < 3) return std::nullopt;
    auto x = ReadJsonNumber(values, 0); auto y = ReadJsonNumber(values, 1); auto z = ReadJsonNumber(values, 2);
    if (!x || !y || !z) return std::nullopt;
    return float3{*x, *y, *z};
  } catch (...) { return std::nullopt; }
}

std::optional<float> ReadOptionalJsonNumber(JsonObject const &value, wchar_t const *field) noexcept {
  try {
    if (auto numberValue = value.TryLookup(field)) {
      return static_cast<float>(numberValue.GetNumber());
    }
  } catch (...) {}
  return std::nullopt;
}

std::optional<DirectX::XMFLOAT4> ReadFloat4(JsonObject const &value, wchar_t const *field) noexcept {
  try {
    auto values = value.GetNamedArray(field);
    if (values.Size() < 4) return std::nullopt;
    auto x = ReadJsonNumber(values, 0); auto y = ReadJsonNumber(values, 1);
    auto z = ReadJsonNumber(values, 2); auto w = ReadJsonNumber(values, 3);
    if (!x || !y || !z || !w) return std::nullopt;
    return DirectX::XMFLOAT4{*x, *y, *z, *w};
  } catch (...) { return std::nullopt; }
}

std::filesystem::path ResolvePath(std::filesystem::path const &root, std::wstring const &relativePath) {
  return (root / std::filesystem::path(relativePath)).lexically_normal();
}

void AppendPreviewMeshes(JsonArray const &meshes, std::filesystem::path const &runtimeRoot, std::vector<PreviewMeshPart> &target) {
  for (uint32_t index = 0; index < meshes.Size(); index += 1) {
    auto meshObject = meshes.GetObjectAt(index);
    PreviewMeshPart mesh{};
    auto name = meshObject.GetNamedString(L"name");
    auto materialName = meshObject.GetNamedString(L"material_name", L"");
    auto positionsFile = meshObject.GetNamedString(L"positions_file");
    auto normalsFile = meshObject.GetNamedString(L"normals_file");
    auto uv0File = meshObject.GetNamedString(L"uv0_file");
    auto indicesFile = meshObject.GetNamedString(L"indices_file");
    mesh.Name.assign(name.c_str(), name.size());
    mesh.MaterialName.assign(materialName.c_str(), materialName.size());
    mesh.PositionsFile = ResolvePath(runtimeRoot, std::wstring(positionsFile.c_str(), positionsFile.size()));
    mesh.NormalsFile = ResolvePath(runtimeRoot, std::wstring(normalsFile.c_str(), normalsFile.size()));
    mesh.Uv0File = ResolvePath(runtimeRoot, std::wstring(uv0File.c_str(), uv0File.size()));
    mesh.IndicesFile = ResolvePath(runtimeRoot, std::wstring(indicesFile.c_str(), indicesFile.size()));
    if (auto textureValue = meshObject.TryLookup(L"texture_file")) {
      try {
        auto texturePath = textureValue.GetString();
        if (!texturePath.empty()) {
          mesh.TextureFile = ResolvePath(runtimeRoot, std::wstring(texturePath.c_str(), texturePath.size()));
        }
      } catch (...) {}
    }
    if (auto boundsValue = meshObject.TryLookup(L"bounds")) {
      try {
        auto boundsObject = boundsValue.GetObject();
        if (auto boundsMin = ReadFloat3(boundsObject, L"min")) mesh.BoundsMin = *boundsMin;
        if (auto boundsMax = ReadFloat3(boundsObject, L"max")) mesh.BoundsMax = *boundsMax;
      } catch (...) {}
    }
    if (auto transformOffsetValue = meshObject.TryLookup(L"transform_offset")) {
      try {
        if (auto transformOffset = ReadFloat3(transformOffsetValue.GetArray())) {
          mesh.TransformOffset = *transformOffset;
        }
      } catch (...) {}
    }
    if (auto renderOptionsValue = meshObject.TryLookup(L"render_options")) {
      try {
        auto renderOptions = renderOptionsValue.GetObject();
        if (auto tint = ReadFloat4(renderOptions, L"tint")) mesh.TintOverride = *tint;
        if (auto lightingFloor = ReadOptionalJsonNumber(renderOptions, L"lighting_floor")) {
          mesh.LightingFloor = std::clamp(*lightingFloor, 0.0f, 1.5f);
        }
        if (auto emissiveBoost = ReadOptionalJsonNumber(renderOptions, L"emissive_boost")) {
          mesh.EmissiveBoost = std::clamp(*emissiveBoost, 0.0f, 1.0f);
        }
        if (auto alphaCutoff = ReadOptionalJsonNumber(renderOptions, L"alpha_cutoff")) {
          mesh.AlphaCutoff = std::clamp(*alphaCutoff, 0.0f, 1.0f);
        }
      } catch (...) {}
    }
    target.push_back(std::move(mesh));
  }
}

ScenePreviewManifest::MotionProfile ReadMotionProfile(JsonObject const &value) {
  ScenePreviewManifest::MotionProfile profile{};
  if (auto prefixesValue = value.TryLookup(L"prefixes")) {
    auto prefixes = prefixesValue.GetArray();
    for (uint32_t index = 0; index < prefixes.Size(); index += 1) {
      auto prefix = prefixes.GetStringAt(index);
      profile.Prefixes.emplace_back(prefix.c_str(), prefix.size());
    }
  }
  if (auto translationValue = value.TryLookup(L"translation")) {
    if (auto translation = ReadFloat3(translationValue.GetArray())) profile.TranslationAmplitude = *translation;
  }
  if (auto rotationValue = value.TryLookup(L"rotation_degrees")) {
    if (auto rotation = ReadFloat3(rotationValue.GetArray())) profile.RotationDegreesAmplitude = *rotation;
  }
  try { profile.Phase = static_cast<float>(value.GetNamedNumber(L"phase", 0.0)); } catch (...) {}
  try { profile.Frequency = static_cast<float>(value.GetNamedNumber(L"frequency", 1.0)); } catch (...) {}
  try {
    auto anchor = value.GetNamedString(L"anchor", L"mesh-center");
    profile.Anchor.assign(anchor.c_str(), anchor.size());
  } catch (...) {}
  if (auto keyframesValue = value.TryLookup(L"keyframes")) {
    try {
      auto keyframes = keyframesValue.GetArray();
      for (uint32_t index = 0; index < keyframes.Size(); index += 1) {
        auto keyframeObject = keyframes.GetObjectAt(index);
        ScenePreviewManifest::MotionKeyframe keyframe{};
        try { keyframe.Time = static_cast<float>(keyframeObject.GetNamedNumber(L"time", 0.0)); } catch (...) {}
        if (auto translationValue = keyframeObject.TryLookup(L"translation")) {
          if (auto translation = ReadFloat3(translationValue.GetArray())) keyframe.Translation = *translation;
        }
        if (auto rotationValue = keyframeObject.TryLookup(L"rotation_degrees")) {
          if (auto rotation = ReadFloat3(rotationValue.GetArray())) keyframe.RotationDegrees = *rotation;
        }
        profile.Keyframes.push_back(keyframe);
      }
      std::sort(profile.Keyframes.begin(), profile.Keyframes.end(), [](auto const &lhs, auto const &rhs) {
        return lhs.Time < rhs.Time;
      });
    } catch (...) {}
  }
  return profile;
}

DirectX::XMFLOAT4 ResolveFallbackMaterialColor(std::wstring const &materialName) noexcept {
  if (materialName.find(L"Character") != std::wstring::npos) return {0.98f, 0.73f, 0.82f, 1.0f};
  if (materialName.find(L"FrontHair") != std::wstring::npos) return {0.86f, 0.48f, 0.78f, 1.0f};
  if (materialName.find(L"BackFace") != std::wstring::npos) return {0.25f, 0.22f, 0.38f, 1.0f};
  if (materialName.find(L"ShapeFace") != std::wstring::npos) return {1.0f, 0.84f, 0.80f, 1.0f};
  if (materialName.find(L"ShapeEye") != std::wstring::npos) return {0.93f, 0.34f, 0.58f, 1.0f};
  if (materialName.find(L"InnerMouth") != std::wstring::npos) return {0.72f, 0.24f, 0.35f, 1.0f};
  if (materialName.find(L"Emissive") != std::wstring::npos) return {0.35f, 0.86f, 0.92f, 1.0f};
  return {0.82f, 0.62f, 0.92f, 1.0f};
}

DirectX::XMFLOAT4 ResolveFallbackMeshColor(PreviewMeshPart const &meshPart) noexcept {
  if (meshPart.Name.find(L"Eye_Mesh_") != std::wstring::npos) return {0.44f, 0.12f, 0.26f, 1.0f};
  if (meshPart.Name.find(L"Mouth_Mesh_") != std::wstring::npos) return {0.74f, 0.18f, 0.34f, 0.95f};
  return ResolveFallbackMaterialColor(meshPart.MaterialName);
}

DirectX::XMFLOAT4 ResolvePreviewMaterialTint(PreviewMeshPart const &meshPart) noexcept {
  auto const &materialName = meshPart.MaterialName;
  if (materialName.find(L"Character") != std::wstring::npos) return {0.84f, 0.82f, 0.84f, 1.0f};
  if (materialName.find(L"Equipment") != std::wstring::npos) return {0.96f, 1.0f, 1.08f, 1.0f};
  if (materialName.find(L"ShapeFace") != std::wstring::npos) return {0.86f, 0.83f, 0.84f, 1.0f};
  if (materialName.find(L"BackFace") != std::wstring::npos) return {0.92f, 0.90f, 0.96f, 1.0f};
  return {1.0f, 1.0f, 1.0f, 1.0f};
}

int ComputeInitialWindowExtent(float scale, float fallback) noexcept {
  auto scaled = static_cast<int>(std::round(std::max(scale, 0.25f) * kWindowScale));
  return std::max(scaled, static_cast<int>(fallback));
}

RECT ResolveInitialWindowRect(int width, int height) noexcept {
  RECT workArea{};
  if (!SystemParametersInfoW(SPI_GETWORKAREA, 0, &workArea, 0)) {
    return RECT{CW_USEDEFAULT, CW_USEDEFAULT, CW_USEDEFAULT + width, CW_USEDEFAULT + height};
  }

  auto workWidth = std::max(static_cast<int>(workArea.right - workArea.left), width);
  auto workHeight = std::max(static_cast<int>(workArea.bottom - workArea.top), height);
  auto x = workArea.left + std::max((workWidth - width) / 2, 0);
  auto y = workArea.top + std::max((workHeight - height) / 2, 0);
  return RECT{x, y, x + width, y + height};
}

DirectX::XMVECTOR QuaternionFromEulerDegrees(float3 const &degrees) noexcept {
  return DirectX::XMQuaternionRotationRollPitchYaw(
      DirectX::XMConvertToRadians(degrees.x),
      DirectX::XMConvertToRadians(degrees.y),
      DirectX::XMConvertToRadians(degrees.z));
}

float EvaluateIdleWave(float timeSeconds, float loopSeconds, float frequency, float phase) noexcept {
  auto safeLoop = std::max(loopSeconds, 0.1f);
  auto radians = (timeSeconds / safeLoop) * DirectX::XM_2PI * std::max(frequency, 0.01f) + phase;
  auto primary = std::sin(radians);
  auto secondary = std::sin((radians * 1.87f) + (phase * 1.41f)) * 0.32f;
  return primary + secondary;
}

float3 LerpFloat3(float3 const &from, float3 const &to, float alpha) noexcept {
  auto clamped = std::clamp(alpha, 0.0f, 1.0f);
  return float3{
      from.x + ((to.x - from.x) * clamped),
      from.y + ((to.y - from.y) * clamped),
      from.z + ((to.z - from.z) * clamped),
  };
}
std::optional<ScenePreviewManifest> LoadScenePreviewManifest(std::wstring const &previewFile, std::string &error) noexcept {
  try {
    auto previewPath = std::filesystem::path(previewFile).lexically_normal();
    if (!std::filesystem::exists(previewPath)) {
      error = "preview-file-missing";
      return std::nullopt;
    }

    auto contents = ReadTextFile(previewPath);
    if (!contents) {
      error = "preview-file-read-failed";
      return std::nullopt;
    }

    auto jsonObject = JsonObject::Parse(*contents);
    ScenePreviewManifest manifest{};
    auto runtimeRoot = previewPath.parent_path();
    if (runtimeRoot.filename() == L"preview") runtimeRoot = runtimeRoot.parent_path();
    manifest.RuntimeRoot = runtimeRoot;

    try {
      auto selectionObject = jsonObject.GetNamedObject(L"selection");
      auto displayName = selectionObject.GetNamedString(L"display_name", L"");
      if (!displayName.empty()) manifest.DisplayName.assign(displayName.c_str(), displayName.size());
    } catch (...) {}
    if (manifest.DisplayName.empty()) manifest.DisplayName = previewPath.stem().wstring();

    if (auto viewValue = jsonObject.TryLookup(L"view")) {
      auto viewObject = viewValue.GetObject();
      if (auto translation = ReadFloat3(viewObject, L"translation")) manifest.ViewTranslation = *translation;
      if (auto rotationDegrees = ReadFloat3(viewObject, L"rotation_degrees")) manifest.RotationDegrees = *rotationDegrees;
      try { manifest.Scale = static_cast<float>(viewObject.GetNamedNumber(L"scale", 1.0)); } catch (...) {}
    }
    if (auto modelValue = jsonObject.TryLookup(L"model")) {
      auto modelObject = modelValue.GetObject();
      if (auto center = ReadFloat3(modelObject, L"center")) { manifest.ModelCenter = *center; manifest.HasModelBounds = true; }
      if (auto size = ReadFloat3(modelObject, L"size")) { manifest.ModelSize = *size; manifest.HasModelBounds = true; }
    }

    AppendPreviewMeshes(jsonObject.GetNamedArray(L"meshes"), runtimeRoot, manifest.Meshes);

    if (auto statesValue = jsonObject.TryLookup(L"states")) {
      auto statesObject = statesValue.GetObject();
      auto defaultFaceState = statesObject.GetNamedString(L"default_face_state", L"");
      manifest.DefaultFaceStateKey.assign(defaultFaceState.c_str(), defaultFaceState.size());
      if (auto faceStatesValue = statesObject.TryLookup(L"face_states")) {
        auto faceStates = faceStatesValue.GetArray();
        for (uint32_t index = 0; index < faceStates.Size(); index += 1) {
          auto faceStateObject = faceStates.GetObjectAt(index);
          PreviewFaceState faceState{};
          auto key = faceStateObject.GetNamedString(L"key", L"");
          auto label = faceStateObject.GetNamedString(L"label", L"");
          faceState.Key.assign(key.c_str(), key.size());
          faceState.Label.assign(label.c_str(), label.size());
          AppendPreviewMeshes(faceStateObject.GetNamedArray(L"meshes"), runtimeRoot, faceState.Meshes);
          if (!faceState.Meshes.empty()) manifest.FaceStates.push_back(std::move(faceState));
        }
      }
    }

    if (auto animationValue = jsonObject.TryLookup(L"animation")) {
      try {
        auto animationObject = animationValue.GetObject();
        manifest.Animation.Enabled = true;
        manifest.Animation.LoopSeconds = static_cast<float>(animationObject.GetNamedNumber(L"loop_seconds", 0.0));
        if (auto globalMotionValue = animationObject.TryLookup(L"global_motion")) {
          manifest.Animation.GlobalMotion = ReadMotionProfile(globalMotionValue.GetObject());
        }
        if (auto meshMotionsValue = animationObject.TryLookup(L"mesh_motions")) {
          auto meshMotions = meshMotionsValue.GetArray();
          for (uint32_t index = 0; index < meshMotions.Size(); index += 1) {
            manifest.Animation.MeshMotions.push_back(ReadMotionProfile(meshMotions.GetObjectAt(index)));
          }
        }
        if (auto notesValue = animationObject.TryLookup(L"notes")) {
          auto notes = notesValue.GetArray();
          for (uint32_t index = 0; index < notes.Size(); index += 1) {
            auto note = notes.GetStringAt(index);
            manifest.Animation.Notes.emplace_back(note.c_str(), note.size());
          }
        }
      } catch (...) {
        manifest.Animation = {};
      }
    }

    if (manifest.Meshes.empty()) {
      error = "preview-meshes-empty";
      return std::nullopt;
    }
    return manifest;
  } catch (winrt::hresult_error const &exception) {
    error = "preview-manifest-parse-failed:" + ToUtf8(exception.message());
    return std::nullopt;
  } catch (std::exception const &exception) {
    error = std::string("preview-manifest-exception:") + exception.what();
    return std::nullopt;
  } catch (...) {
    error = "preview-manifest-unknown";
    return std::nullopt;
  }
}

class ScenePreviewWindow {
 public:
  explicit ScenePreviewWindow(ScenePreviewManifest manifest) : m_manifest(std::move(manifest)) {
    DirectX::XMStoreFloat4(&m_baseRotation, QuaternionFromEulerDegrees(m_manifest.RotationDegrees));
  }

  std::optional<std::string> Run() noexcept {
    try {
      WNDCLASSEXW windowClass{};
      windowClass.cbSize = sizeof(windowClass);
      windowClass.style = CS_HREDRAW | CS_VREDRAW | CS_DBLCLKS;
      windowClass.lpfnWndProc = &ScenePreviewWindow::WndProcThunk;
      windowClass.hInstance = GetModuleHandleW(nullptr);
      windowClass.hCursor = LoadCursorW(nullptr, IDC_ARROW);
      windowClass.hIcon = LoadIconW(nullptr, IDI_APPLICATION);
      windowClass.hbrBackground = nullptr;
      windowClass.lpszClassName = kScenePreviewWindowClassName;
      RegisterClassExW(&windowClass);

      auto width = ComputeInitialWindowExtent(m_manifest.Scale * 1.35f, 720.0f);
      auto height = ComputeInitialWindowExtent(m_manifest.Scale * 1.95f, 920.0f);
      auto initialRect = ResolveInitialWindowRect(width, height);
      auto title = L"OPApp Avatar Preview - " + m_manifest.DisplayName;
      m_windowTitle = title;

      m_hwnd = CreateWindowExW(
          WS_EX_NOREDIRECTIONBITMAP | WS_EX_TOOLWINDOW | WS_EX_TOPMOST,
          kScenePreviewWindowClassName,
          title.c_str(),
          WS_POPUP | WS_VISIBLE,
          initialRect.left,
          initialRect.top,
          width,
          height,
          nullptr,
          nullptr,
          GetModuleHandleW(nullptr),
          this);
      if (!m_hwnd) return std::string("scene-preview-window-create-failed");
      AppendLog(
          "ScenePreview.WindowRect=" + std::to_string(initialRect.left) + "," + std::to_string(initialRect.top) +
          " " + std::to_string(width) + "x" + std::to_string(height));

      ShowWindow(m_hwnd, SW_SHOW);
      UpdateWindow(m_hwnd);
      MSG message{};
      while (GetMessageW(&message, nullptr, 0, 0) > 0) {
        TranslateMessage(&message);
        DispatchMessageW(&message);
      }
      return m_startupError;
    } catch (winrt::hresult_error const &exception) {
      return "scene-preview-run-failed:" + ToUtf8(exception.message());
    } catch (std::exception const &exception) {
      return std::string("scene-preview-run-exception:") + exception.what();
    } catch (...) {
      return std::string("scene-preview-run-unknown");
    }
  }

 private:
  static constexpr char kShaderSource[] = R"(
cbuffer SceneConstants : register(b0) { row_major float4x4 World; row_major float4x4 WorldViewProjection; float4 Tint; float4 Options; float4 LightDirection; };
struct VSInput { float3 Position : POSITION; float3 Normal : NORMAL; float2 Uv : TEXCOORD0; };
struct PSInput { float4 Position : SV_POSITION; float3 Normal : NORMAL; float2 Uv : TEXCOORD0; };
PSInput VSMain(VSInput input) { PSInput o; o.Position = mul(float4(input.Position, 1.0f), WorldViewProjection); o.Normal = mul(float4(input.Normal, 0.0f), World).xyz; o.Uv = input.Uv; return o; }
Texture2D BaseTexture : register(t0); SamplerState BaseSampler : register(s0);
float4 PSMain(PSInput input) : SV_TARGET { float4 sampled = Options.x > 0.5f ? BaseTexture.Sample(BaseSampler, input.Uv) : float4(1,1,1,1); if (sampled.a < Options.y) discard; float3 n = normalize(input.Normal); float3 key = normalize(-LightDirection.xyz); float3 fill = normalize(float3(-key.x * 0.38f, 0.55f, -key.z * 0.24f)); float keyLit = saturate(dot(n, key)); float fillLit = saturate(dot(n, fill)); float3 lighting = float3(0.54f, 0.53f, 0.56f) + (keyLit * float3(0.24f, 0.22f, 0.20f)) + (fillLit * float3(0.10f, 0.11f, 0.13f)); lighting = max(lighting, float3(Options.z, Options.z, Options.z)); float3 color = sampled.rgb * Tint.rgb * lighting; color += sampled.rgb * Tint.rgb * Options.w; float alpha = sampled.a * Tint.a; return float4(saturate(color) * alpha, alpha); }
  )";

  static LRESULT CALLBACK WndProcThunk(HWND hwnd, UINT message, WPARAM wParam, LPARAM lParam) noexcept {
    auto *self = reinterpret_cast<ScenePreviewWindow *>(GetWindowLongPtrW(hwnd, GWLP_USERDATA));
    if (message == WM_NCCREATE) {
      auto *createStruct = reinterpret_cast<CREATESTRUCTW *>(lParam);
      self = reinterpret_cast<ScenePreviewWindow *>(createStruct->lpCreateParams);
      SetWindowLongPtrW(hwnd, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(self));
      if (self) self->m_hwnd = hwnd;
    }
    return self ? self->WndProc(message, wParam, lParam) : DefWindowProcW(hwnd, message, wParam, lParam);
  }

  LRESULT WndProc(UINT message, WPARAM wParam, LPARAM lParam) noexcept {
    switch (message) {
      case WM_CREATE:
        if (!InitializeRenderer()) return -1;
        SetTimer(m_hwnd, 1, 16, nullptr);
        RenderFrame();
        return 0;
      case WM_DESTROY:
        KillTimer(m_hwnd, 1);
        PostQuitMessage(0);
        return 0;
      case WM_ERASEBKGND:
        return 1;
      case WM_PAINT: {
        PAINTSTRUCT paint{};
        BeginPaint(m_hwnd, &paint);
        RenderFrame();
        EndPaint(m_hwnd, &paint);
        return 0;
      }
      case WM_TIMER:
        if (wParam == 1) {
          RenderFrame();
          return 0;
        }
        break;
      case WM_SIZE:
        if (wParam == SIZE_MINIMIZED) {
          m_clientWidth = 0;
          m_clientHeight = 0;
          return 0;
        }
        ResizeSwapChain();
        RenderFrame();
        return 0;
      case WM_LBUTTONDOWN:
        m_dragging = true;
        m_lastPointer = POINT{GET_X_LPARAM(lParam), GET_Y_LPARAM(lParam)};
        SetCapture(m_hwnd);
        return 0;
      case WM_MOUSEMOVE:
        if (m_dragging) {
          POINT current{GET_X_LPARAM(lParam), GET_Y_LPARAM(lParam)};
          m_userYawDegrees += static_cast<float>(current.x - m_lastPointer.x) * 0.45f;
          m_userPitchDegrees = std::clamp(m_userPitchDegrees + static_cast<float>(current.y - m_lastPointer.y) * 0.25f, -28.0f, 22.0f);
          m_lastPointer = current;
          RenderFrame();
        }
        return 0;
      case WM_LBUTTONUP:
        if (m_dragging) {
          m_dragging = false;
          ReleaseCapture();
        }
        return 0;
      case WM_MOUSEWHEEL:
        m_zoom = std::clamp(m_zoom + (GET_WHEEL_DELTA_WPARAM(wParam) > 0 ? 0.1f : -0.1f), kMinZoom, kMaxZoom);
        RenderFrame();
        return 0;
      case WM_LBUTTONDBLCLK:
      case WM_RBUTTONUP:
        ResetInteraction();
        return 0;
      case WM_KEYDOWN:
        if (wParam == VK_ESCAPE) {
          DestroyWindow(m_hwnd);
          return 0;
        }
        if (wParam == 'R') {
          ResetInteraction();
          return 0;
        }
        if (TrySelectFaceStateFromKey(wParam)) {
          return 0;
        }
        break;
    }
    return DefWindowProcW(m_hwnd, message, wParam, lParam);
  }

  bool InitializeRenderer() noexcept {
    try {
      AppendLog("ScenePreview.Initialize title=" + ToUtf8(m_windowTitle));
      UINT flags = D3D11_CREATE_DEVICE_BGRA_SUPPORT;
      D3D_FEATURE_LEVEL levels[] = {D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_10_1, D3D_FEATURE_LEVEL_10_0};
      D3D_FEATURE_LEVEL featureLevel{};
      winrt::check_hresult(D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, flags, levels, static_cast<UINT>(std::size(levels)), D3D11_SDK_VERSION, m_device.put(), &featureLevel, m_context.put()));
      auto dxgiDevice = m_device.as<IDXGIDevice>();
      winrt::com_ptr<IDXGIAdapter> adapter;
      winrt::check_hresult(dxgiDevice->GetAdapter(adapter.put()));
      winrt::check_hresult(adapter->GetParent(__uuidof(IDXGIFactory2), m_dxgiFactory.put_void()));
      m_dxgiFactory->MakeWindowAssociation(m_hwnd, DXGI_MWA_NO_ALT_ENTER);
      InitializeWicFactory();
      CreateSwapChain();
      CreatePipelineResources();
      CreateFallbackTexture();
      if (!LoadMeshes()) return false;
      ResolveDefaultFaceState();
      if (!ResizeSwapChain()) return false;
      UpdateWindowTitle();
      if (m_manifest.Animation.Enabled) {
        AppendLog(
            "ScenePreview.AnimationReady loopSeconds=" + std::to_string(m_manifest.Animation.LoopSeconds) +
            " meshMotions=" + std::to_string(m_manifest.Animation.MeshMotions.size()));
      }
      AppendLog("ScenePreview.InitializeReady baseMeshes=" + std::to_string(m_meshes.size()) + " faceStates=" + std::to_string(m_faceStates.size()));
      return true;
    } catch (winrt::hresult_error const &exception) {
      m_startupError = "scene-preview-renderer-init-failed:" + ToUtf8(exception.message());
      AppendLog("ScenePreview.InitializeFailed reason=" + *m_startupError);
      return false;
    } catch (std::exception const &exception) {
      m_startupError = std::string("scene-preview-renderer-init-exception:") + exception.what();
      AppendLog("ScenePreview.InitializeFailed reason=" + *m_startupError);
      return false;
    } catch (...) {
      m_startupError = "scene-preview-renderer-init-unknown";
      AppendLog("ScenePreview.InitializeFailed reason=" + *m_startupError);
      return false;
    }
  }

  void InitializeWicFactory() {
    if (m_wicFactory) return;
    auto hr = CoCreateInstance(CLSID_WICImagingFactory2, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(m_wicFactory.put()));
    if (FAILED(hr)) winrt::check_hresult(CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(m_wicFactory.put())));
  }

  void CreateSwapChain() {
    RECT clientRect{};
    GetClientRect(m_hwnd, &clientRect);
    m_clientWidth = std::max(clientRect.right - clientRect.left, 1L);
    m_clientHeight = std::max(clientRect.bottom - clientRect.top, 1L);
    DXGI_SWAP_CHAIN_DESC1 desc{};
    desc.Width = static_cast<UINT>(m_clientWidth);
    desc.Height = static_cast<UINT>(m_clientHeight);
    desc.Format = kSwapChainFormat;
    desc.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
    desc.BufferCount = 2;
    desc.SampleDesc.Count = 1;
    desc.SwapEffect = DXGI_SWAP_EFFECT_FLIP_SEQUENTIAL;
    desc.AlphaMode = DXGI_ALPHA_MODE_PREMULTIPLIED;

    auto dxgiDevice = m_device.as<IDXGIDevice>();
    winrt::check_hresult(DCompositionCreateDevice(dxgiDevice.get(), __uuidof(IDCompositionDevice), m_dcompDevice.put_void()));
    winrt::check_hresult(m_dxgiFactory->CreateSwapChainForComposition(m_device.get(), &desc, nullptr, m_swapChain.put()));
    winrt::check_hresult(m_dcompDevice->CreateTargetForHwnd(m_hwnd, TRUE, m_dcompTarget.put()));
    winrt::check_hresult(m_dcompDevice->CreateVisual(m_dcompVisual.put()));
    winrt::check_hresult(m_dcompVisual->SetContent(m_swapChain.get()));
    winrt::check_hresult(m_dcompTarget->SetRoot(m_dcompVisual.get()));
    winrt::check_hresult(m_dcompDevice->Commit());
    AppendLog("ScenePreview.CompositionMode=directcomposition-transparent");
  }

  void CreatePipelineResources() {
    winrt::com_ptr<ID3DBlob> vertexShaderBlob;
    winrt::com_ptr<ID3DBlob> pixelShaderBlob;
    CompileShader(L"VSMain", L"vs_4_0", vertexShaderBlob);
    CompileShader(L"PSMain", L"ps_4_0", pixelShaderBlob);
    winrt::check_hresult(m_device->CreateVertexShader(vertexShaderBlob->GetBufferPointer(), vertexShaderBlob->GetBufferSize(), nullptr, m_vertexShader.put()));
    winrt::check_hresult(m_device->CreatePixelShader(pixelShaderBlob->GetBufferPointer(), pixelShaderBlob->GetBufferSize(), nullptr, m_pixelShader.put()));
    D3D11_INPUT_ELEMENT_DESC inputLayout[] = {
        {"POSITION", 0, DXGI_FORMAT_R32G32B32_FLOAT, 0, offsetof(PreviewVertex, Position), D3D11_INPUT_PER_VERTEX_DATA, 0},
        {"NORMAL", 0, DXGI_FORMAT_R32G32B32_FLOAT, 0, offsetof(PreviewVertex, Normal), D3D11_INPUT_PER_VERTEX_DATA, 0},
        {"TEXCOORD", 0, DXGI_FORMAT_R32G32_FLOAT, 0, offsetof(PreviewVertex, Uv), D3D11_INPUT_PER_VERTEX_DATA, 0},
    };
    winrt::check_hresult(m_device->CreateInputLayout(inputLayout, static_cast<UINT>(std::size(inputLayout)), vertexShaderBlob->GetBufferPointer(), vertexShaderBlob->GetBufferSize(), m_inputLayout.put()));
    D3D11_BUFFER_DESC constantBufferDesc{};
    constantBufferDesc.BindFlags = D3D11_BIND_CONSTANT_BUFFER;
    constantBufferDesc.ByteWidth = sizeof(SceneConstants);
    constantBufferDesc.Usage = D3D11_USAGE_DEFAULT;
    winrt::check_hresult(m_device->CreateBuffer(&constantBufferDesc, nullptr, m_sceneConstantBuffer.put()));
    D3D11_SAMPLER_DESC samplerDesc{};
    samplerDesc.Filter = D3D11_FILTER_MIN_MAG_MIP_LINEAR;
    samplerDesc.AddressU = D3D11_TEXTURE_ADDRESS_CLAMP;
    samplerDesc.AddressV = D3D11_TEXTURE_ADDRESS_CLAMP;
    samplerDesc.AddressW = D3D11_TEXTURE_ADDRESS_CLAMP;
    samplerDesc.MaxLOD = D3D11_FLOAT32_MAX;
    winrt::check_hresult(m_device->CreateSamplerState(&samplerDesc, m_sampler.put()));
    D3D11_BLEND_DESC blendDesc{};
    blendDesc.RenderTarget[0].BlendEnable = TRUE;
    blendDesc.RenderTarget[0].SrcBlend = D3D11_BLEND_ONE;
    blendDesc.RenderTarget[0].DestBlend = D3D11_BLEND_INV_SRC_ALPHA;
    blendDesc.RenderTarget[0].BlendOp = D3D11_BLEND_OP_ADD;
    blendDesc.RenderTarget[0].SrcBlendAlpha = D3D11_BLEND_ONE;
    blendDesc.RenderTarget[0].DestBlendAlpha = D3D11_BLEND_INV_SRC_ALPHA;
    blendDesc.RenderTarget[0].BlendOpAlpha = D3D11_BLEND_OP_ADD;
    blendDesc.RenderTarget[0].RenderTargetWriteMask = D3D11_COLOR_WRITE_ENABLE_ALL;
    winrt::check_hresult(m_device->CreateBlendState(&blendDesc, m_blendState.put()));
    D3D11_RASTERIZER_DESC rasterizerDesc{};
    rasterizerDesc.FillMode = D3D11_FILL_SOLID;
    rasterizerDesc.CullMode = D3D11_CULL_NONE;
    rasterizerDesc.DepthClipEnable = TRUE;
    winrt::check_hresult(m_device->CreateRasterizerState(&rasterizerDesc, m_rasterizerState.put()));
    D3D11_DEPTH_STENCIL_DESC depthStencilDesc{};
    depthStencilDesc.DepthEnable = TRUE;
    depthStencilDesc.DepthWriteMask = D3D11_DEPTH_WRITE_MASK_ALL;
    depthStencilDesc.DepthFunc = D3D11_COMPARISON_LESS_EQUAL;
    winrt::check_hresult(m_device->CreateDepthStencilState(&depthStencilDesc, m_depthState.put()));
  }

  void CompileShader(wchar_t const *entryPoint, wchar_t const *target, winrt::com_ptr<ID3DBlob> &shaderBlob) {
    winrt::com_ptr<ID3DBlob> errors;
    auto hr = D3DCompile(kShaderSource, std::strlen(kShaderSource), "ScenePreviewWindow.hlsl", nullptr, nullptr, ToUtf8(std::wstring(entryPoint)).c_str(), ToUtf8(std::wstring(target)).c_str(), D3DCOMPILE_ENABLE_STRICTNESS, 0, shaderBlob.put(), errors.put());
    if (FAILED(hr)) {
      auto reason = errors ? std::string(static_cast<char const *>(errors->GetBufferPointer()), errors->GetBufferSize()) : std::string("unknown");
      throw std::runtime_error("shader-compile-failed:" + reason);
    }
  }

  void CreateFallbackTexture() {
    uint32_t pixel = 0xffffffffu;
    D3D11_TEXTURE2D_DESC textureDesc{};
    textureDesc.Width = 1; textureDesc.Height = 1; textureDesc.MipLevels = 1; textureDesc.ArraySize = 1; textureDesc.Format = kTextureFormat; textureDesc.SampleDesc.Count = 1; textureDesc.Usage = D3D11_USAGE_IMMUTABLE; textureDesc.BindFlags = D3D11_BIND_SHADER_RESOURCE;
    D3D11_SUBRESOURCE_DATA data{}; data.pSysMem = &pixel; data.SysMemPitch = sizeof(uint32_t);
    winrt::com_ptr<ID3D11Texture2D> texture;
    winrt::check_hresult(m_device->CreateTexture2D(&textureDesc, &data, texture.put()));
    winrt::check_hresult(m_device->CreateShaderResourceView(texture.get(), nullptr, m_whiteTextureView.put()));
  }

  bool LoadMeshes() noexcept {
    AppendLog("ScenePreview.LoadMeshes begin meshParts=" + std::to_string(m_manifest.Meshes.size()));
    if (!LoadMeshParts(m_manifest.Meshes, m_meshes)) return false;
    for (auto const &faceState : m_manifest.FaceStates) {
      GpuFaceState gpuFaceState{};
      gpuFaceState.Key = faceState.Key;
      gpuFaceState.Label = faceState.Label;
      if (!LoadMeshParts(faceState.Meshes, gpuFaceState.Meshes)) return false;
      AppendLog("ScenePreview.FaceStateLoaded key=" + ToUtf8(gpuFaceState.Key) + " label=" + ToUtf8(gpuFaceState.Label) + " meshParts=" + std::to_string(gpuFaceState.Meshes.size()));
      m_faceStates.push_back(std::move(gpuFaceState));
    }
    if (!m_faceStates.empty()) {
      std::string shortcuts = "ScenePreview.FaceStateShortcuts";
      for (size_t index = 0; index < m_faceStates.size() && index < 9; index += 1) {
        shortcuts += " [" + std::to_string(index + 1) + "]=" + ToUtf8(m_faceStates[index].Label.empty() ? m_faceStates[index].Key : m_faceStates[index].Label);
      }
      AppendLog(shortcuts);
    }
    return true;
  }

  bool LoadMeshParts(std::vector<PreviewMeshPart> const &meshParts, std::vector<GpuMeshPart> &target) noexcept {
    for (auto const &meshPart : meshParts) {
      if (!LoadMeshPart(meshPart, target)) return false;
    }
    return true;
  }

  bool LoadMeshPart(PreviewMeshPart const &meshPart, std::vector<GpuMeshPart> &target) noexcept {
    try {
      auto positions = ReadPodFile<float>(meshPart.PositionsFile);
      auto normals = ReadPodFile<float>(meshPart.NormalsFile);
      auto uv0 = ReadPodFile<float>(meshPart.Uv0File);
      auto indices = ReadPodFile<uint32_t>(meshPart.IndicesFile);
      if (!positions || !normals || !uv0 || !indices) {
        m_startupError = "scene-preview-buffer-unavailable";
        AppendLog("ScenePreview.MeshReadFailed name=" + ToUtf8(meshPart.Name));
        return false;
      }

      auto vertexCount = positions->size() / 3;
      if (vertexCount == 0 || positions->size() % 3 != 0 || normals->size() % 3 != 0 || uv0->size() % 2 != 0 || normals->size() / 3 != vertexCount || uv0->size() / 2 != vertexCount) {
        m_startupError = "scene-preview-buffer-layout-invalid";
        AppendLog("ScenePreview.MeshLayoutInvalid name=" + ToUtf8(meshPart.Name));
        return false;
      }

      std::vector<PreviewVertex> vertices(vertexCount);
      for (size_t index = 0; index < vertexCount; index += 1) {
        vertices[index].Position = {(*positions)[index * 3 + 0], (*positions)[index * 3 + 1], (*positions)[index * 3 + 2]};
        vertices[index].Normal = {(*normals)[index * 3 + 0], (*normals)[index * 3 + 1], (*normals)[index * 3 + 2]};
        vertices[index].Uv = {(*uv0)[index * 2 + 0], (*uv0)[index * 2 + 1]};
      }

      D3D11_BUFFER_DESC vertexBufferDesc{};
      vertexBufferDesc.BindFlags = D3D11_BIND_VERTEX_BUFFER;
      vertexBufferDesc.ByteWidth = static_cast<UINT>(vertices.size() * sizeof(PreviewVertex));
      vertexBufferDesc.Usage = D3D11_USAGE_IMMUTABLE;
      D3D11_SUBRESOURCE_DATA vertexData{}; vertexData.pSysMem = vertices.data();

      D3D11_BUFFER_DESC indexBufferDesc{};
      indexBufferDesc.BindFlags = D3D11_BIND_INDEX_BUFFER;
      indexBufferDesc.ByteWidth = static_cast<UINT>(indices->size() * sizeof(uint32_t));
      indexBufferDesc.Usage = D3D11_USAGE_IMMUTABLE;
      D3D11_SUBRESOURCE_DATA indexData{}; indexData.pSysMem = indices->data();

      GpuMeshPart gpuMesh{};
      gpuMesh.Name = meshPart.Name;
      gpuMesh.MaterialName = meshPart.MaterialName;
      gpuMesh.IndexCount = static_cast<uint32_t>(indices->size());
      gpuMesh.BoundsMin = meshPart.BoundsMin;
      gpuMesh.BoundsMax = meshPart.BoundsMax;
      gpuMesh.TransformOffset = meshPart.TransformOffset;
      gpuMesh.LightingFloor = meshPart.LightingFloor;
      gpuMesh.EmissiveBoost = meshPart.EmissiveBoost;
      gpuMesh.AlphaCutoff = meshPart.AlphaCutoff;
      winrt::check_hresult(m_device->CreateBuffer(&vertexBufferDesc, &vertexData, gpuMesh.VertexBuffer.put()));
      winrt::check_hresult(m_device->CreateBuffer(&indexBufferDesc, &indexData, gpuMesh.IndexBuffer.put()));
      if (meshPart.TextureFile) {
        gpuMesh.TextureView = AcquireTexture(*meshPart.TextureFile);
        gpuMesh.UseTexture = gpuMesh.TextureView != nullptr;
      }
      if (!gpuMesh.TextureView) gpuMesh.TextureView = m_whiteTextureView;
      gpuMesh.Tint = gpuMesh.UseTexture ? ResolvePreviewMaterialTint(meshPart) : ResolveFallbackMeshColor(meshPart);
      if (meshPart.TintOverride) gpuMesh.Tint = *meshPart.TintOverride;
      target.push_back(std::move(gpuMesh));
      AppendLog("ScenePreview.MeshLoaded name=" + ToUtf8(meshPart.Name) + " material=" + ToUtf8(meshPart.MaterialName) + " vertices=" + std::to_string(vertexCount) + " indices=" + std::to_string(indices->size()));
      return true;
    } catch (winrt::hresult_error const &exception) {
      m_startupError = "scene-preview-mesh-failed:" + ToUtf8(exception.message());
      AppendLog("ScenePreview.MeshLoadFailed name=" + ToUtf8(meshPart.Name) + " reason=" + *m_startupError);
      return false;
    } catch (std::exception const &exception) {
      m_startupError = std::string("scene-preview-mesh-exception:") + exception.what();
      AppendLog("ScenePreview.MeshLoadFailed name=" + ToUtf8(meshPart.Name) + " reason=" + *m_startupError);
      return false;
    } catch (...) {
      m_startupError = "scene-preview-mesh-unknown";
      AppendLog("ScenePreview.MeshLoadFailed name=" + ToUtf8(meshPart.Name) + " reason=" + *m_startupError);
      return false;
    }
  }

  winrt::com_ptr<ID3D11ShaderResourceView> AcquireTexture(std::filesystem::path const &path) {
    auto key = path.lexically_normal().wstring();
    if (auto existing = m_textureCache.find(key); existing != m_textureCache.end()) return existing->second;
    if (!std::filesystem::exists(path)) {
      AppendLog("ScenePreview.TextureMissing path=" + ToUtf8(path.wstring()));
      return nullptr;
    }
    winrt::com_ptr<IWICBitmapDecoder> decoder;
    winrt::check_hresult(m_wicFactory->CreateDecoderFromFilename(path.c_str(), nullptr, GENERIC_READ, WICDecodeMetadataCacheOnLoad, decoder.put()));
    winrt::com_ptr<IWICBitmapFrameDecode> frame;
    winrt::check_hresult(decoder->GetFrame(0, frame.put()));
    winrt::com_ptr<IWICFormatConverter> converter;
    winrt::check_hresult(m_wicFactory->CreateFormatConverter(converter.put()));
    winrt::check_hresult(converter->Initialize(frame.get(), GUID_WICPixelFormat32bppRGBA, WICBitmapDitherTypeNone, nullptr, 0.0, WICBitmapPaletteTypeCustom));
    UINT width = 0, height = 0;
    winrt::check_hresult(converter->GetSize(&width, &height));
    if (!width || !height) throw std::runtime_error("texture-size-invalid");
    std::vector<uint8_t> pixels(static_cast<size_t>(width) * static_cast<size_t>(height) * 4u);
    winrt::check_hresult(converter->CopyPixels(nullptr, width * 4u, static_cast<UINT>(pixels.size()), pixels.data()));
    D3D11_TEXTURE2D_DESC textureDesc{};
    textureDesc.Width = width; textureDesc.Height = height; textureDesc.MipLevels = 1; textureDesc.ArraySize = 1; textureDesc.Format = kTextureFormat; textureDesc.SampleDesc.Count = 1; textureDesc.Usage = D3D11_USAGE_IMMUTABLE; textureDesc.BindFlags = D3D11_BIND_SHADER_RESOURCE;
    D3D11_SUBRESOURCE_DATA data{}; data.pSysMem = pixels.data(); data.SysMemPitch = width * 4u;
    winrt::com_ptr<ID3D11Texture2D> texture;
    winrt::check_hresult(m_device->CreateTexture2D(&textureDesc, &data, texture.put()));
    winrt::com_ptr<ID3D11ShaderResourceView> view;
    winrt::check_hresult(m_device->CreateShaderResourceView(texture.get(), nullptr, view.put()));
    m_textureCache.emplace(key, view);
    AppendLog("ScenePreview.TextureLoaded path=" + ToUtf8(path.filename().wstring()) + " size=" + std::to_string(width) + "x" + std::to_string(height));
    return view;
  }

  bool ResizeSwapChain() noexcept {
    if (!m_swapChain) return false;
    RECT clientRect{};
    if (!GetClientRect(m_hwnd, &clientRect)) return false;
    auto width = std::max(clientRect.right - clientRect.left, 1L);
    auto height = std::max(clientRect.bottom - clientRect.top, 1L);
    m_clientWidth = width;
    m_clientHeight = height;
    m_renderTargetView = nullptr; m_depthStencilView = nullptr; m_depthTexture = nullptr;
    m_context->OMSetRenderTargets(0, nullptr, nullptr);
    winrt::check_hresult(m_swapChain->ResizeBuffers(0, static_cast<UINT>(width), static_cast<UINT>(height), kSwapChainFormat, 0));
    CreateRenderTargets(width, height);
    AppendLog("ScenePreview.Resize width=" + std::to_string(width) + " height=" + std::to_string(height));
    return true;
  }

  void CreateRenderTargets(int width, int height) {
    winrt::com_ptr<ID3D11Texture2D> backBuffer;
    winrt::check_hresult(m_swapChain->GetBuffer(0, __uuidof(ID3D11Texture2D), backBuffer.put_void()));
    winrt::check_hresult(m_device->CreateRenderTargetView(backBuffer.get(), nullptr, m_renderTargetView.put()));
    D3D11_TEXTURE2D_DESC depthDesc{};
    depthDesc.Width = static_cast<UINT>(width); depthDesc.Height = static_cast<UINT>(height); depthDesc.MipLevels = 1; depthDesc.ArraySize = 1; depthDesc.Format = kDepthFormat; depthDesc.SampleDesc.Count = 1; depthDesc.BindFlags = D3D11_BIND_DEPTH_STENCIL;
    winrt::check_hresult(m_device->CreateTexture2D(&depthDesc, nullptr, m_depthTexture.put()));
    winrt::check_hresult(m_device->CreateDepthStencilView(m_depthTexture.get(), nullptr, m_depthStencilView.put()));
  }

  struct SceneMatrices { DirectX::XMMATRIX BaseWorld; DirectX::XMMATRIX ViewProjection; };
  SceneMatrices BuildSceneMatrices() const noexcept {
    auto userRotation = QuaternionFromEulerDegrees(float3{m_userPitchDegrees, m_userYawDegrees, 0.0f});
    auto baseRotation = DirectX::XMLoadFloat4(&m_baseRotation);
    auto combinedRotation = DirectX::XMQuaternionMultiply(baseRotation, userRotation);
    auto world = DirectX::XMMatrixTranslation(-m_manifest.ModelCenter.x, -m_manifest.ModelCenter.y, -m_manifest.ModelCenter.z) * DirectX::XMMatrixRotationQuaternion(combinedRotation);
    auto aspectRatio = static_cast<float>(std::max(m_clientWidth, 1L)) / static_cast<float>(std::max(m_clientHeight, 1L));
    auto fovY = DirectX::XMConvertToRadians(34.0f);
    auto halfHeight = std::max(m_manifest.ModelSize.y * 0.58f, 0.85f);
    auto halfWidth = std::max(m_manifest.ModelSize.x * 0.68f, 0.55f);
    auto requiredDistanceY = halfHeight / std::tan(fovY * 0.5f);
    auto requiredDistanceX = halfWidth / (aspectRatio * std::tan(fovY * 0.5f));
    auto cameraDistance = std::max(requiredDistanceY, requiredDistanceX) + std::max(m_manifest.ModelSize.z * 2.2f, 0.75f);
    auto zoom = std::max(m_zoom, 0.1f);
    if (m_manifest.ViewTranslation.z > 0.01f) {
      cameraDistance = m_manifest.ViewTranslation.z;
    }
    cameraDistance = std::max(cameraDistance / zoom, 1.4f);
    auto targetXOffset = m_manifest.ViewTranslation.x;
    auto targetYOffset = (m_manifest.ModelSize.y * 0.06f) + m_manifest.ViewTranslation.y;
    auto eyeYOffset = m_manifest.ModelSize.y * 0.05f;
    auto view = DirectX::XMMatrixLookAtLH(
        DirectX::XMVectorSet(targetXOffset, targetYOffset + eyeYOffset, cameraDistance, 1.0f),
        DirectX::XMVectorSet(targetXOffset, targetYOffset, 0.0f, 1.0f),
        DirectX::XMVectorSet(0.0f, 1.0f, 0.0f, 0.0f));
    auto projection = DirectX::XMMatrixPerspectiveFovLH(fovY, aspectRatio, 0.05f, 40.0f);
    return SceneMatrices{world, view * projection};
  }

  float3 ComputeMotionAnchor(GpuMeshPart const &mesh, std::wstring const &anchor) const noexcept {
    auto center = float3{
        (mesh.BoundsMin.x + mesh.BoundsMax.x) * 0.5f,
        (mesh.BoundsMin.y + mesh.BoundsMax.y) * 0.5f,
        (mesh.BoundsMin.z + mesh.BoundsMax.z) * 0.5f,
    };
    if (anchor == L"model-center") return m_manifest.ModelCenter;
    if (anchor == L"upper-center") {
      return float3{
          center.x,
          mesh.BoundsMax.y,
          center.z,
      };
    }
    return center;
  }

  ScenePreviewManifest::MotionKeyframe SampleMotionKeyframe(
      ScenePreviewManifest::MotionProfile const &profile,
      float timeSeconds) const noexcept {
    ScenePreviewManifest::MotionKeyframe sampled{};
    if (profile.Keyframes.empty()) {
      return sampled;
    }
    if (profile.Keyframes.size() == 1 || m_manifest.Animation.LoopSeconds <= 0.0f) {
      return profile.Keyframes.front();
    }

    auto normalizedTime = std::fmod(std::max(timeSeconds, 0.0f), m_manifest.Animation.LoopSeconds) /
                          std::max(m_manifest.Animation.LoopSeconds, 0.1f);
    if (normalizedTime < 0.0f) normalizedTime += 1.0f;

    for (size_t index = 0; index < profile.Keyframes.size(); index += 1) {
      auto const &next = profile.Keyframes[index];
      if (normalizedTime > next.Time) continue;
      auto const &previous = (index == 0) ? profile.Keyframes.back() : profile.Keyframes[index - 1];
      auto previousTime = (index == 0) ? previous.Time - 1.0f : previous.Time;
      auto currentTime = normalizedTime;
      if (index == 0) currentTime -= 1.0f;
      auto span = std::max(next.Time - previousTime, 1e-4f);
      auto alpha = (currentTime - previousTime) / span;
      sampled.Time = normalizedTime;
      sampled.Translation = LerpFloat3(previous.Translation, next.Translation, alpha);
      sampled.RotationDegrees = LerpFloat3(previous.RotationDegrees, next.RotationDegrees, alpha);
      return sampled;
    }

    auto const &last = profile.Keyframes.back();
    auto const &first = profile.Keyframes.front();
    auto span = std::max((first.Time + 1.0f) - last.Time, 1e-4f);
    auto alpha = (normalizedTime - last.Time) / span;
    sampled.Time = normalizedTime;
    sampled.Translation = LerpFloat3(last.Translation, first.Translation, alpha);
    sampled.RotationDegrees = LerpFloat3(last.RotationDegrees, first.RotationDegrees, alpha);
    return sampled;
  }

  DirectX::XMMATRIX BuildMotionMatrix(
      ScenePreviewManifest::MotionProfile const &profile,
      float3 const &pivot,
      float timeSeconds) const noexcept {
    float3 translation{0.0f, 0.0f, 0.0f};
    float3 rotationDegrees{0.0f, 0.0f, 0.0f};
    if (!profile.Keyframes.empty()) {
      auto keyframe = SampleMotionKeyframe(profile, timeSeconds);
      translation = keyframe.Translation;
      rotationDegrees = keyframe.RotationDegrees;
    } else {
      auto wave = EvaluateIdleWave(
          timeSeconds,
          m_manifest.Animation.LoopSeconds,
          profile.Frequency,
          profile.Phase);
      translation = float3{
          profile.TranslationAmplitude.x * wave,
          profile.TranslationAmplitude.y * wave,
          profile.TranslationAmplitude.z * wave,
      };
      rotationDegrees = float3{
          profile.RotationDegreesAmplitude.x * wave,
          profile.RotationDegreesAmplitude.y * wave,
          profile.RotationDegreesAmplitude.z * wave,
      };
    }
    auto rotation = DirectX::XMMatrixRotationQuaternion(QuaternionFromEulerDegrees(rotationDegrees));
    auto moveToOrigin = DirectX::XMMatrixTranslation(-pivot.x, -pivot.y, -pivot.z);
    auto moveBack = DirectX::XMMatrixTranslation(
        pivot.x + translation.x,
        pivot.y + translation.y,
        pivot.z + translation.z);
    return moveToOrigin * rotation * moveBack;
  }

  DirectX::XMMATRIX BuildAnimatedWorldMatrix(
      GpuMeshPart const &mesh,
      SceneMatrices const &matrices) const noexcept {
    auto world = matrices.BaseWorld;
    if (!m_manifest.Animation.Enabled || m_manifest.Animation.LoopSeconds <= 0.0f) {
      return world;
    }

    auto now = std::chrono::steady_clock::now();
    auto elapsed = std::chrono::duration_cast<std::chrono::duration<float>>(now - m_animationStart).count();

    auto globalProfile = m_manifest.Animation.GlobalMotion;
    if (globalProfile.TranslationAmplitude.x != 0.0f ||
        globalProfile.TranslationAmplitude.y != 0.0f ||
        globalProfile.TranslationAmplitude.z != 0.0f ||
        globalProfile.RotationDegreesAmplitude.x != 0.0f ||
        globalProfile.RotationDegreesAmplitude.y != 0.0f ||
        globalProfile.RotationDegreesAmplitude.z != 0.0f) {
      auto pivot = ComputeMotionAnchor(mesh, globalProfile.Anchor);
      world = BuildMotionMatrix(globalProfile, pivot, elapsed) * world;
    }

    for (auto const &profile : m_manifest.Animation.MeshMotions) {
      auto matches = std::any_of(profile.Prefixes.begin(), profile.Prefixes.end(), [&](std::wstring const &prefix) {
        return mesh.Name.rfind(prefix, 0) == 0;
      });
      if (!matches) continue;
      auto pivot = ComputeMotionAnchor(mesh, profile.Anchor);
      world = BuildMotionMatrix(profile, pivot, elapsed) * world;
      break;
    }

    if (mesh.TransformOffset.x != 0.0f ||
        mesh.TransformOffset.y != 0.0f ||
        mesh.TransformOffset.z != 0.0f) {
      world = DirectX::XMMatrixTranslation(
                  mesh.TransformOffset.x,
                  mesh.TransformOffset.y,
                  mesh.TransformOffset.z) *
              world;
    }

    return world;
  }

  void RenderMesh(GpuMeshPart const &mesh, DirectX::XMMATRIX const &world, DirectX::XMMATRIX const &viewProjection) {
    UINT stride = sizeof(PreviewVertex), offset = 0;
    ID3D11Buffer *vertexBuffer = mesh.VertexBuffer.get();
    m_context->IASetVertexBuffers(0, 1, &vertexBuffer, &stride, &offset);
    m_context->IASetIndexBuffer(mesh.IndexBuffer.get(), DXGI_FORMAT_R32_UINT, 0);
    auto lightDirection = DirectX::XMVector3Normalize(DirectX::XMVectorSet(0.25f, -0.48f, -1.0f, 0.0f));
    DirectX::XMFLOAT3 light{}; DirectX::XMStoreFloat3(&light, lightDirection);
    SceneConstants constants{};
    DirectX::XMStoreFloat4x4(&constants.World, world);
    DirectX::XMStoreFloat4x4(&constants.WorldViewProjection, world * viewProjection);
    constants.Tint = mesh.Tint;
    auto lightingFloor = 0.0f;
    auto emissiveBoost = 0.0f;
    if (mesh.MaterialName.find(L"Emissive") != std::wstring::npos) {
      lightingFloor = 0.72f;
      emissiveBoost = 0.16f;
    } else if (mesh.Name.find(L"Equipment_A") != std::wstring::npos || mesh.MaterialName.find(L"Equipment") != std::wstring::npos) {
      lightingFloor = 0.76f;
      emissiveBoost = 0.10f;
    }
    if (mesh.LightingFloor >= 0.0f) lightingFloor = mesh.LightingFloor;
    if (mesh.EmissiveBoost >= 0.0f) emissiveBoost = mesh.EmissiveBoost;
    auto alphaCutoff = mesh.AlphaCutoff >= 0.0f ? mesh.AlphaCutoff : 0.03f;
    constants.Options = {mesh.UseTexture ? 1.0f : 0.0f, alphaCutoff, lightingFloor, emissiveBoost};
    constants.LightDirection = {light.x, light.y, light.z, 0.0f};
    m_context->UpdateSubresource(m_sceneConstantBuffer.get(), 0, nullptr, &constants, 0, 0);
    ID3D11ShaderResourceView *textureView = mesh.TextureView ? mesh.TextureView.get() : m_whiteTextureView.get();
    m_context->PSSetShaderResources(0, 1, &textureView);
    m_context->DrawIndexed(mesh.IndexCount, 0, 0);
  }

  void RenderFrame() noexcept {
    if (!m_swapChain || !m_renderTargetView || !m_depthStencilView || m_clientWidth <= 0 || m_clientHeight <= 0) return;
    try {
      auto clearColor = std::array<float, 4>{0.0f, 0.0f, 0.0f, 0.0f};
      ID3D11RenderTargetView *renderTarget = m_renderTargetView.get();
      m_context->OMSetRenderTargets(1, &renderTarget, m_depthStencilView.get());
      m_context->ClearRenderTargetView(m_renderTargetView.get(), clearColor.data());
      m_context->ClearDepthStencilView(m_depthStencilView.get(), D3D11_CLEAR_DEPTH | D3D11_CLEAR_STENCIL, 1.0f, 0);
      D3D11_VIEWPORT viewport{};
      viewport.Width = static_cast<float>(m_clientWidth); viewport.Height = static_cast<float>(m_clientHeight); viewport.MinDepth = 0.0f; viewport.MaxDepth = 1.0f;
      m_context->RSSetViewports(1, &viewport);
      m_context->RSSetState(m_rasterizerState.get());
      m_context->OMSetDepthStencilState(m_depthState.get(), 0);
      auto blendFactor = std::array<float, 4>{0.0f, 0.0f, 0.0f, 0.0f};
      m_context->OMSetBlendState(m_blendState.get(), blendFactor.data(), 0xffffffff);
      m_context->IASetInputLayout(m_inputLayout.get());
      m_context->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
      m_context->VSSetShader(m_vertexShader.get(), nullptr, 0);
      m_context->PSSetShader(m_pixelShader.get(), nullptr, 0);
      ID3D11Buffer *constantBuffer = m_sceneConstantBuffer.get();
      m_context->VSSetConstantBuffers(0, 1, &constantBuffer);
      m_context->PSSetConstantBuffers(0, 1, &constantBuffer);
      ID3D11SamplerState *samplers[] = {m_sampler.get()};
      m_context->PSSetSamplers(0, 1, samplers);
      auto matrices = BuildSceneMatrices();
      for (auto const &mesh : m_meshes) {
        auto world = BuildAnimatedWorldMatrix(mesh, matrices);
        RenderMesh(mesh, world, matrices.ViewProjection);
      }
      if (m_activeFaceStateIndex >= 0 && m_activeFaceStateIndex < static_cast<int>(m_faceStates.size())) {
        for (auto const &mesh : m_faceStates[static_cast<size_t>(m_activeFaceStateIndex)].Meshes) {
          auto world = BuildAnimatedWorldMatrix(mesh, matrices);
          RenderMesh(mesh, world, matrices.ViewProjection);
        }
      }
      ID3D11ShaderResourceView *nullTexture = nullptr;
      m_context->PSSetShaderResources(0, 1, &nullTexture);
      winrt::check_hresult(m_swapChain->Present(1, 0));
      if (m_dcompDevice) {
        winrt::check_hresult(m_dcompDevice->Commit());
      }
    } catch (winrt::hresult_error const &exception) {
      AppendLog("ScenePreview.RenderFailed reason=" + ToUtf8(exception.message()));
    } catch (std::exception const &exception) {
      AppendLog(std::string("ScenePreview.RenderFailed reason=") + exception.what());
    } catch (...) {
      AppendLog("ScenePreview.RenderFailed reason=unknown");
    }
  }

  void ResetInteraction() noexcept {
    m_userYawDegrees = 0.0f;
    m_userPitchDegrees = 0.0f;
    m_zoom = kDefaultZoom;
    RenderFrame();
  }

  void ResolveDefaultFaceState() noexcept {
    if (m_faceStates.empty()) {
      m_activeFaceStateIndex = -1;
      return;
    }
    if (!m_manifest.DefaultFaceStateKey.empty()) {
      for (size_t index = 0; index < m_faceStates.size(); index += 1) {
        if (m_faceStates[index].Key == m_manifest.DefaultFaceStateKey) {
          m_activeFaceStateIndex = static_cast<int>(index);
          AppendLog("ScenePreview.FaceStateDefault key=" + ToUtf8(m_faceStates[index].Key));
          return;
        }
      }
    }
    m_activeFaceStateIndex = 0;
    AppendLog("ScenePreview.FaceStateDefault key=" + ToUtf8(m_faceStates[0].Key));
  }

  void UpdateWindowTitle() noexcept {
    if (!m_hwnd) return;
    std::wstring title = m_windowTitle;
    if (m_activeFaceStateIndex >= 0 && m_activeFaceStateIndex < static_cast<int>(m_faceStates.size())) {
      auto const &active = m_faceStates[static_cast<size_t>(m_activeFaceStateIndex)];
      auto const &label = active.Label.empty() ? active.Key : active.Label;
      if (!label.empty()) title += L" [" + label + L"]";
    }
    SetWindowTextW(m_hwnd, title.c_str());
  }

  bool SetActiveFaceState(size_t index) noexcept {
    if (index >= m_faceStates.size()) return false;
    if (m_activeFaceStateIndex == static_cast<int>(index)) return true;
    m_activeFaceStateIndex = static_cast<int>(index);
    auto const &active = m_faceStates[index];
    AppendLog("ScenePreview.FaceStateChanged key=" + ToUtf8(active.Key) + " label=" + ToUtf8(active.Label));
    UpdateWindowTitle();
    RenderFrame();
    return true;
  }

  bool TrySelectFaceStateFromKey(WPARAM keyCode) noexcept {
    if (m_faceStates.empty()) return false;
    if (keyCode >= '1' && keyCode <= '9') {
      auto index = static_cast<size_t>(keyCode - '1');
      if (index < m_faceStates.size()) return SetActiveFaceState(index);
    }
    if (keyCode >= VK_NUMPAD1 && keyCode <= VK_NUMPAD9) {
      auto index = static_cast<size_t>(keyCode - VK_NUMPAD1);
      if (index < m_faceStates.size()) return SetActiveFaceState(index);
    }
    return false;
  }

  HWND m_hwnd{nullptr};
  ScenePreviewManifest m_manifest;
  std::wstring m_windowTitle;
  std::optional<std::string> m_startupError;
  winrt::com_ptr<ID3D11Device> m_device;
  winrt::com_ptr<ID3D11DeviceContext> m_context;
  winrt::com_ptr<IDXGIFactory2> m_dxgiFactory;
  winrt::com_ptr<IDXGISwapChain1> m_swapChain;
  winrt::com_ptr<IDCompositionDevice> m_dcompDevice;
  winrt::com_ptr<IDCompositionTarget> m_dcompTarget;
  winrt::com_ptr<IDCompositionVisual> m_dcompVisual;
  winrt::com_ptr<ID3D11RenderTargetView> m_renderTargetView;
  winrt::com_ptr<ID3D11Texture2D> m_depthTexture;
  winrt::com_ptr<ID3D11DepthStencilView> m_depthStencilView;
  winrt::com_ptr<ID3D11VertexShader> m_vertexShader;
  winrt::com_ptr<ID3D11PixelShader> m_pixelShader;
  winrt::com_ptr<ID3D11InputLayout> m_inputLayout;
  winrt::com_ptr<ID3D11Buffer> m_sceneConstantBuffer;
  winrt::com_ptr<ID3D11SamplerState> m_sampler;
  winrt::com_ptr<ID3D11BlendState> m_blendState;
  winrt::com_ptr<ID3D11RasterizerState> m_rasterizerState;
  winrt::com_ptr<ID3D11DepthStencilState> m_depthState;
  winrt::com_ptr<ID3D11ShaderResourceView> m_whiteTextureView;
  winrt::com_ptr<IWICImagingFactory> m_wicFactory;
  std::unordered_map<std::wstring, winrt::com_ptr<ID3D11ShaderResourceView>> m_textureCache;
  std::vector<GpuMeshPart> m_meshes;
  std::vector<GpuFaceState> m_faceStates;
  DirectX::XMFLOAT4 m_baseRotation{0.0f, 0.0f, 0.0f, 1.0f};
  float m_userYawDegrees{0.0f};
  float m_userPitchDegrees{0.0f};
  float m_zoom{kDefaultZoom};
  int m_activeFaceStateIndex{-1};
  bool m_dragging{false};
  POINT m_lastPointer{0, 0};
  LONG m_clientWidth{0};
  LONG m_clientHeight{0};
  std::chrono::steady_clock::time_point m_animationStart{std::chrono::steady_clock::now()};
};

} // namespace

std::optional<std::string> RunScenePreviewWindow(std::wstring const &previewFile) noexcept {
  bool apartmentInitialized = false;
  try {
    winrt::init_apartment(winrt::apartment_type::multi_threaded);
    apartmentInitialized = true;
  } catch (winrt::hresult_error const &exception) {
    if (exception.code() != RPC_E_CHANGED_MODE) return "scene-preview-init-apartment-failed:" + ToUtf8(exception.message());
  }
  std::string manifestError;
  auto manifest = LoadScenePreviewManifest(previewFile, manifestError);
  if (!manifest) {
    if (apartmentInitialized) winrt::uninit_apartment();
    return manifestError.empty() ? std::optional<std::string>{"scene-preview-manifest-load-failed"} : manifestError;
  }
  AppendLog(
      "ScenePreview.Start file=" + ToUtf8(previewFile) +
      " displayName=" + ToUtf8(manifest->DisplayName) +
      " meshParts=" + std::to_string(manifest->Meshes.size()) +
      " faceStates=" + std::to_string(manifest->FaceStates.size()));
  ScenePreviewWindow window(std::move(*manifest));
  auto result = window.Run();
  if (apartmentInitialized) winrt::uninit_apartment();
  return result;
}

} // namespace OpappWindowsHost
