import {spawnSync} from 'node:child_process';
import {createServer} from 'node:http';
import {existsSync} from 'node:fs';
import {mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {publishToLocalRegistry} from '../artifact-source.mjs';
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

function createCompanionChatCurrentWindowMarkers({
  companionChatBundleId,
  companionChatSurfaceId,
}) {
  return [
    `InitialOpenSurface surface=${companionChatSurfaceId} policy=main presentation=current-window`,
    `[frontend-companion] auto-open bundle=opapp.companion.main window=window.main surface=${companionChatSurfaceId} presentation=current-window targetBundle=${companionChatBundleId}`,
    `BundleSwitchPrepared window=window.main bundle=${companionChatBundleId} surface=${companionChatSurfaceId} policy=main`,
    `BundleSwitchReloadRequested window=window.main bundle=${companionChatBundleId}`,
    `[frontend-companion] render bundle=${companionChatBundleId} window=window.main surface=${companionChatSurfaceId} policy=main`,
    `[frontend-companion] mounted bundle=${companionChatBundleId} window=window.main surface=${companionChatSurfaceId} policy=main`,
  ];
}

function assertCompanionChatSmokeRequestCaptured(state, failureLabel) {
  const chatSmokeState = state?.chatSmoke ?? state;
  if (!chatSmokeState || chatSmokeState.requests.length !== 1) {
    throw new Error(
      `Windows dev verify failed: ${failureLabel} expected exactly 1 SSE request, received ${chatSmokeState?.requests.length ?? 0}.`,
    );
  }

  const request = chatSmokeState.requests[0];
  if (request?.method !== 'POST') {
    throw new Error(
      `Windows dev verify failed: ${failureLabel} did not send a POST request to the local SSE server.`,
    );
  }

  if (request?.body?.model !== chatSmokeState.model) {
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
    lastMessage.content !== chatSmokeState.requestPrompt
  ) {
    throw new Error(
      `Windows dev verify failed: ${failureLabel} did not send the expected user prompt to the local SSE server.`,
    );
  }
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

function ensureCompanionChatBundleOutput(frontendRoot, frontendChatBundleRoot) {
  const manifestPath = path.join(frontendChatBundleRoot, 'bundle-manifest.json');
  if (existsSync(manifestPath)) {
    return;
  }

  const command = 'corepack pnpm --filter @opapp/app-companion bundle:windows';
  const result = spawnSync('cmd.exe', ['/d', '/s', '/c', command], {
    cwd: frontendRoot,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(
      `Windows dev verify failed: could not prepare companion chat bundle output via '${command}'.`,
    );
  }

  if (!existsSync(manifestPath)) {
    throw new Error(
      `Windows dev verify failed: companion chat bundle manifest is still missing after bundling at ${manifestPath}.`,
    );
  }
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

async function createCompanionChatOtaFixture({
  companionChatBundleId,
  frontendChatBundleRoot,
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
      'Windows dev verify failed: companion chat bundle manifest is missing version.',
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
  return {
    registryRoot,
    server: serverHandle.server,
    otaRemoteBaseUrl: serverHandle.baseUrl,
    otaChannel: 'nightly',
  };
}

async function prepareCompanionChatCurrentWindowState(
  tempRoot,
  {
    companionChatBundleId,
    frontendRoot,
    frontendChatBundleRoot,
  },
) {
  await clearCompanionChatSmokeUiArtifacts(tempRoot);
  ensureCompanionChatBundleOutput(frontendRoot, frontendChatBundleRoot);
  const chatSmoke = await startCompanionChatSmokeServer();
  try {
    return {
      ...(await createCompanionChatOtaFixture({
        companionChatBundleId,
        frontendChatBundleRoot,
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

async function cleanupCompanionChatCurrentWindowState(tempRoot, state) {
  await state?.chatSmoke?.close?.();
  await clearCompanionChatSmokeUiArtifacts(tempRoot);

  if (state?.server) {
    await closeRegistryServer(state.server);
  }

  if (state?.registryRoot) {
    await removeIfPresent(state.registryRoot);
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
    ota: {
      remote: state?.otaRemoteBaseUrl ?? '',
      channel: state?.otaChannel ?? 'nightly',
    },
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

function verifyCompanionChatBundleSwitchRuntime(logContents, companionChatBundleId) {
  const normalized = logContents.replace(/\r/g, '');
  const bundledRuntimeRegex = new RegExp(
    `BundleSwitchRuntime window=window\\.main bundle=${escapeRegex(companionChatBundleId)} mode=bundle(?:\\s|$)`,
  );
  if (!bundledRuntimeRegex.test(normalized)) {
    throw new Error(
      `Windows dev verify failed: current-window child bundle switch did not log bundled runtime for ${companionChatBundleId}.`,
    );
  }

  const metroRuntimeRegex = new RegExp(
    `BundleSwitchRuntime window=window\\.main bundle=${escapeRegex(companionChatBundleId)} mode=metro(?:\\s|$)`,
  );
  if (metroRuntimeRegex.test(normalized)) {
    throw new Error(
      `Windows dev verify failed: current-window child bundle switch incorrectly reused Metro runtime for ${companionChatBundleId}.`,
    );
  }
}

export function createCompanionChatDevScenarios({
  companionChatBundleId,
  companionChatSurfaceId,
  createLlmChatSpec,
  devChatToken,
  frontendRoot,
  frontendChatBundleRoot,
  tempRoot,
}) {
  const baseSmokeMarkers = createCompanionChatSmokeMarkers({
    companionChatBundleId,
    companionChatSurfaceId,
  });
  const currentWindowBundleMarkers = createCompanionChatCurrentWindowMarkers({
    companionChatBundleId,
    companionChatSurfaceId,
  });
  const currentWindowLaunchConfigOptions = {
    companionChatBundleId,
    companionChatSurfaceId,
  };
  const currentWindowStateOptions = {
    companionChatBundleId,
    frontendRoot,
    frontendChatBundleRoot,
  };

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
      name: 'companion-chat-current-window-bundle-switch',
      description:
        'Metro-backed Windows host launches the main bundle, then switches the current window into the bundled chat child runtime via OTA hydration',
      smokeMarkers: [
        ...currentWindowBundleMarkers,
        '[frontend-llm-chat] dev-smoke-start',
        '[frontend-llm-chat] dev-smoke-open',
        '[frontend-llm-chat] dev-smoke-assistant-text text=CHAT_TEST_OK',
        '[frontend-llm-chat] dev-smoke-complete',
      ],
      async prepareState() {
        return await prepareCompanionChatCurrentWindowState(
          tempRoot,
          currentWindowStateOptions,
        );
      },
      buildLaunchConfig(state) {
        return buildCompanionChatCurrentWindowLaunchConfig(
          state,
          currentWindowLaunchConfigOptions,
        );
      },
      async cleanupState(state) {
        await cleanupCompanionChatCurrentWindowState(tempRoot, state);
      },
      async buildUiSpec(state) {
        return await createLlmChatSpec({
          baseUrl: state?.chatSmoke?.baseUrl ?? '',
          model: state?.chatSmoke?.model ?? 'fixture-native-sse',
          token: devChatToken,
          prompt: state?.chatSmoke?.requestPrompt ?? 'CHAT_TEST_PROMPT',
          expectedAssistantText: 'CHAT_TEST_OK',
        });
      },
      async verifyUiResult(_uiResult, state) {
        assertCompanionChatSmokeRequestCaptured(
          state,
          'companion chat current-window bundle-switch dev smoke',
        );
      },
      async verifyLog(logContents) {
        verifyCompanionChatBundleSwitchRuntime(
          logContents,
          companionChatBundleId,
        );
      },
      successSummary:
        'Metro-backed Windows host completed current-window chat bundle-switch smoke with bundled child runtime.',
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
