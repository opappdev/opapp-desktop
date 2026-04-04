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

export function createCompanionChatDevScenarios({
  assertCompanionChatSmokeRequestCaptured,
  cleanupCompanionChatSmokeState,
  companionChatBundleId,
  companionChatSurfaceId,
  createLlmChatSpec,
  devChatToken,
  prepareCompanionChatSmokeState,
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
        return await prepareCompanionChatSmokeState();
      },
      buildLaunchConfig() {
        return buildCompanionChatLaunchConfig(companionChatSurfaceId);
      },
      async cleanupState(state) {
        await cleanupCompanionChatSmokeState(state);
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
        return await prepareCompanionChatSmokeState({
          scenario: 'llm-chat-native-sse-server-error',
        });
      },
      buildLaunchConfig() {
        return buildCompanionChatLaunchConfig(companionChatSurfaceId);
      },
      async cleanupState(state) {
        await cleanupCompanionChatSmokeState(state);
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
        return await prepareCompanionChatSmokeState({
          scenario: 'llm-chat-native-sse-malformed-chunk',
        });
      },
      buildLaunchConfig() {
        return buildCompanionChatLaunchConfig(companionChatSurfaceId);
      },
      async cleanupState(state) {
        await cleanupCompanionChatSmokeState(state);
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
        return await prepareCompanionChatSmokeState({
          scenario: 'llm-chat-native-sse-stream-abort',
        });
      },
      buildLaunchConfig() {
        return buildCompanionChatLaunchConfig(companionChatSurfaceId);
      },
      async cleanupState(state) {
        await cleanupCompanionChatSmokeState(state);
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
