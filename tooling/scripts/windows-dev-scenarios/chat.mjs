import {readdir, rm} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {startCompanionChatSmokeServer} from '../companion-chat-sse-smoke.mjs';

const llmChatDevSmokeUiStateRelativePath = path.join(
  'llm-chat',
  'dev-smoke-ui-state.json',
);

function createCompanionChatSmokeMarkers({
  companionChatBundleId,
  companionChatSurfaceId,
}) {
  return [
    'Runtime=Metro entryFile=index.chat',
    `LaunchSurface surface=${companionChatSurfaceId} policy=main mode=`,
    `[frontend-companion] render bundle=${companionChatBundleId} window=window.main surface=${companionChatSurfaceId} policy=main`,
    `[frontend-companion] mounted bundle=${companionChatBundleId} window=window.main surface=${companionChatSurfaceId} policy=main`,
  ];
}

function buildCompanionChatLaunchConfig(companionChatSurfaceId) {
  return {
    main: {
      surface: companionChatSurfaceId,
      policy: 'main',
      'entry-file': 'index.chat',
    },
  };
}

function assertCompanionChatSmokeRequestCaptured(state, failureLabel) {
  if (!state || state.requests.length !== 1) {
    throw new Error(
      `Windows dev verify failed: ${failureLabel} expected exactly 1 SSE request, received ${state?.requests.length ?? 0}.`,
    );
  }

  const request = state.requests[0];
  if (request?.method !== 'POST') {
    throw new Error(
      `Windows dev verify failed: ${failureLabel} did not send a POST request to the local SSE server.`,
    );
  }

  if (request?.body?.model !== state.model) {
    throw new Error(
      `Windows dev verify failed: ${failureLabel} did not send the fixture model to the local SSE server.`,
    );
  }

  if (request?.body?.stream !== true) {
    throw new Error(
      `Windows dev verify failed: ${failureLabel} did not request stream=true from the local SSE server.`,
    );
  }

  const lastMessage = request?.body?.messages?.at?.(-1);
  if (
    !lastMessage ||
    lastMessage.role !== 'user' ||
    lastMessage.content !== state.requestPrompt
  ) {
    throw new Error(
      `Windows dev verify failed: ${failureLabel} did not send the expected user prompt to the local SSE server.`,
    );
  }
}

async function resolveCompanionChatSmokeUiStatePaths(tempRoot) {
  const localAppDataRoot = process.env.LOCALAPPDATA || tempRoot;
  const candidates = [
    path.join(localAppDataRoot, 'OPApp', llmChatDevSmokeUiStateRelativePath),
  ];
  const packagesRoot = path.join(localAppDataRoot, 'Packages');

  try {
    const entries = await readdir(packagesRoot, {withFileTypes: true});
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith('OpappWindowsHost_')) {
        continue;
      }

      candidates.unshift(
        path.join(
          packagesRoot,
          entry.name,
          'LocalCache',
          'Local',
          'OPApp',
          llmChatDevSmokeUiStateRelativePath,
        ),
      );
    }
  } catch {
    // Fall back to the non-packaged local app-data root only.
  }

  return [...new Set(candidates)];
}

async function clearCompanionChatSmokeUiArtifacts(tempRoot) {
  const uiStatePaths = await resolveCompanionChatSmokeUiStatePaths(tempRoot);
  for (const candidatePath of uiStatePaths) {
    await rm(candidatePath, {force: true});
  }
}

async function prepareCompanionChatSmokeState(tempRoot, options = {}) {
  await clearCompanionChatSmokeUiArtifacts(tempRoot);
  return await startCompanionChatSmokeServer(options);
}

async function cleanupCompanionChatSmokeState(tempRoot, state) {
  await state?.close?.();
  await clearCompanionChatSmokeUiArtifacts(tempRoot);
}

