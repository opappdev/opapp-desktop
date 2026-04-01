#include "pch.h"

#include <algorithm>
#include <atomic>
#include <cctype>
#include <cstdint>
#include <cwctype>
#include <mutex>
#include <optional>
#include <string>
#include <string_view>
#include <thread>
#include <unordered_map>
#include <utility>
#include <vector>

#include <winrt/Windows.Data.Json.h>
#include <winrt/Windows.Storage.Streams.h>
#include <winrt/Windows.Web.Http.Filters.h>
#include <winrt/Windows.Web.Http.Headers.h>
#include <winrt/Windows.Web.Http.h>

#include "NativeModules.h"

namespace OpappWindowsHostModules {

namespace {

using JSValueObject = winrt::Microsoft::ReactNative::JSValueObject;
using ReactContext = winrt::Microsoft::ReactNative::ReactContext;
using JsonObject = winrt::Windows::Data::Json::JsonObject;
using JsonValueType = winrt::Windows::Data::Json::JsonValueType;
using DataReader = winrt::Windows::Storage::Streams::DataReader;
using HttpBaseProtocolFilter = winrt::Windows::Web::Http::Filters::HttpBaseProtocolFilter;
using HttpCacheReadBehavior = winrt::Windows::Web::Http::Filters::HttpCacheReadBehavior;
using HttpClient = winrt::Windows::Web::Http::HttpClient;
using HttpCompletionOption = winrt::Windows::Web::Http::HttpCompletionOption;
using HttpMethod = winrt::Windows::Web::Http::HttpMethod;
using HttpRequestMessage = winrt::Windows::Web::Http::HttpRequestMessage;
using HttpResponseMessage = winrt::Windows::Web::Http::HttpResponseMessage;
using HttpStringContent = winrt::Windows::Web::Http::HttpStringContent;
using HttpMediaTypeHeaderValue = winrt::Windows::Web::Http::Headers::HttpMediaTypeHeaderValue;
using IInputStream = winrt::Windows::Storage::Streams::IInputStream;
using InputStreamOptions = winrt::Windows::Storage::Streams::InputStreamOptions;
using Uri = winrt::Windows::Foundation::Uri;
using UnicodeEncoding = winrt::Windows::Storage::Streams::UnicodeEncoding;

constexpr wchar_t kEventEmitterName[] = L"RCTDeviceEventEmitter";
constexpr wchar_t kEventName[] = L"opapp.sse";
constexpr uint32_t kReadChunkSize = 4096;

struct SseRequestOptions {
  std::string Url;
  std::string Method{"GET"};
  std::string Body;
  bool WithCredentials{false};
  std::unordered_map<std::wstring, std::wstring> Headers;
};

struct SseConnectionState {
  std::string ConnectionId;
  ReactContext Context{nullptr};
  std::mutex Mutex;
  bool CloseRequested{false};
  HttpClient Client{nullptr};
  IInputStream Stream{nullptr};
};

std::atomic_uint64_t g_nextConnectionId{1};
std::mutex g_connectionsMutex;
std::unordered_map<std::string, std::shared_ptr<SseConnectionState>> g_connections;

std::string GenerateConnectionId() {
  return "sse-" + std::to_string(g_nextConnectionId.fetch_add(1, std::memory_order_relaxed));
}

std::string WideToUtf8(std::wstring const &value) noexcept {
  return winrt::to_string(winrt::hstring(value));
}

bool EqualsCaseInsensitive(std::wstring_view left, std::wstring_view right) {
  if (left.size() != right.size()) {
    return false;
  }

  for (std::size_t index = 0; index < left.size(); ++index) {
    if (::towlower(left[index]) != ::towlower(right[index])) {
      return false;
    }
  }

  return true;
}

void RegisterConnection(std::shared_ptr<SseConnectionState> const &connection) {
  std::scoped_lock lock(g_connectionsMutex);
  g_connections[connection->ConnectionId] = connection;
}

std::shared_ptr<SseConnectionState> FindConnection(std::string const &connectionId) {
  std::scoped_lock lock(g_connectionsMutex);
  auto iterator = g_connections.find(connectionId);
  return iterator == g_connections.end() ? nullptr : iterator->second;
}

void UnregisterConnection(std::string const &connectionId) {
  std::scoped_lock lock(g_connectionsMutex);
  g_connections.erase(connectionId);
}

bool IsCloseRequested(std::shared_ptr<SseConnectionState> const &connection) {
  std::scoped_lock lock(connection->Mutex);
  return connection->CloseRequested;
}

void CloseConnection(std::shared_ptr<SseConnectionState> const &connection) {
  HttpClient client{nullptr};
  IInputStream stream{nullptr};

  {
    std::scoped_lock lock(connection->Mutex);
    if (connection->CloseRequested) {
      return;
    }

    connection->CloseRequested = true;
    client = connection->Client;
    stream = connection->Stream;
  }

  try {
    if (stream) {
      stream.Close();
    }
  } catch (...) {
  }

  try {
    if (client) {
      client.Close();
    }
  } catch (...) {
  }
}

void ResetConnectionResources(std::shared_ptr<SseConnectionState> const &connection) {
  std::scoped_lock lock(connection->Mutex);
  connection->Client = nullptr;
  connection->Stream = nullptr;
}

void EmitConnectionEvent(
    std::shared_ptr<SseConnectionState> const &connection,
    JSValueObject &&payload) noexcept {
  try {
    if (!connection->Context) {
      return;
    }

    connection->Context.EmitJSEvent(
        kEventEmitterName,
        kEventName,
        std::move(payload));
  } catch (...) {
  }
}

void EmitConnectionError(
    std::shared_ptr<SseConnectionState> const &connection,
    std::string message,
    std::string code = "ERR_SSE_TRANSPORT_NATIVE") noexcept {
  if (IsCloseRequested(connection)) {
    return;
  }

  EmitConnectionEvent(
      connection,
      JSValueObject{
          {"connectionId", connection->ConnectionId},
          {"type", "error"},
          {"error", std::move(message)},
          {"code", std::move(code)},
      });
}

std::string FormatHResultError(winrt::hresult_error const &error) {
  auto message = winrt::to_string(error.message());
  if (message.empty()) {
    message = "WinRT HTTP request failed.";
  }

  return message;
}

std::optional<SseRequestOptions> ParseRequestJson(
    std::string const &requestJson,
    std::wstring &error) noexcept {
  SseRequestOptions options;

  try {
    auto json = JsonObject::Parse(winrt::to_hstring(requestJson));
    auto url = json.GetNamedString(L"url", L"");
    if (url.empty()) {
      error = L"SSE request url is required.";
      return std::nullopt;
    }

    auto method = json.GetNamedString(L"method", L"GET");
    options.Url = winrt::to_string(url);
    options.Method = winrt::to_string(method);
    options.WithCredentials = json.GetNamedBoolean(L"withCredentials", false);

    if (json.HasKey(L"body")) {
      auto bodyValue = json.Lookup(L"body");
      if (bodyValue.ValueType() == JsonValueType::String) {
        options.Body = winrt::to_string(bodyValue.GetString());
      }
    }

    if (json.HasKey(L"headers")) {
      auto headersValue = json.Lookup(L"headers");
      if (headersValue.ValueType() != JsonValueType::Object) {
        error = L"SSE request headers must be an object.";
        return std::nullopt;
      }

      auto headersObject = headersValue.GetObject();
      for (auto const &headerEntry : headersObject) {
        if (headerEntry.Value().ValueType() != JsonValueType::String) {
          continue;
        }

        auto name = std::wstring(headerEntry.Key());
        auto value = std::wstring(headerEntry.Value().GetString());
        if (!name.empty() && !value.empty()) {
          options.Headers[std::move(name)] = std::move(value);
        }
      }
    }
  } catch (...) {
    error = L"Unable to parse the SSE request payload.";
    return std::nullopt;
  }

  return options;
}

bool ApplyRequestHeaders(
    HttpRequestMessage &request,
    HttpStringContent const &content,
    SseRequestOptions const &options,
    std::wstring &error) {
  for (auto const &[name, value] : options.Headers) {
    try {
      if (EqualsCaseInsensitive(name, L"content-type")) {
        if (content) {
          if (HttpMediaTypeHeaderValue mediaType{nullptr};
              HttpMediaTypeHeaderValue::TryParse(winrt::hstring(value), mediaType)) {
            content.Headers().ContentType(mediaType);
          } else {
            error = L"Invalid Content-Type header.";
            return false;
          }
        }
        continue;
      }

      if (content &&
          (EqualsCaseInsensitive(name, L"content-encoding") ||
           EqualsCaseInsensitive(name, L"content-language") ||
           EqualsCaseInsensitive(name, L"content-location"))) {
        if (!content.Headers().TryAppendWithoutValidation(winrt::hstring(name), winrt::hstring(value))) {
          error = L"Failed to append an SSE content header.";
          return false;
        }
        continue;
      }

      if (!request.Headers().TryAppendWithoutValidation(winrt::hstring(name), winrt::hstring(value))) {
        error = L"Failed to append an SSE request header.";
        return false;
      }
    } catch (...) {
      error = L"Unexpected error while applying SSE request headers.";
      return false;
    }
  }

  return true;
}

std::optional<HttpRequestMessage> BuildHttpRequest(
    SseRequestOptions const &options,
    std::wstring &error) noexcept {
  try {
    auto method = HttpMethod(winrt::to_hstring(options.Method.empty() ? std::string("GET") : options.Method));
    auto request = HttpRequestMessage(method, Uri(winrt::to_hstring(options.Url)));

    HttpStringContent content{nullptr};
    if (!options.Body.empty()) {
      content = HttpStringContent(
          winrt::to_hstring(options.Body),
          UnicodeEncoding::Utf8);
      request.Content(content);
    }

    if (!ApplyRequestHeaders(request, content, options, error)) {
      return std::nullopt;
    }

    return request;
  } catch (winrt::hresult_error const &runtimeError) {
    error = runtimeError.message().c_str();
    if (error.empty()) {
      error = L"Unable to construct the SSE request.";
    }
    return std::nullopt;
  } catch (...) {
    error = L"Unable to construct the SSE request.";
    return std::nullopt;
  }
}

JSValueObject BuildHeadersPayload(HttpResponseMessage const &response) {
  JSValueObject headers;

  for (auto const &header : response.Headers()) {
    headers[winrt::to_string(header.Key())] = winrt::to_string(header.Value());
  }

  for (auto const &header : response.Content().Headers()) {
    headers[winrt::to_string(header.Key())] = winrt::to_string(header.Value());
  }

  return headers;
}

void EmitResponse(
    std::shared_ptr<SseConnectionState> const &connection,
    HttpResponseMessage const &response) noexcept {
  if (IsCloseRequested(connection)) {
    return;
  }

  auto reasonPhrase = winrt::to_string(response.ReasonPhrase());
  EmitConnectionEvent(
      connection,
      JSValueObject{
          {"connectionId", connection->ConnectionId},
          {"type", "response"},
          {"status", static_cast<int64_t>(response.StatusCode())},
          {"statusText", reasonPhrase},
          {"headers", BuildHeadersPayload(response)},
      });
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

void EmitChunk(
    std::shared_ptr<SseConnectionState> const &connection,
    std::string chunk) noexcept {
  if (chunk.empty() || IsCloseRequested(connection)) {
    return;
  }

  EmitConnectionEvent(
      connection,
      JSValueObject{
          {"connectionId", connection->ConnectionId},
          {"type", "chunk"},
          {"chunk", std::move(chunk)},
      });
}

void EmitComplete(std::shared_ptr<SseConnectionState> const &connection) noexcept {
  if (IsCloseRequested(connection)) {
    return;
  }

  EmitConnectionEvent(
      connection,
      JSValueObject{
          {"connectionId", connection->ConnectionId},
          {"type", "complete"},
      });
}

void RunConnection(
    std::shared_ptr<SseConnectionState> const &connection,
    SseRequestOptions requestOptions) noexcept {
  auto runBody = [&]() {
  try {
    HttpBaseProtocolFilter filter;
    filter.CacheControl().ReadBehavior(HttpCacheReadBehavior::NoCache);

    auto client = HttpClient(filter);
    {
      std::scoped_lock lock(connection->Mutex);
      if (connection->CloseRequested) {
        return;
      }

      connection->Client = client;
    }

    std::wstring requestError;
    auto request = BuildHttpRequest(requestOptions, requestError);
    if (!request) {
      EmitConnectionError(connection, WideToUtf8(requestError));
      return;
    }

    auto response = client.SendRequestAsync(*request, HttpCompletionOption::ResponseHeadersRead).get();
    if (IsCloseRequested(connection)) {
      return;
    }

    EmitResponse(connection, response);

    auto inputStream = response.Content().ReadAsInputStreamAsync().get();
    {
      std::scoped_lock lock(connection->Mutex);
      if (connection->CloseRequested) {
        inputStream.Close();
        return;
      }

      connection->Stream = inputStream;
    }

    auto reader = DataReader(inputStream);
    reader.InputStreamOptions(InputStreamOptions::Partial);

    std::vector<uint8_t> utf8Buffer;
    while (true) {
      if (IsCloseRequested(connection)) {
        return;
      }

      auto loaded = reader.LoadAsync(kReadChunkSize).get();
      if (loaded == 0) {
        break;
      }

      std::vector<uint8_t> chunkBytes(loaded);
      reader.ReadBytes(chunkBytes);
      utf8Buffer.insert(utf8Buffer.end(), chunkBytes.begin(), chunkBytes.end());

      while (auto chunk = DrainUtf8Chunk(utf8Buffer)) {
        EmitChunk(connection, std::move(*chunk));
      }
    }

    if (IsCloseRequested(connection)) {
      return;
    }

    if (!utf8Buffer.empty()) {
      if (ResolveSafeUtf8PrefixLength(utf8Buffer) != utf8Buffer.size()) {
        EmitConnectionError(
            connection,
            "SSE stream ended with an incomplete UTF-8 sequence.",
            "ERR_SSE_TRANSPORT_UTF8");
        return;
      }

      EmitChunk(
          connection,
          std::string(
              reinterpret_cast<char const *>(utf8Buffer.data()),
              reinterpret_cast<char const *>(utf8Buffer.data()) + utf8Buffer.size()));
    }

    EmitComplete(connection);
  } catch (winrt::hresult_error const &runtimeError) {
    if (!IsCloseRequested(connection)) {
      EmitConnectionError(connection, FormatHResultError(runtimeError));
    }
  } catch (std::exception const &error) {
    if (!IsCloseRequested(connection)) {
      EmitConnectionError(connection, error.what());
    }
  } catch (...) {
    if (!IsCloseRequested(connection)) {
      EmitConnectionError(connection, "Unhandled native SSE transport failure.");
    }
  }};

  runBody();
  ResetConnectionResources(connection);
  UnregisterConnection(connection->ConnectionId);
}

} // namespace

REACT_MODULE(OpappSseModule, L"OpappSse")
struct OpappSseModule {
  REACT_INIT(Initialize)
  void Initialize(ReactContext const &reactContext) noexcept {
    m_reactContext = reactContext;
  }

