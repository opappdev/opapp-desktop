import {createServer} from 'node:http';
import {mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {publishToLocalRegistry} from '../artifact-source.mjs';
import {startCompanionChatSmokeServer} from '../companion-chat-sse-smoke.mjs';

const llmChatDevSmokeUiStateRelativePath = path.join(
  'llm-chat',
  'dev-smoke-ui-state.json',
);

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

async function startRegistryServer(registryRoot) {
  return await new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const requestPath = decodeURIComponent(url.pathname);
        const filePath = path.join(
          registryRoot,
          ...requestPath.split('/').filter(Boolean),
        );
        const normalizedRoot = path.resolve(registryRoot);
        const normalizedFilePath = path.resolve(filePath);
        if (
          normalizedFilePath !== normalizedRoot &&
          !normalizedFilePath.startsWith(`${normalizedRoot}${path.sep}`)
        ) {
          res.writeHead(403);
          res.end('forbidden');
          return;
        }

        const body = await readFile(normalizedFilePath);
        const contentType = normalizedFilePath.endsWith('.json')
          ? 'application/json'
          : 'application/octet-stream';
        res.writeHead(200, {'Content-Type': contentType});
        res.end(body);
      } catch (error) {
        if (error?.code === 'ENOENT') {
          res.writeHead(404);
          res.end('not found');
          return;
        }

        res.writeHead(500);
        res.end(error instanceof Error ? error.message : String(error));
      }
    });

    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Registry server did not expose a numeric port.'));
        return;
      }

      resolve({
        server,
        baseUrl: `http://127.0.0.1:${address.port}`,
      });
    });
    server.on('error', reject);
  });
}

async function closeRegistryServer(server) {
  if (!server) {
    return;
  }

  await new Promise((resolve, reject) => {
    server.close(error => {
      if (error) {
        reject(error);
        return;
      }

      resolve(undefined);
    });
  });
}

async function removeIfPresent(targetPath) {
  if (!targetPath) {
    return;
  }

  await rm(targetPath, {recursive: true, force: true});
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
    await removeIfPresent(candidatePath);
  }
}

async function createCompanionChatOtaFixture({
  companionChatBundleId,
  frontendChatBundleRoot,
  log,
  tempRoot,
}) {
  const registryRoot = path.join(tempRoot, `opapp-companion-chat-ota-${Date.now()}`);
  await mkdir(registryRoot, {recursive: true});
  await publishToLocalRegistry(frontendChatBundleRoot, registryRoot);

  const chatManifest = JSON.parse(
    await readFile(path.join(frontendChatBundleRoot, 'bundle-manifest.json'), 'utf8'),
  );
  const version = chatManifest?.version;
  if (typeof version !== 'string' || !version) {
    throw new Error(
      'Windows release smoke failed: companion chat bundle manifest is missing version.',
    );
  }

  await writeFile(
    path.join(registryRoot, 'index.json'),
    JSON.stringify(
      {
        bundles: {
          [companionChatBundleId]: {
            latestVersion: version,
            versions: [version],
            channels: {
              nightly: version,
            },
          },
        },
      },
      null,
      2,
    ),
    'utf8',
  );

  const serverHandle = await startRegistryServer(registryRoot);
  log(`companion chat ota fixture registryRoot=${registryRoot}`);
  log(`companion chat ota fixture remote=${serverHandle.baseUrl}`);
  return {
    registryRoot,
    server: serverHandle.server,
    otaRemoteBaseUrl: serverHandle.baseUrl,
    otaChannel: 'nightly',
  };
}

async function createCompanionChatCurrentWindowState(
  options = {},
  {
    companionChatBundleId,
    frontendChatBundleRoot,
    log,
    otaRemoteArg,
    tempRoot,
  },
) {
  await clearCompanionChatSmokeUiArtifacts(tempRoot);
  const chatSmoke = await startCompanionChatSmokeServer(options);
  try {
    if (otaRemoteArg) {
      return {
        chatSmoke,
      };
    }

    return {
      ...(await createCompanionChatOtaFixture({
        companionChatBundleId,
        frontendChatBundleRoot,
        log,
        tempRoot,
      })),
      chatSmoke,
    };
  } catch (error) {
    try {
      await chatSmoke.close?.();
    } catch {
      // Best-effort cleanup for a fixture that never made it into scenario state.
    }
    throw error;
  }
}

