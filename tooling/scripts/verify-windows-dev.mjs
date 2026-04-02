import {existsSync} from 'node:fs';
import {mkdir, readFile, readdir, unlink, writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import {
  clearDevSessions,
  clearHostLaunchConfig,
  clearHostLog,
  detectDeterministicCommandFailureFromHost,
  describeMetroOutcome,
  devSessionsPath,
  ensureMetroRunning,
  ensureWorkspaceTemp,
  frontendRoot,
  formatHostCommandTailDetails,
  hostLogPath,
  hostRoot,
  killProcessTree,
  log,
  readFileTail,
  readHostLogTail,
  resolveHostCommandOutputPath,
  spawnCmdAsync,
  stopHostProcesses,
  tempRoot,
  waitForHostLogMarkers,
  workspaceRoot,
  writeHostLaunchConfig,
} from './windows-dev-common.mjs';
import {startCompanionChatSmokeServer} from './companion-chat-sse-smoke.mjs';
import {parsePositiveIntegerArg} from './windows-args-common.mjs';
import {assertPngCaptureLooksOpaque} from './windows-image-inspection.mjs';

const scenarioFilterToken = process.argv.find(argument => argument.startsWith('--scenario='));
const scenarioFilterArg = scenarioFilterToken?.split('=')[1];
const validateOnly = process.argv.includes('--validate-only');
const companionMainBundleId = 'opapp.companion.main';
const companionChatBundleId = 'opapp.companion.chat';
const companionAgentWorkbenchSurfaceId = 'companion.agent-workbench';
const companionChatSurfaceId = 'companion.chat.main';
const llmChatDevSmokeUiStateRelativePath = path.join(
  'llm-chat',
  'dev-smoke-ui-state.json',
);
const verifyDevPreferencesPath = path.join(
  tempRoot,
  'opapp-windows-host.verify-dev.preferences.ini',
);
const opappUserDataRoot = path.join(
  process.env.LOCALAPPDATA || tempRoot,
  'OPApp',
);
const workspaceTargetPath = path.join(
  opappUserDataRoot,
  'agent-runtime',
  'workspace-target.json',
);
const companionStartupTargetPath = path.join(
  opappUserDataRoot,
  'startup',
  'companion-startup-target.json',
);

const readinessMarkers = [
  'Runtime=Metro',
  'InstanceLoaded failed=false',
  '[frontend-companion] mounted',
];

const hostCommandOutputPath = path.join(tempRoot, 'opapp-windows-host.verify-dev.command.log');
const defaultReadinessTimeoutMs = 120000;
const defaultSmokeTimeoutMs = 120000;
const readinessTimeoutMs = parsePositiveIntegerArg(
  process.argv,
  '--readiness-ms',
  defaultReadinessTimeoutMs,
);
const smokeTimeoutMs = parsePositiveIntegerArg(process.argv, '--smoke-ms', defaultSmokeTimeoutMs);

const foregroundWindowTitles = ['OpappWindowsHost', 'Opapp Tool', 'Opapp Settings'];

const defaultScenarios = [
  {
    name: 'view-shot-current-window',
    description:
      'Metro-backed auto-open view-shot lab runs captureRef/captureScreen smoke in the current window',
    smokeMarkers: [
      'InitialOpenSurface surface=companion.view-shot policy=tool presentation=current-window',
      '[frontend-companion] auto-open bundle=opapp.companion.main window=window.main surface=companion.view-shot presentation=current-window targetBundle=opapp.companion.main',
      '[frontend-companion] render bundle=opapp.companion.main window=window.main surface=companion.view-shot policy=tool',
      '[frontend-companion] mounted bundle=opapp.companion.main window=window.main surface=companion.view-shot policy=tool',
      '[frontend-companion] session bundle=opapp.companion.main window=window.main tabs=1 active=tab:companion.main:1 entries=tab:companion.main:1:companion.view-shot',
      '[frontend-view-shot] dev-smoke-start',
      '[frontend-view-shot] dev-smoke-capture-ref uri=',
      '[frontend-view-shot] dev-smoke-inspection-ref uri=',
      '[frontend-view-shot] dev-smoke-component-data-uri prefix=data:image/png;base64, length=',
      '[frontend-view-shot] dev-smoke-jpg-quality low=',
      '[frontend-view-shot] dev-smoke-capture-screen uri=',
      '[frontend-view-shot] dev-smoke-release-complete',
      '[frontend-view-shot] dev-smoke-complete',
    ],
    launchConfig: {
      initialOpen: {
        surface: 'companion.view-shot',
        policy: 'tool',
        presentation: 'current-window',
      },
      initialOpenProps: {
        'dev-smoke-scenario': 'view-shot-basics',
      },
    },
    async verifyLog(logContents) {
      assertLogContainsRegex(
        logContents,
        /\[frontend-view-shot\] dev-smoke-capture-ref uri=.*OPApp[\\/]+view-shot[\\/]+/i,
        'view-shot dev smoke did not produce a tmpfile captureRef artifact under the managed host directory.',
      );
      const inspectionCapturePath = extractLoggedPath(
        logContents,
        /\[frontend-view-shot\] dev-smoke-inspection-ref uri=([^\r\n]+)/i,
        'view-shot dev smoke did not produce an inspection tmpfile artifact under the managed host directory.',
      );
      try {
        const inspectionStats = assertPngCaptureLooksOpaque(
          inspectionCapturePath,
          'Windows dev verify view-shot inspection capture',
        );
        log(
          'verify-dev',
          `view-shot inspection OK: path=${inspectionCapturePath} opaqueSamples=${inspectionStats.opaqueSamples}/${inspectionStats.sampleCount} distinctSamples=${inspectionStats.distinctSampleCount} averageAlpha=${inspectionStats.averageAlpha}`,
        );
      } finally {
        await clearOptionalFile(inspectionCapturePath);
      }
      assertLogContainsRegex(
        logContents,
        /\[frontend-view-shot\] dev-smoke-component-data-uri prefix=data:image\/png;base64, length=\d+/i,
        'view-shot dev smoke did not produce a PNG data-uri from ViewShot.capture.',
      );
      const jpgQualityMatch = normalizeLogContents(logContents).match(
        /\[frontend-view-shot\] dev-smoke-jpg-quality low=(\d+) high=(\d+)/i,
      );
      if (!jpgQualityMatch) {
        throw new Error(
          'Windows dev verify failed: view-shot dev smoke did not emit the JPG quality summary marker.',
        );
      }
      const lowQualityLength = Number(jpgQualityMatch[1]);
      const highQualityLength = Number(jpgQualityMatch[2]);
      if (!Number.isFinite(lowQualityLength) || !Number.isFinite(highQualityLength)) {
        throw new Error(
          'Windows dev verify failed: view-shot dev smoke emitted an invalid JPG quality summary marker.',
        );
      }
      if (highQualityLength <= lowQualityLength) {
        throw new Error(
          'Windows dev verify failed: high-quality JPG capture was not larger than low-quality JPG capture.',
        );
      }
      assertLogContainsRegex(
        logContents,
        /\[frontend-view-shot\] dev-smoke-capture-screen uri=.*OPApp[\\/]+view-shot[\\/]+/i,
        'view-shot dev smoke did not produce a tmpfile captureScreen artifact under the managed host directory.',
      );
    },
    successSummary:
      'Metro-backed Windows host completed view-shot dev smoke.',
  },
  {
    name: 'window-capture-current-window',
    description:
      'Metro-backed auto-open window-capture lab runs foreground WGC smoke in the current window',
    smokeMarkers: [
      'InitialOpenSurface surface=companion.window-capture policy=tool presentation=current-window',
      '[frontend-companion] auto-open bundle=opapp.companion.main window=window.main surface=companion.window-capture presentation=current-window targetBundle=opapp.companion.main',
      '[frontend-companion] render bundle=opapp.companion.main window=window.main surface=companion.window-capture policy=tool',
      '[frontend-companion] mounted bundle=opapp.companion.main window=window.main surface=companion.window-capture policy=tool',
      '[frontend-companion] session bundle=opapp.companion.main window=window.main tabs=1 active=tab:companion.main:1 entries=tab:companion.main:1:companion.window-capture',
      '[frontend-window-capture] dev-smoke-start',
      '[frontend-window-capture] dev-smoke-list count=',
      '[frontend-window-capture] dev-smoke-capture-window backend=wgc size=',
      '[frontend-window-capture] dev-smoke-capture-client backend=wgc crop=',
      '[frontend-window-capture] dev-smoke-complete',
    ],
    launchConfig: {
      initialOpen: {
        surface: 'companion.window-capture',
        policy: 'tool',
        presentation: 'current-window',
      },
      initialOpenProps: {
        'dev-smoke-scenario': 'window-capture-basics',
      },
    },
    async verifyLog(logContents) {
      assertLogContainsRegex(
        logContents,
        /\[frontend-window-capture\] dev-smoke-list count=\d+ handle=0x[0-9a-f]+ process=/i,
        'window-capture dev smoke did not list a foreground window.',
      );
      assertLogContainsRegex(
        logContents,
        /\[frontend-window-capture\] dev-smoke-capture-window backend=wgc size=\d+x\d+ path=.*OPApp[\\/]+window-capture[\\/]+/i,
        'window-capture dev smoke did not produce a WGC window capture under the managed host directory.',
      );
      const windowCapturePath = extractLoggedPath(
        logContents,
        /\[frontend-window-capture\] dev-smoke-capture-window backend=wgc size=\d+x\d+ path=([^\r\n]+)/i,
        'window-capture dev smoke did not emit the window capture path.',
      );
      try {
        const inspectionStats = assertPngCaptureLooksOpaque(
          windowCapturePath,
          'Windows dev verify window-capture window capture',
        );
        log(
          'verify-dev',
          `window-capture window OK: path=${windowCapturePath} opaqueSamples=${inspectionStats.opaqueSamples}/${inspectionStats.sampleCount} distinctSamples=${inspectionStats.distinctSampleCount} averageAlpha=${inspectionStats.averageAlpha}`,
        );
      } finally {
        await clearOptionalFile(windowCapturePath);
      }
      assertLogContainsRegex(
        logContents,
        /\[frontend-window-capture\] dev-smoke-capture-client backend=wgc crop=\d+x\d+ path=.*OPApp[\\/]+window-capture[\\/]+/i,
        'window-capture dev smoke did not produce a WGC client capture under the managed host directory.',
      );
      const clientCapturePath = extractLoggedPath(
        logContents,
        /\[frontend-window-capture\] dev-smoke-capture-client backend=wgc crop=\d+x\d+ path=([^\r\n]+)/i,
        'window-capture dev smoke did not emit the client capture path.',
      );
      try {
        const inspectionStats = assertPngCaptureLooksOpaque(
          clientCapturePath,
          'Windows dev verify window-capture client capture',
        );
        log(
          'verify-dev',
          `window-capture client OK: path=${clientCapturePath} opaqueSamples=${inspectionStats.opaqueSamples}/${inspectionStats.sampleCount} distinctSamples=${inspectionStats.distinctSampleCount} averageAlpha=${inspectionStats.averageAlpha}`,
        );
      } finally {
        await clearOptionalFile(clientCapturePath);
      }
    },
    successSummary:
      'Metro-backed Windows host completed window-capture dev smoke.',
  },
  {
    name: 'companion-agent-workbench-current-window',
    description:
      'Metro-backed Windows host launches the agent workbench surface directly into the main window and exercises the workspace/diff smoke path',
    smokeMarkers: [
      `LaunchSurface surface=${companionAgentWorkbenchSurfaceId} policy=main mode=`,
      `[frontend-companion] render bundle=${companionMainBundleId} window=window.main surface=${companionAgentWorkbenchSurfaceId} policy=main`,
      `[frontend-companion] mounted bundle=${companionMainBundleId} window=window.main surface=${companionAgentWorkbenchSurfaceId} policy=main`,
      `[frontend-companion] session bundle=${companionMainBundleId} window=window.main tabs=1 active=tab:${companionAgentWorkbenchSurfaceId}:1 entries=tab:${companionAgentWorkbenchSurfaceId}:1:${companionAgentWorkbenchSurfaceId}`,
      '[frontend-agent-workbench] dev-smoke-start',
      '[frontend-agent-workbench] dev-smoke-workspace cwd=opapp-frontend entries=',
      '[frontend-agent-workbench] dev-smoke-diff-ready path=opapp-frontend/',
      '[frontend-agent-workbench] dev-smoke-complete',
    ],
    async prepareState() {
      return await prepareAgentWorkbenchSmokeState();
    },
    launchConfig: {
      preferences: {
        path: verifyDevPreferencesPath,
      },
      main: {
        surface: companionAgentWorkbenchSurfaceId,
        policy: 'main',
      },
      mainProps: {
        'dev-smoke-scenario': 'agent-workbench-basics',
      },
    },
    async cleanupState(state) {
      await cleanupAgentWorkbenchSmokeState(state);
    },
    async verifyLog(logContents) {
      assertCompanionAgentWorkbenchCurrentWindowStayedOnSurface(
        logContents,
        'agent workbench dev smoke',
      );
      assertLogDoesNotContain(
        logContents,
        '[frontend-agent-workbench] dev-smoke-failed',
        'agent workbench dev smoke logged a dev-smoke failure marker.',
      );
      assertLogContainsRegex(
        logContents,
        /\[frontend-agent-workbench\] dev-smoke-workspace cwd=opapp-frontend entries=\d+ trusted=true/i,
        'agent workbench dev smoke did not confirm the trusted opapp-frontend workspace listing.',
      );
      assertLogContainsRegex(
        logContents,
        /\[frontend-agent-workbench\] dev-smoke-diff-ready path=opapp-frontend\/[^\r\n]+ cwd=opapp-frontend/i,
        'agent workbench dev smoke did not confirm a repo-root git diff candidate.',
      );
    },
    successSummary:
      'Metro-backed Windows host completed direct agent-workbench startup smoke.',
  },
  {
    name: 'companion-chat-current-window',
    description:
      'Metro-backed Windows host launches the chat child bundle directly into the main window',
    smokeMarkers: [
      'Runtime=Metro entryFile=index.chat',
      `LaunchSurface surface=${companionChatSurfaceId} policy=main mode=`,
      `[frontend-companion] render bundle=${companionChatBundleId} window=window.main surface=${companionChatSurfaceId} policy=main`,
      `[frontend-companion] mounted bundle=${companionChatBundleId} window=window.main surface=${companionChatSurfaceId} policy=main`,
      '[frontend-llm-chat] dev-smoke-start',
      '[frontend-llm-chat] dev-smoke-open',
      '[frontend-llm-chat] dev-smoke-assistant-text text=CHAT_TEST_OK',
      '[frontend-llm-chat] dev-smoke-complete',
    ],
    async prepareState() {
      return await prepareCompanionChatSmokeState();
    },
    buildLaunchConfig(state) {
      return {
        main: {
          surface: companionChatSurfaceId,
          policy: 'main',
          'entry-file': 'index.chat',
        },
        mainProps: {
          'dev-smoke-scenario': state?.scenario ?? 'llm-chat-native-sse',
          'dev-smoke-base-url': state?.baseUrl ?? '',
        },
      };
    },
    async cleanupState(state) {
      await cleanupCompanionChatSmokeState(state);
    },
    async verifyLog(logContents, state) {
      assertCompanionChatCurrentWindowStayedOnChildBundle(
        logContents,
        'companion chat dev smoke',
      );
      assertLogDoesNotContain(
        logContents,
        '[frontend-llm-chat] dev-smoke-failed',
        'companion chat dev smoke logged a dev-smoke failure marker.',
      );
      assertCompanionChatSmokeRequestCaptured(state, 'companion chat dev smoke');
    },
    successSummary:
      'Metro-backed Windows host completed direct chat child-bundle startup smoke.',
  },
];

const optionalScenarios = [
  {
    name: 'companion-chat-current-window-server-error',
    description:
      'Metro-backed Windows host surfaces an expected native SSE HTTP error from the chat child bundle in the main window',
    smokeMarkers: [
      'Runtime=Metro entryFile=index.chat',
      `LaunchSurface surface=${companionChatSurfaceId} policy=main mode=`,
      `[frontend-companion] render bundle=${companionChatBundleId} window=window.main surface=${companionChatSurfaceId} policy=main`,
      `[frontend-companion] mounted bundle=${companionChatBundleId} window=window.main surface=${companionChatSurfaceId} policy=main`,
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
    buildLaunchConfig(state) {
      return {
        main: {
          surface: companionChatSurfaceId,
          policy: 'main',
          'entry-file': 'index.chat',
        },
        mainProps: {
          'dev-smoke-scenario': state?.scenario ?? 'llm-chat-native-sse-server-error',
          'dev-smoke-base-url': state?.baseUrl ?? '',
        },
      };
    },
    async cleanupState(state) {
      await cleanupCompanionChatSmokeState(state);
    },
    async verifyLog(logContents, state) {
      assertCompanionChatCurrentWindowStayedOnChildBundle(
        logContents,
        'companion chat server-error dev smoke',
      );
      assertLogDoesNotContain(
        logContents,
        '[frontend-llm-chat] dev-smoke-failed',
        'companion chat server-error dev smoke logged an unexpected failure marker.',
      );
      assertLogDoesNotContain(
        logContents,
        '[frontend-llm-chat] dev-smoke-open',
        'companion chat server-error dev smoke unexpectedly accepted an HTTP error response as an open SSE stream.',
      );
      assertCompanionChatSmokeRequestCaptured(
        state,
        'companion chat server-error dev smoke',
      );
      await assertCompanionChatSmokeErrorUiState(
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
      'Runtime=Metro entryFile=index.chat',
      `LaunchSurface surface=${companionChatSurfaceId} policy=main mode=`,
      `[frontend-companion] render bundle=${companionChatBundleId} window=window.main surface=${companionChatSurfaceId} policy=main`,
      `[frontend-companion] mounted bundle=${companionChatBundleId} window=window.main surface=${companionChatSurfaceId} policy=main`,
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
    buildLaunchConfig(state) {
      return {
        main: {
          surface: companionChatSurfaceId,
          policy: 'main',
          'entry-file': 'index.chat',
        },
        mainProps: {
          'dev-smoke-scenario':
            state?.scenario ?? 'llm-chat-native-sse-malformed-chunk',
          'dev-smoke-base-url': state?.baseUrl ?? '',
        },
      };
    },
    async cleanupState(state) {
      await cleanupCompanionChatSmokeState(state);
    },
    async verifyLog(logContents, state) {
      assertCompanionChatCurrentWindowStayedOnChildBundle(
        logContents,
        'companion chat malformed-chunk dev smoke',
      );
      assertLogDoesNotContain(
        logContents,
        '[frontend-llm-chat] dev-smoke-failed',
        'companion chat malformed-chunk dev smoke logged an unexpected failure marker.',
      );
      assertCompanionChatSmokeRequestCaptured(
        state,
        'companion chat malformed-chunk dev smoke',
      );
      await assertCompanionChatSmokeErrorUiState(
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
      'Runtime=Metro entryFile=index.chat',
      `LaunchSurface surface=${companionChatSurfaceId} policy=main mode=`,
      `[frontend-companion] render bundle=${companionChatBundleId} window=window.main surface=${companionChatSurfaceId} policy=main`,
      `[frontend-companion] mounted bundle=${companionChatBundleId} window=window.main surface=${companionChatSurfaceId} policy=main`,
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
    buildLaunchConfig(state) {
      return {
        main: {
          surface: companionChatSurfaceId,
          policy: 'main',
          'entry-file': 'index.chat',
        },
        mainProps: {
          'dev-smoke-scenario': state?.scenario ?? 'llm-chat-native-sse-stream-abort',
          'dev-smoke-base-url': state?.baseUrl ?? '',
        },
      };
    },
    async cleanupState(state) {
      await cleanupCompanionChatSmokeState(state);
    },
    async verifyLog(logContents, state) {
      assertCompanionChatCurrentWindowStayedOnChildBundle(
        logContents,
        'companion chat stream-abort dev smoke',
      );
      assertLogDoesNotContain(
        logContents,
        '[frontend-llm-chat] dev-smoke-failed',
        'companion chat stream-abort dev smoke logged an unexpected failure marker.',
      );
      assertCompanionChatSmokeRequestCaptured(
        state,
        'companion chat stream-abort dev smoke',
      );
      await assertCompanionChatSmokeErrorUiState(
        state,
        'companion chat stream-abort dev smoke',
      );
    },
    successSummary:
      'Metro-backed Windows host completed direct chat child-bundle stream-abort smoke.',
  },
];

const allScenarios = [...defaultScenarios, ...optionalScenarios];
const scenarioByName = new Map(allScenarios.map(scenario => [scenario.name, scenario]));

function normalizeLogContents(logContents) {
  return logContents.replace(/\r/g, '');
}

function assertLogContainsRegex(logContents, regex, reason) {
  if (!regex.test(normalizeLogContents(logContents))) {
    throw new Error(`Windows dev verify failed: ${reason}`);
  }
}

function assertLogDoesNotContain(logContents, marker, reason) {
  if (normalizeLogContents(logContents).includes(marker)) {
    throw new Error(`Windows dev verify failed: ${reason}`);
  }
}

function extractLoggedPath(logContents, regex, reason) {
  const match = normalizeLogContents(logContents).match(regex);
  if (!match?.[1]) {
    throw new Error(`Windows dev verify failed: ${reason}`);
  }

  return match[1].trim();
}

function assertCompanionChatCurrentWindowStayedOnChildBundle(
  logContents,
  failureLabel,
) {
  assertLogContainsRegex(
    logContents,
    /\[frontend-companion\] session bundle=opapp\.companion\.chat window=window\.main tabs=1 active=tab:companion\.chat\.main:1 entries=tab:companion\.chat\.main:1:companion\.chat\.main/i,
    `${failureLabel} did not persist the chat child bundle session in the main window.`,
  );
  if (
    normalizeLogContents(logContents).includes(
      '[frontend-companion] render bundle=opapp.companion.main window=window.main surface=companion.main policy=main',
    )
  ) {
    throw new Error(
      `Windows dev verify failed: ${failureLabel} still rendered the main companion bundle instead of launching the chat child bundle directly.`,
    );
  }
}

function assertCompanionAgentWorkbenchCurrentWindowStayedOnSurface(
  logContents,
  failureLabel,
) {
  assertLogContainsRegex(
    logContents,
    /\[frontend-companion\] session bundle=opapp\.companion\.main window=window\.main tabs=1 active=tab:companion\.agent-workbench:1 entries=tab:companion\.agent-workbench:1:companion\.agent-workbench/i,
    `${failureLabel} did not keep the agent workbench session active in the main window.`,
  );
  if (
    normalizeLogContents(logContents).includes(
      '[frontend-companion] render bundle=opapp.companion.main window=window.main surface=companion.main policy=main',
    )
  ) {
    throw new Error(
      `Windows dev verify failed: ${failureLabel} still rendered the launcher surface instead of launching the agent workbench directly.`,
    );
  }
}

async function prepareAgentWorkbenchSmokeState() {
  const legacyStartupTargetContent = await readOptionalFile(
    companionStartupTargetPath,
  );
  const workspaceTargetContent = await readOptionalFile(workspaceTargetPath);

  await mkdir(path.dirname(workspaceTargetPath), {recursive: true});
  await writeFile(
    workspaceTargetPath,
    JSON.stringify({
      rootPath: workspaceRoot,
      displayName: path.basename(workspaceRoot),
      trusted: true,
    }),
    'utf8',
  );
  await clearOptionalFile(companionStartupTargetPath);

  return {
    legacyStartupTargetContent,
    workspaceTargetContent,
  };
}

async function cleanupAgentWorkbenchSmokeState(state) {
  if (typeof state?.workspaceTargetContent === 'string') {
    await mkdir(path.dirname(workspaceTargetPath), {recursive: true});
    await writeFile(
      workspaceTargetPath,
      state.workspaceTargetContent,
      'utf8',
    );
  } else {
    await clearOptionalFile(workspaceTargetPath);
  }

  if (typeof state?.legacyStartupTargetContent === 'string') {
    await mkdir(path.dirname(companionStartupTargetPath), {recursive: true});
    await writeFile(
      companionStartupTargetPath,
      state.legacyStartupTargetContent,
      'utf8',
    );
    return;
  }

  await clearOptionalFile(companionStartupTargetPath);
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

async function prepareCompanionChatSmokeState(options = {}) {
  await clearCompanionChatSmokeUiArtifacts();
  return await startCompanionChatSmokeServer(options);
}

async function cleanupCompanionChatSmokeState(state) {
  await state?.close?.();
  await clearCompanionChatSmokeUiArtifacts();
}

async function assertCompanionChatSmokeErrorUiState(state, failureLabel) {
  const uiStatePaths = await resolveCompanionChatSmokeUiStatePaths();
  let fileContent = null;
  let resolvedPath = null;
  for (const candidatePath of uiStatePaths) {
    try {
      fileContent = await readFile(candidatePath, 'utf8');
      resolvedPath = candidatePath;
      break;
    } catch {
      // Try the next known user-data root.
    }
  }

  if (!fileContent || !resolvedPath) {
    throw new Error(
      `Windows dev verify failed: ${failureLabel} did not persist the rendered error UI state to any known OPApp user-data root.`,
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(fileContent);
  } catch {
    throw new Error(
      `Windows dev verify failed: ${failureLabel} persisted an unreadable error UI state artifact at ${resolvedPath}.`,
    );
  }

  if (parsed?.scenario !== state?.scenario) {
    throw new Error(
      `Windows dev verify failed: ${failureLabel} persisted an error UI state for '${parsed?.scenario ?? '<unknown>'}' instead of '${state?.scenario ?? '<unknown>'}'.`,
    );
  }

  if (parsed?.state !== 'error') {
    throw new Error(
      `Windows dev verify failed: ${failureLabel} persisted UI state '${parsed?.state ?? '<unknown>'}' instead of 'error'.`,
    );
  }

  if (parsed?.errorMessage !== state?.expectedErrorText) {
    throw new Error(
      `Windows dev verify failed: ${failureLabel} persisted error UI text '${parsed?.errorMessage ?? '<missing>'}' instead of '${state?.expectedErrorText ?? '<missing>'}' at ${resolvedPath}.`,
    );
  }
}

async function resolveCompanionChatSmokeUiStatePaths() {
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

async function clearCompanionChatSmokeUiArtifacts() {
  const uiStatePaths = await resolveCompanionChatSmokeUiStatePaths();
  for (const candidatePath of uiStatePaths) {
    await clearOptionalFile(candidatePath);
  }
}

function escapePowerShellSingleQuotedString(value) {
  return String(value).replace(/'/g, "''");
}

function tryPromoteOpappWindowToForeground({
  windowTitles = foregroundWindowTitles,
  timeoutMs = 5000,
  retryDelayMs = 200,
} = {}) {
  const titleList = windowTitles
    .map(title => `'${escapePowerShellSingleQuotedString(title)}'`)
    .join(', ');
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class OpappVerifyForegroundNative {
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int command);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint gaFlags);
}
"@

$titles = @(${titleList})
$deadline = [DateTime]::UtcNow.AddMilliseconds(${timeoutMs})

while ([DateTime]::UtcNow -lt $deadline) {
  $candidate = Get-Process -Name 'OpappWindowsHost' -ErrorAction SilentlyContinue |
    Where-Object {
      $_.MainWindowHandle -ne 0 -and
      -not [string]::IsNullOrWhiteSpace($_.MainWindowTitle) -and
      $titles -contains $_.MainWindowTitle
    } |
    Select-Object -First 1

  if ($candidate) {
    $handle = [IntPtr]$candidate.MainWindowHandle
    [void][OpappVerifyForegroundNative]::ShowWindowAsync($handle, 9)
    [void][OpappVerifyForegroundNative]::BringWindowToTop($handle)
    [void][OpappVerifyForegroundNative]::SetForegroundWindow($handle)
    Start-Sleep -Milliseconds 120

    $foregroundHandle = [OpappVerifyForegroundNative]::GetAncestor([OpappVerifyForegroundNative]::GetForegroundWindow(), 2)
    $targetHandle = [OpappVerifyForegroundNative]::GetAncestor($handle, 2)
    if ([int64]$foregroundHandle -eq [int64]$targetHandle) {
      Write-Output ("focused:" + $candidate.MainWindowTitle)
      exit 0
    }
  }

  Start-Sleep -Milliseconds ${retryDelayMs}
}

exit 1
`;

  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
    {
      encoding: 'utf8',
      windowsHide: true,
    },
  );
  const stdout = (result.stdout ?? '').trim();
  const stderr = (result.stderr ?? '').trim();
  return {
    ok: result.status === 0,
    stdout,
    stderr,
  };
}

function parseScenarioFilterNames(rawValue) {
  if (!rawValue) {
    return [];
  }

  return rawValue
    .split(',')
    .map(name => name.trim())
    .filter(Boolean);
}

function resolveScenariosOrThrow() {
  const scenarioFilterNames = parseScenarioFilterNames(scenarioFilterArg);
  if (scenarioFilterToken && scenarioFilterNames.length === 0) {
    throw new Error('`--scenario=` must include at least one scenario name.');
  }

  if (scenarioFilterNames.length === 0) {
    return defaultScenarios;
  }

  const knownScenarioNames = [...scenarioByName.keys()].join(', ');
  const selectedScenarios = [];
  const seen = new Set();
  for (const scenarioName of scenarioFilterNames) {
    const scenario = scenarioByName.get(scenarioName);
    if (!scenario) {
      throw new Error(
        `Unknown --scenario=${scenarioName}. Supported scenarios: ${knownScenarioNames}`,
      );
    }
    if (seen.has(scenarioName)) {
      continue;
    }
    seen.add(scenarioName);
    selectedScenarios.push(scenario);
  }

  return selectedScenarios;
}

function appendConfigSection(content, name, values) {
  if (!values || Object.keys(values).length === 0) {
    return content;
  }

  let nextContent = `${content}\n[${name}]\n`;
  for (const [key, value] of Object.entries(values)) {
    nextContent += `${key}=${value}\n`;
  }
  return nextContent;
}

function buildLaunchConfigForScenario(launchConfig) {
  let content = `[sessions]\npath=${devSessionsPath}\n`;
  content = appendConfigSection(content, 'preferences', launchConfig.preferences);
  content = appendConfigSection(content, 'main', launchConfig.main);
  content = appendConfigSection(content, 'main-props', launchConfig.mainProps);
  content = appendConfigSection(content, 'initial-open', launchConfig.initialOpen);
  content = appendConfigSection(
    content,
    'initial-open-props',
    launchConfig.initialOpenProps,
  );
  return content;
}

function resolveScenarioLaunchConfig(scenario, scenarioState) {
  if (typeof scenario.buildLaunchConfig === 'function') {
    return scenario.buildLaunchConfig(scenarioState);
  }

  return scenario.launchConfig;
}

function describeHostWaitFailure(result, phase, hostChild, timeoutMs = defaultReadinessTimeoutMs) {
  const spawnModeDetail = hostChild?.opappSpawnMode
    ? ` Host spawn mode: ${hostChild.opappSpawnMode}.`
    : '';
  if (result.status === 'external-failure') {
    const code = result.externalFailure?.code ?? 'unknown';
    const summary = result.externalFailure?.summary ?? 'external fail-fast trigger';
    const commandOutputPath = result.externalFailure?.commandOutputPath
      ? ` command log=${result.externalFailure.commandOutputPath}.`
      : '';
    return (
      `Windows dev verify detected deterministic command failure while waiting for ${phase}: ` +
      `${code} (${summary}). Aborting early instead of waiting ${timeoutMs}ms.` +
      `${spawnModeDetail}${commandOutputPath}`
    );
  }

  if (result.status === 'fatal-frontend-error') {
    const detail = `${result.fatalDiagnostic.event}: ${result.fatalDiagnostic.message}`;
    return `Windows dev verify hit a frontend exception while waiting for ${phase}. ${detail}${spawnModeDetail}`;
  }

  return `Windows dev verify timed out waiting for ${phase} within ${timeoutMs}ms.${spawnModeDetail}`;
}

async function clearOptionalFile(targetPath) {
  try {
    await unlink(targetPath);
  } catch {
    // ignore
  }
}

async function readOptionalFile(targetPath) {
  try {
    return await readFile(targetPath, 'utf8');
  } catch {
    return null;
  }
}

async function buildHostWaitFailureMessage(
  result,
  phase,
  hostChild,
  {hostTailLines = 80, commandTailLines = 80, timeoutMs = defaultReadinessTimeoutMs} = {},
) {
  const hostTail = await readHostLogTail(hostTailLines);
  const activeCommandOutputPath = resolveHostCommandOutputPath(hostChild, hostCommandOutputPath);
  const commandTail = await readFileTail(activeCommandOutputPath, commandTailLines);
  let detail = describeHostWaitFailure(result, phase, hostChild, timeoutMs);
  if (hostTail) {
    detail += `\n${hostTail}`;
  }
  detail += formatHostCommandTailDetails(hostChild, {activeCommandOutputPath, commandTail});

  return detail;
}

async function prepareScenarioRun(scenario, scenarioState) {
  log('verify-dev', `preparing scenario '${scenario.name}'`);
  stopHostProcesses();
  clearDevSessions();
  clearHostLaunchConfig();
  clearHostLog();
  await clearOptionalFile(hostCommandOutputPath);
  await clearOptionalFile(verifyDevPreferencesPath);
  await writeHostLaunchConfig(
    buildLaunchConfigForScenario(
      resolveScenarioLaunchConfig(scenario, scenarioState),
    ),
  );
}

async function runDevScenario(scenario) {
  let scenarioState = null;
  let hostChild = null;
  const scenarioStartMs = Date.now();

  try {
    if (scenario.prepareState) {
      scenarioState = await scenario.prepareState();
    }

    await prepareScenarioRun(scenario, scenarioState);

    log(
      'verify-dev',
      `launching Windows host against Metro-backed bundle for scenario '${scenario.name}'`,
    );
    hostChild = await spawnCmdAsync('npm run windows', {
      cwd: hostRoot,
      env: process.env,
      label: 'host',
      outputCapturePath: hostCommandOutputPath,
    });
    if (hostChild?.opappSpawnMode) {
      log('verify-dev', `Host spawn mode: ${hostChild.opappSpawnMode}`);
    }

    const ready = await waitForHostLogMarkers(readinessMarkers, readinessTimeoutMs, {
      failFastOnFatalFrontendError: true,
      failFastCheck: () =>
        detectDeterministicCommandFailureFromHost(hostChild, {
          fallbackOutputPath: hostCommandOutputPath,
        }),
    });
    if (ready.status !== 'matched') {
      throw new Error(
        await buildHostWaitFailureMessage(
          ready,
          `Metro-backed host readiness for scenario '${scenario.name}'`,
          hostChild,
          {
            hostTailLines: 80,
            commandTailLines: 120,
            timeoutMs: readinessTimeoutMs,
          },
        ),
      );
    }

    const foregroundResult = tryPromoteOpappWindowToForeground();
    if (foregroundResult.ok) {
      log(
        'verify-dev',
        `Foreground assist confirmed for scenario '${scenario.name}': ${foregroundResult.stdout || 'focused'}`,
      );
    } else {
      log(
        'verify-dev',
        `Foreground assist could not confirm focus for scenario '${scenario.name}'. stdout=${foregroundResult.stdout || '<empty>'} stderr=${foregroundResult.stderr || '<empty>'}`,
      );
    }

    const smokeReady = await waitForHostLogMarkers(scenario.smokeMarkers, smokeTimeoutMs, {
      failFastOnFatalFrontendError: true,
      failFastCheck: () =>
        detectDeterministicCommandFailureFromHost(hostChild, {
          fallbackOutputPath: hostCommandOutputPath,
        }),
    });
    if (smokeReady.status !== 'matched') {
      throw new Error(
        await buildHostWaitFailureMessage(
          smokeReady,
          `scenario '${scenario.name}' completion`,
          hostChild,
          {
            hostTailLines: 120,
            commandTailLines: 160,
            timeoutMs: smokeTimeoutMs,
          },
        ),
      );
    }

    const durationMs = Date.now() - scenarioStartMs;
    const logContents = await readFile(hostLogPath, 'utf8');
    await scenario.verifyLog?.(logContents, scenarioState);
    log(
      'verify-dev',
      `Scenario '${scenario.name}' completed successfully in ${durationMs}ms.`,
    );
    const tail = normalizeLogContents(logContents)
      .split('\n')
      .filter(Boolean)
      .slice(-60)
      .join('\n');
    if (tail) {
      log('verify-dev', 'Recent host log tail:');
      console.log(tail);
    }
    log('verify-dev', scenario.successSummary);

    return durationMs;
  } finally {
    clearDevSessions();
    clearHostLaunchConfig();
    stopHostProcesses();
    if (hostChild?.pid) {
      killProcessTree(hostChild.pid);
    }
    await scenario.cleanupState?.(scenarioState);
  }
}

async function main() {
  const scenarios = resolveScenariosOrThrow();

  ensureWorkspaceTemp();
  clearDevSessions();
  clearHostLaunchConfig();
  clearHostLog();
  await clearOptionalFile(hostCommandOutputPath);
  await clearOptionalFile(verifyDevPreferencesPath);
  stopHostProcesses();

  log('verify-dev', `hostRoot=${hostRoot}`);
  log('verify-dev', `scenarioFilterName=${scenarioFilterArg ?? '<all>'}`);
  log('verify-dev', `scenarioCount=${scenarios.length}`);
  log('verify-dev', `validateOnly=${validateOnly}`);
  log('verify-dev', `readinessTimeoutMs=${readinessTimeoutMs}`);
  log('verify-dev', `smokeTimeoutMs=${smokeTimeoutMs}`);

  if (validateOnly) {
    log('verify-dev', 'validate-only enabled; skipping Metro and host execution.');
    return;
  }

  let metroChild = null;

  try {
    const metro = await ensureMetroRunning({reuseIfReady: true, label: 'metro'});
    metroChild = metro.child;
    log('verify-dev', `Metro startup outcome: ${describeMetroOutcome(metro)}`);
    if (metroChild?.opappSpawnMode) {
      log('verify-dev', `Metro spawn mode: ${metroChild.opappSpawnMode}`);
    }

    const scenarioTimings = [];
    for (const scenario of scenarios) {
      const durationMs = await runDevScenario(scenario);
      scenarioTimings.push({name: scenario.name, durationMs});
    }

    const totalDurationMs = scenarioTimings.reduce(
      (sum, item) => sum + item.durationMs,
      0,
    );
    log(
      'verify-dev',
      `scenario timing summary totalMs=${totalDurationMs} scenarioCount=${scenarioTimings.length}`,
    );
  } finally {
    clearDevSessions();
    clearHostLaunchConfig();
    stopHostProcesses();
    if (metroChild?.pid) {
      killProcessTree(metroChild.pid);
    }
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