  REACT_METHOD(Open, L"open")
  void Open(
      std::string requestJson,
      winrt::Microsoft::ReactNative::ReactPromise<std::string> &&result) noexcept {
    std::wstring parseError;
    auto request = ParseRequestJson(requestJson, parseError);
    if (!request) {
      result.Reject(parseError.c_str());
      return;
    }

    auto connection = std::make_shared<SseConnectionState>();
    connection->ConnectionId = GenerateConnectionId();
    connection->Context = m_reactContext;
    RegisterConnection(connection);

    try {
      std::thread(
          [connection, request = std::move(*request)]() mutable noexcept {
            RunConnection(connection, std::move(request));
          })
          .detach();
    } catch (...) {
      UnregisterConnection(connection->ConnectionId);
      result.Reject(L"Failed to launch the native SSE worker.");
      return;
    }

    result.Resolve(connection->ConnectionId);
  }

  REACT_METHOD(Close, L"close")
  void Close(
      std::string connectionId,
      winrt::Microsoft::ReactNative::ReactPromise<void> &&result) noexcept {
    auto connection = FindConnection(connectionId);
    if (connection) {
      CloseConnection(connection);
      UnregisterConnection(connectionId);
    }

    result.Resolve();
  }

  REACT_METHOD(AddListener, L"addListener")
  void AddListener(std::string const & /*eventName*/) noexcept {}

  REACT_METHOD(RemoveListeners, L"removeListeners")
  void RemoveListeners(double /*count*/) noexcept {}

 private:
  ReactContext m_reactContext{nullptr};
};

} // namespace OpappWindowsHostModules