function buildCompanionChatCurrentWindowLaunchConfig(
  state,
  {
    companionChatBundleId,
    companionChatSurfaceId,
  },
) {
  return {
    initialOpen: {
      surface: companionChatSurfaceId,
      bundle: companionChatBundleId,
      policy: 'main',
      presentation: 'current-window',
    },
    initialOpenProps: {
      'dev-smoke-scenario': state?.chatSmoke?.scenario ?? 'llm-chat-native-sse',
      'dev-smoke-base-url': state?.chatSmoke?.baseUrl ?? '',
    },
  };
}

async function cleanupCompanionChatCurrentWindowState(state, {tempRoot}) {
  await state?.chatSmoke?.close?.();
  await clearCompanionChatSmokeUiArtifacts(tempRoot);

  if (state?.server) {
    await closeRegistryServer(state.server);
  }

  if (state?.registryRoot) {
    await removeIfPresent(state.registryRoot);
  }
}

function assertCompanionChatSmokeRequestCaptured(state, failureLabel) {
  if (!state?.chatSmoke || state.chatSmoke.requests.length !== 1) {
    throw new Error(
      `Windows release smoke failed: ${failureLabel} expected exactly 1 SSE request, received ${state?.chatSmoke?.requests.length ?? 0}.`,
    );
  }

  const request = state.chatSmoke.requests[0];
  if (request?.method !== 'POST') {
    throw new Error(
      `Windows release smoke failed: ${failureLabel} did not send a POST request to the local SSE server.`,
    );
  }

  if (request?.body?.model !== state.chatSmoke.model) {
    throw new Error(
      `Windows release smoke failed: ${failureLabel} did not send the fixture model to the local SSE server.`,
    );
  }

  if (request?.body?.stream !== true) {
    throw new Error(
      `Windows release smoke failed: ${failureLabel} did not request stream=true from the local SSE server.`,
    );
  }

  const lastMessage = request?.body?.messages?.at?.(-1);
  if (
    !lastMessage ||
    lastMessage.role !== 'user' ||
    lastMessage.content !== state.chatSmoke.requestPrompt
  ) {
    throw new Error(
      `Windows release smoke failed: ${failureLabel} did not send the expected user prompt to the local SSE server.`,
    );
  }
}

function verifyCompanionChatPersistedSession(
  sessionFile,
  failureLabel,
  {
    assertPersistedSessionContains,
    assertPersistedSessionHasSurfaceId,
    companionChatBundleId,
    companionChatSurfaceId,
  },
) {
  if (!sessionFile.includes('[session]') || !sessionFile.includes('window.main=')) {
    throw new Error(
      `Windows release smoke failed: main window session was not persisted during ${failureLabel}.`,
    );
  }

  assertPersistedSessionHasSurfaceId(
    sessionFile,
    'window.main',
    companionChatSurfaceId,
    `${failureLabel} did not persist the chat surface in the main window session.`,
  );
  assertPersistedSessionContains(
    sessionFile,
    'window.main',
    companionChatBundleId,
    `${failureLabel} did not persist the chat bundle id in the main window session.`,
  );
}

