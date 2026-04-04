function buildBaseSuccessMarkers({
  commonSuccessMarkers,
  companionChatBundleId,
  companionChatSurfaceId,
}) {
  return [
    ...commonSuccessMarkers,
    `InitialOpenSurface surface=${companionChatSurfaceId} policy=main presentation=current-window`,
    `BundleSwitchPrepared window=window.main bundle=${companionChatBundleId} surface=${companionChatSurfaceId} policy=main`,
    `BundleSwitchReloadRequested window=window.main bundle=${companionChatBundleId}`,
    `[frontend-companion] render bundle=${companionChatBundleId} window=window.main surface=${companionChatSurfaceId} policy=main`,
    `[frontend-companion] mounted bundle=${companionChatBundleId} window=window.main surface=${companionChatSurfaceId} policy=main`,
  ];
}

export function createCompanionChatReleaseScenarios({
  assertCompanionChatSmokeRequestCaptured,
  buildCompanionChatCurrentWindowLaunchConfig,
  cleanupCompanionChatCurrentWindowState,
  commonSuccessMarkers,
  companionChatBundleId,
  companionChatSurfaceId,
  createCompanionChatCurrentWindowState,
  createLlmChatSpec,
  defaultPreferences,
  releaseChatToken,
  verifyCompanionChatPersistedSession,
}) {
  const baseSuccessMarkers = buildBaseSuccessMarkers({
    commonSuccessMarkers,
    companionChatBundleId,
    companionChatSurfaceId,
  });

  return {
    'companion-chat-current-window': {
      description:
        'auto-open companion chat in the current window and switch into the child chat bundle',
      preferences: defaultPreferences,
      usesLocalOtaRemoteFixture: true,
      skipNativeOtaVerification: true,
      buildLaunchConfig: buildCompanionChatCurrentWindowLaunchConfig,
      async prepareState() {
        return await createCompanionChatCurrentWindowState();
      },
      successMarkers: [
        ...baseSuccessMarkers,
        '[frontend-llm-chat] dev-smoke-start',
        '[frontend-llm-chat] dev-smoke-open',
        '[frontend-llm-chat] dev-smoke-assistant-text text=CHAT_TEST_OK',
        '[frontend-llm-chat] dev-smoke-complete',
      ],
      cleanupState: cleanupCompanionChatCurrentWindowState,
      async buildUiSpec(state) {
        return await createLlmChatSpec({
          baseUrl: state?.chatSmoke?.baseUrl ?? '',
          model: state?.chatSmoke?.model ?? 'fixture-native-sse',
          token: releaseChatToken,
          prompt: state?.chatSmoke?.requestPrompt ?? 'CHAT_TEST_PROMPT',
          expectedAssistantText: 'CHAT_TEST_OK',
        });
      },
      async verifyUiResult(_uiResult, state) {
        assertCompanionChatSmokeRequestCaptured(
          state,
          'companion chat current-window flow',
        );
      },
      verifyPersistedSession(sessionFile) {
        verifyCompanionChatPersistedSession(
          sessionFile,
          'companion chat current-window flow',
        );
      },
    },
    'companion-chat-current-window-server-error': {
      description:
        'auto-open companion chat in the current window and surface an expected native SSE HTTP error from the child chat bundle',
      preferences: defaultPreferences,
      usesLocalOtaRemoteFixture: true,
      skipNativeOtaVerification: true,
      buildLaunchConfig: buildCompanionChatCurrentWindowLaunchConfig,
      async prepareState() {
        return await createCompanionChatCurrentWindowState({
          scenario: 'llm-chat-native-sse-server-error',
        });
      },
      successMarkers: [
        ...baseSuccessMarkers,
        '[frontend-llm-chat] dev-smoke-start',
        '[frontend-llm-chat] dev-smoke-error message=EventSource requires HTTP 200, received 500.',
        '[frontend-llm-chat] dev-smoke-error-ui path=llm-chat/dev-smoke-ui-state.json message=EventSource requires HTTP 200, received 500.',
        '[frontend-llm-chat] dev-smoke-complete',
      ],
      cleanupState: cleanupCompanionChatCurrentWindowState,
      async buildUiSpec(state) {
        return await createLlmChatSpec({
          baseUrl: state?.chatSmoke?.baseUrl ?? '',
          model: state?.chatSmoke?.model ?? 'fixture-native-sse',
          token: releaseChatToken,
          prompt: state?.chatSmoke?.requestPrompt ?? 'CHAT_TEST_PROMPT',
          expectedErrorText:
            state?.chatSmoke?.expectedErrorText ??
            'EventSource requires HTTP 200, received 500.',
        });
      },
      async verifyUiResult(_uiResult, state) {
        assertCompanionChatSmokeRequestCaptured(
          state,
          'companion chat current-window server-error flow',
        );
      },
      verifyPersistedSession(sessionFile) {
        verifyCompanionChatPersistedSession(
          sessionFile,
          'companion chat current-window server-error flow',
        );
      },
    },
    'companion-chat-current-window-malformed-chunk': {
      description:
        'auto-open companion chat in the current window and surface an expected malformed SSE chunk error from the child chat bundle',
      preferences: defaultPreferences,
      usesLocalOtaRemoteFixture: true,
      skipNativeOtaVerification: true,
      buildLaunchConfig: buildCompanionChatCurrentWindowLaunchConfig,
      async prepareState() {
        return await createCompanionChatCurrentWindowState({
          scenario: 'llm-chat-native-sse-malformed-chunk',
        });
      },
      successMarkers: [
        ...baseSuccessMarkers,
        '[frontend-llm-chat] dev-smoke-start',
        '[frontend-llm-chat] dev-smoke-open',
        '[frontend-llm-chat] dev-smoke-error message=服务端返回了无法解析的流式 JSON 数据。',
        '[frontend-llm-chat] dev-smoke-error-ui path=llm-chat/dev-smoke-ui-state.json message=服务端返回了无法解析的流式 JSON 数据。',
        '[frontend-llm-chat] dev-smoke-complete',
      ],
      cleanupState: cleanupCompanionChatCurrentWindowState,
      async buildUiSpec(state) {
        return await createLlmChatSpec({
          baseUrl: state?.chatSmoke?.baseUrl ?? '',
          model: state?.chatSmoke?.model ?? 'fixture-native-sse',
          token: releaseChatToken,
          prompt: state?.chatSmoke?.requestPrompt ?? 'CHAT_TEST_PROMPT',
          expectedErrorText:
            state?.chatSmoke?.expectedErrorText ??
            '服务端返回了无法解析的流式 JSON 数据。',
        });
      },
      async verifyUiResult(_uiResult, state) {
        assertCompanionChatSmokeRequestCaptured(
          state,
          'companion chat current-window malformed-chunk flow',
        );
      },
      verifyPersistedSession(sessionFile) {
        verifyCompanionChatPersistedSession(
          sessionFile,
          'companion chat current-window malformed-chunk flow',
        );
      },
    },
    'companion-chat-current-window-stream-abort': {
      description:
        'auto-open companion chat in the current window and surface an expected interrupted SSE stream error from the child chat bundle',
      preferences: defaultPreferences,
      usesLocalOtaRemoteFixture: true,
      skipNativeOtaVerification: true,
      buildLaunchConfig: buildCompanionChatCurrentWindowLaunchConfig,
      async prepareState() {
        return await createCompanionChatCurrentWindowState({
          scenario: 'llm-chat-native-sse-stream-abort',
        });
      },
      successMarkers: [
        ...baseSuccessMarkers,
        '[frontend-llm-chat] dev-smoke-start',
        '[frontend-llm-chat] dev-smoke-open',
        '[frontend-llm-chat] dev-smoke-error message=服务端在完成流式响应前中断了连接。',
        '[frontend-llm-chat] dev-smoke-error-ui path=llm-chat/dev-smoke-ui-state.json message=服务端在完成流式响应前中断了连接。',
        '[frontend-llm-chat] dev-smoke-complete',
      ],
      cleanupState: cleanupCompanionChatCurrentWindowState,
      async buildUiSpec(state) {
        return await createLlmChatSpec({
          baseUrl: state?.chatSmoke?.baseUrl ?? '',
          model: state?.chatSmoke?.model ?? 'fixture-native-sse',
          token: releaseChatToken,
          prompt: state?.chatSmoke?.requestPrompt ?? 'CHAT_TEST_PROMPT',
          expectedErrorText:
            state?.chatSmoke?.expectedErrorText ??
            '服务端在完成流式响应前中断了连接。',
        });
      },
      async verifyUiResult(_uiResult, state) {
        assertCompanionChatSmokeRequestCaptured(
          state,
          'companion chat current-window stream-abort flow',
        );
      },
      verifyPersistedSession(sessionFile) {
        verifyCompanionChatPersistedSession(
          sessionFile,
          'companion chat current-window stream-abort flow',
        );
      },
    },
  };
}