export function createCompanionChatDevScenarios({
  companionChatBundleId,
  companionChatSurfaceId,
  createLlmChatSpec,
  devChatToken,
  tempRoot,
}) {
  const baseSmokeMarkers = createCompanionChatSmokeMarkers({
    companionChatBundleId,
    companionChatSurfaceId,
  });

  return [
    {
      name: 'companion-chat-current-window',
      description:
        'Metro-backed Windows host launches the chat child bundle directly into the main window',
      smokeMarkers: [
        ...baseSmokeMarkers,
        '[frontend-llm-chat] dev-smoke-start',
        '[frontend-llm-chat] dev-smoke-open',
        '[frontend-llm-chat] dev-smoke-assistant-text text=CHAT_TEST_OK',
        '[frontend-llm-chat] dev-smoke-complete',
      ],
      async prepareState() {
        return await prepareCompanionChatSmokeState(tempRoot);
      },
      buildLaunchConfig() {
        return buildCompanionChatLaunchConfig(companionChatSurfaceId);
      },
      async cleanupState(state) {
        await cleanupCompanionChatSmokeState(tempRoot, state);
      },
      async buildUiSpec(state) {
        return await createLlmChatSpec({
          baseUrl: state?.baseUrl ?? '',
          model: state?.model ?? 'fixture-native-sse',
          token: devChatToken,
          prompt: state?.requestPrompt ?? 'CHAT_TEST_PROMPT',
          expectedAssistantText: 'CHAT_TEST_OK',
        });
      },
      async verifyUiResult(_uiResult, state) {
        assertCompanionChatSmokeRequestCaptured(state, 'companion chat dev smoke');
      },
      successSummary:
        'Metro-backed Windows host completed direct chat child-bundle startup smoke.',
    },
    {
      name: 'companion-chat-current-window-server-error',
      description:
        'Metro-backed Windows host surfaces an expected native SSE HTTP error from the chat child bundle in the main window',
      smokeMarkers: [
        ...baseSmokeMarkers,
        '[frontend-llm-chat] dev-smoke-start',
        '[frontend-llm-chat] dev-smoke-error message=EventSource requires HTTP 200, received 500.',
        '[frontend-llm-chat] dev-smoke-error-ui path=llm-chat/dev-smoke-ui-state.json message=EventSource requires HTTP 200, received 500.',
        '[frontend-llm-chat] dev-smoke-complete',
      ],
      async prepareState() {
        return await prepareCompanionChatSmokeState(tempRoot, {
          scenario: 'llm-chat-native-sse-server-error',
        });
      },
      buildLaunchConfig() {
        return buildCompanionChatLaunchConfig(companionChatSurfaceId);
      },
      async cleanupState(state) {
        await cleanupCompanionChatSmokeState(tempRoot, state);
      },
      async buildUiSpec(state) {
        return await createLlmChatSpec({
          baseUrl: state?.baseUrl ?? '',
          model: state?.model ?? 'fixture-native-sse',
          token: devChatToken,
          prompt: state?.requestPrompt ?? 'CHAT_TEST_PROMPT',
          expectedErrorText:
            state?.expectedErrorText ?? 'EventSource requires HTTP 200',
        });
      },
      async verifyUiResult(_uiResult, state) {
        assertCompanionChatSmokeRequestCaptured(
          state,
          'companion chat server-error dev smoke',
        );
      },
      successSummary:
        'Metro-backed Windows host completed direct chat child-bundle server-error smoke.',
    },
    {
      name: 'companion-chat-current-window-malformed-chunk',
      description:
        'Metro-backed Windows host surfaces a malformed native SSE chunk error from the chat child bundle in the main window and records the rendered error state',
      smokeMarkers: [
        ...baseSmokeMarkers,
        '[frontend-llm-chat] dev-smoke-start',
        '[frontend-llm-chat] dev-smoke-open',
        '[frontend-llm-chat] dev-smoke-error message=服务端返回了无法解析的流式 JSON 数据。',
        '[frontend-llm-chat] dev-smoke-error-ui path=llm-chat/dev-smoke-ui-state.json message=服务端返回了无法解析的流式 JSON 数据。',
        '[frontend-llm-chat] dev-smoke-complete',
      ],
      async prepareState() {
        return await prepareCompanionChatSmokeState(tempRoot, {
          scenario: 'llm-chat-native-sse-malformed-chunk',
        });
      },
      buildLaunchConfig() {
        return buildCompanionChatLaunchConfig(companionChatSurfaceId);
      },
      async cleanupState(state) {
        await cleanupCompanionChatSmokeState(tempRoot, state);
      },
      async buildUiSpec(state) {
        return await createLlmChatSpec({
          baseUrl: state?.baseUrl ?? '',
          model: state?.model ?? 'fixture-native-sse',
          token: devChatToken,
          prompt: state?.requestPrompt ?? 'CHAT_TEST_PROMPT',
          expectedErrorText:
            state?.expectedErrorText ?? '服务端返回了无法解析的流式 JSON 数据。',
        });
      },
      async verifyUiResult(_uiResult, state) {
        assertCompanionChatSmokeRequestCaptured(
          state,
          'companion chat malformed-chunk dev smoke',
        );
      },
      successSummary:
        'Metro-backed Windows host completed direct chat child-bundle malformed-chunk smoke.',
    },
    {
      name: 'companion-chat-current-window-stream-abort',
      description:
        'Metro-backed Windows host surfaces an interrupted native SSE stream error from the chat child bundle in the main window and records the rendered error state',
      smokeMarkers: [
        ...baseSmokeMarkers,
        '[frontend-llm-chat] dev-smoke-start',
        '[frontend-llm-chat] dev-smoke-open',
        '[frontend-llm-chat] dev-smoke-error message=服务端在完成流式响应前中断了连接。',
        '[frontend-llm-chat] dev-smoke-error-ui path=llm-chat/dev-smoke-ui-state.json message=服务端在完成流式响应前中断了连接。',
        '[frontend-llm-chat] dev-smoke-complete',
      ],
      async prepareState() {
        return await prepareCompanionChatSmokeState(tempRoot, {
          scenario: 'llm-chat-native-sse-stream-abort',
        });
      },
      buildLaunchConfig() {
        return buildCompanionChatLaunchConfig(companionChatSurfaceId);
      },
      async cleanupState(state) {
        await cleanupCompanionChatSmokeState(tempRoot, state);
      },
      async buildUiSpec(state) {
        return await createLlmChatSpec({
          baseUrl: state?.baseUrl ?? '',
          model: state?.model ?? 'fixture-native-sse',
          token: devChatToken,
          prompt: state?.requestPrompt ?? 'CHAT_TEST_PROMPT',
          expectedErrorText:
            state?.expectedErrorText ?? '服务端在完成流式响应前中断了连接。',
        });
      },
      async verifyUiResult(_uiResult, state) {
        assertCompanionChatSmokeRequestCaptured(
          state,
          'companion chat stream-abort dev smoke',
        );
      },
      successSummary:
        'Metro-backed Windows host completed direct chat child-bundle stream-abort smoke.',
    },
  ];
}