export function createCompanionChatReleaseScenarios({
  assertPersistedSessionContains,
  assertPersistedSessionHasSurfaceId,
  commonSuccessMarkers,
  companionChatBundleId,
  companionChatSurfaceId,
  createLlmChatSpec,
  defaultPreferences,
  frontendChatBundleRoot,
  log,
  otaRemoteArg,
  releaseChatToken,
  tempRoot,
}) {
  const baseSuccessMarkers = buildBaseSuccessMarkers({
    commonSuccessMarkers,
    companionChatBundleId,
    companionChatSurfaceId,
  });
  const stateOptions = {
    companionChatBundleId,
    frontendChatBundleRoot,
    log,
    otaRemoteArg,
    tempRoot,
  };
  const launchConfigOptions = {
    companionChatBundleId,
    companionChatSurfaceId,
  };
  const sessionVerificationOptions = {
    assertPersistedSessionContains,
    assertPersistedSessionHasSurfaceId,
    companionChatBundleId,
    companionChatSurfaceId,
  };

  return {
    'companion-chat-current-window': {
      description:
        'auto-open companion chat in the current window and switch into the child chat bundle',
      preferences: defaultPreferences,
      usesLocalOtaRemoteFixture: true,
      skipNativeOtaVerification: true,
      buildLaunchConfig(state) {
        return buildCompanionChatCurrentWindowLaunchConfig(
          state,
          launchConfigOptions,
        );
      },
      async prepareState() {
        return await createCompanionChatCurrentWindowState({}, stateOptions);
      },
      successMarkers: [
        ...baseSuccessMarkers,
        '[frontend-llm-chat] dev-smoke-start',
        '[frontend-llm-chat] dev-smoke-open',
        '[frontend-llm-chat] dev-smoke-assistant-text text=CHAT_TEST_OK',
        '[frontend-llm-chat] dev-smoke-complete',
      ],
      async cleanupState(state) {
        await cleanupCompanionChatCurrentWindowState(state, {tempRoot});
      },
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
          sessionVerificationOptions,
        );
      },
    },
    'companion-chat-current-window-server-error': {
      description:
        'auto-open companion chat in the current window and surface an expected native SSE HTTP error from the child chat bundle',
      preferences: defaultPreferences,
      usesLocalOtaRemoteFixture: true,
      skipNativeOtaVerification: true,
      buildLaunchConfig(state) {
        return buildCompanionChatCurrentWindowLaunchConfig(
          state,
          launchConfigOptions,
        );
      },
      async prepareState() {
        return await createCompanionChatCurrentWindowState(
          {
            scenario: 'llm-chat-native-sse-server-error',
          },
          stateOptions,
        );
      },
      successMarkers: [
        ...baseSuccessMarkers,
        '[frontend-llm-chat] dev-smoke-start',
        '[frontend-llm-chat] dev-smoke-error message=EventSource requires HTTP 200, received 500.',
        '[frontend-llm-chat] dev-smoke-error-ui path=llm-chat/dev-smoke-ui-state.json message=EventSource requires HTTP 200, received 500.',
        '[frontend-llm-chat] dev-smoke-complete',
      ],
      async cleanupState(state) {
        await cleanupCompanionChatCurrentWindowState(state, {tempRoot});
      },
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
          sessionVerificationOptions,
        );
      },
    },
    'companion-chat-current-window-malformed-chunk': {
      description:
        'auto-open companion chat in the current window and surface an expected malformed SSE chunk error from the child chat bundle',
      preferences: defaultPreferences,
      usesLocalOtaRemoteFixture: true,
      skipNativeOtaVerification: true,
      buildLaunchConfig(state) {
        return buildCompanionChatCurrentWindowLaunchConfig(
          state,
          launchConfigOptions,
        );
      },
      async prepareState() {
        return await createCompanionChatCurrentWindowState(
          {
            scenario: 'llm-chat-native-sse-malformed-chunk',
          },
          stateOptions,
        );
      },
      successMarkers: [
        ...baseSuccessMarkers,
        '[frontend-llm-chat] dev-smoke-start',
        '[frontend-llm-chat] dev-smoke-open',
        '[frontend-llm-chat] dev-smoke-error message=服务端返回了无法解析的流式 JSON 数据。',
        '[frontend-llm-chat] dev-smoke-error-ui path=llm-chat/dev-smoke-ui-state.json message=服务端返回了无法解析的流式 JSON 数据。',
        '[frontend-llm-chat] dev-smoke-complete',
      ],
      async cleanupState(state) {
        await cleanupCompanionChatCurrentWindowState(state, {tempRoot});
      },
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
          sessionVerificationOptions,
        );
      },
    },
    'companion-chat-current-window-stream-abort': {
      description:
        'auto-open companion chat in the current window and surface an expected interrupted SSE stream error from the child chat bundle',
      preferences: defaultPreferences,
      usesLocalOtaRemoteFixture: true,
      skipNativeOtaVerification: true,
      buildLaunchConfig(state) {
        return buildCompanionChatCurrentWindowLaunchConfig(
          state,
          launchConfigOptions,
        );
      },
      async prepareState() {
        return await createCompanionChatCurrentWindowState(
          {
            scenario: 'llm-chat-native-sse-stream-abort',
          },
          stateOptions,
        );
      },
      successMarkers: [
        ...baseSuccessMarkers,
        '[frontend-llm-chat] dev-smoke-start',
        '[frontend-llm-chat] dev-smoke-open',
        '[frontend-llm-chat] dev-smoke-error message=服务端在完成流式响应前中断了连接。',
        '[frontend-llm-chat] dev-smoke-error-ui path=llm-chat/dev-smoke-ui-state.json message=服务端在完成流式响应前中断了连接。',
        '[frontend-llm-chat] dev-smoke-complete',
      ],
      async cleanupState(state) {
        await cleanupCompanionChatCurrentWindowState(state, {tempRoot});
      },
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
          sessionVerificationOptions,
        );
      },
    },
  };
}
