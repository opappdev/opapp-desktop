import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');
const workspaceRoot = path.resolve(repoRoot, '..');
const frontendRoot = path.join(workspaceRoot, 'opapp-frontend');
const windowPolicyRegistryPath = path.join(
  frontendRoot,
  'contracts',
  'windowing',
  'src',
  'window-policy-registry.json',
);

const windows = {
  main: {
    title: 'OpappWindowsHost',
  },
  settings: {
    className: 'OPAPP_SURFACE_WINDOW',
  },
  tool: {
    title: 'Opapp Tool',
  },
};

let windowPolicyRegistryPromise = null;
const defaultLocatorTimeoutMs = 22_500;
const defaultStepTimeoutMs = 5_000;
const defaultChatResponseTimeoutMs = 15_000;
const defaultCaptureResultTimeoutMs = 10_000;

function byAutomationId(automationId, extra = {}) {
  return {
    automationId,
    ...extra,
  };
}

function byName(name, extra = {}) {
  return {
    name,
    ...extra,
  };
}

const bundleLauncherReadyLocator = byAutomationId(
  'bundle-launcher.action.check-updates',
);
const bundleLauncherLegacyReadyLocator = byName('打开', {
  controlType: 'Button',
});
const bundleLauncherReadyTimeoutMs = 35_000;

function waitForLocator(window, locator, timeoutMs = defaultLocatorTimeoutMs) {
  return [
    {
      type: 'waitWindow',
      window,
      focus: true,
      timeoutMs,
    },
    {
      type: 'waitElement',
      window,
      locator,
      timeoutMs,
    },
  ];
}

function waitForAnyLocator(
  window,
  locators,
  timeoutMs = defaultLocatorTimeoutMs,
) {
  return [
    {
      type: 'waitWindow',
      window,
      focus: true,
      timeoutMs,
    },
    {
      type: 'waitAnyElement',
      window,
      locators,
      timeoutMs,
    },
  ];
}

function waitForElementState({
  window,
  locator,
  matcher,
  timeoutMs = defaultLocatorTimeoutMs,
  saveAs = null,
}) {
  return {
    type: 'waitElementState',
    window,
    locator,
    matcher,
    timeoutMs,
    ...(saveAs ? {saveAs} : {}),
  };
}

function sendKeys({
  window,
  keys,
  timeoutMs = defaultStepTimeoutMs,
  delayMs = 200,
  label = null,
}) {
  return {
    type: 'sendKeys',
    window,
    keys,
    timeoutMs,
    delayMs,
    ...(label ? {label} : {}),
  };
}

async function getWindowGeometry(policyId, mode) {
  if (!windowPolicyRegistryPromise) {
    windowPolicyRegistryPromise = readFile(windowPolicyRegistryPath, 'utf8').then(
      content => JSON.parse(content),
    );
  }

  const registry = await windowPolicyRegistryPromise;
  const geometry = registry?.[policyId]?.geometry?.[mode];
  if (!geometry) {
    throw new Error(
      `Missing window geometry for policy '${policyId}' mode '${mode}'.`,
    );
  }

  return geometry;
}

export async function createWindowRectPolicyStep({
  window,
  policyId,
  mode,
  timeoutMs = defaultLocatorTimeoutMs,
  saveAs = null,
}) {
  const geometry = await getWindowGeometry(policyId, mode);

  return {
    type: 'assertWindowRectPolicy',
    window,
    geometry,
    timeoutMs,
    ...(saveAs ? {saveAs} : {}),
  };
}

export async function createBundleLauncherRootSpec({
  window = windows.main,
  policyId = 'main',
  mode = 'wide',
}) {
  return {
    name: 'bundle-launcher-root',
    defaultTimeoutMs: defaultStepTimeoutMs,
    steps: [
      ...waitForAnyLocator(
        window,
        [bundleLauncherReadyLocator, bundleLauncherLegacyReadyLocator],
        bundleLauncherReadyTimeoutMs,
      ),
      await createWindowRectPolicyStep({window, policyId, mode}),
    ],
  };
}

export async function createSettingsRootSpec({
  window = windows.main,
  policyId = 'main',
  mode = 'wide',
}) {
  return {
    name: 'settings-root',
    defaultTimeoutMs: defaultStepTimeoutMs,
    steps: [
      ...waitForLocator(window, byAutomationId('settings.action.save-preferences')),
      await createWindowRectPolicyStep({window, policyId, mode}),
    ],
  };
}

export async function createMainAndDetachedSettingsSpec({
  mainMode = 'wide',
  settingsMode = 'compact',
}) {
  return {
    name: 'main-and-detached-settings',
    defaultTimeoutMs: defaultStepTimeoutMs,
    steps: [
      ...waitForAnyLocator(
        windows.main,
        [bundleLauncherReadyLocator, bundleLauncherLegacyReadyLocator],
        bundleLauncherReadyTimeoutMs,
      ),
      await createWindowRectPolicyStep({
        window: windows.main,
        policyId: 'main',
        mode: mainMode,
      }),
      ...waitForLocator(
        windows.settings,
        byAutomationId('settings.action.save-preferences'),
      ),
      await createWindowRectPolicyStep({
        window: windows.settings,
        policyId: 'settings',
        mode: settingsMode,
      }),
    ],
  };
}

export async function createSaveMainWindowPreferencesSpec() {
  return {
    name: 'save-main-window-preferences',
    defaultTimeoutMs: defaultStepTimeoutMs,
    steps: [
      ...waitForLocator(
        windows.main,
        byAutomationId('settings.action.save-preferences'),
      ),
      {
        type: 'click',
        window: windows.main,
        locator: byAutomationId('settings.main-window-mode.compact'),
      },
      waitForElementState({
        window: windows.main,
        locator: byAutomationId('settings.main-window-mode.compact'),
        matcher: {
          selected: true,
        },
      }),
      waitForElementState({
        window: windows.main,
        locator: byAutomationId('settings.action.save-preferences'),
        matcher: {
          enabled: true,
        },
      }),
      {
        type: 'click',
        window: windows.main,
        locator: byAutomationId('settings.action.save-preferences'),
      },
      {
        type: 'waitText',
        window: windows.main,
        locator: byAutomationId('settings.save-notice'),
        matcher: {
          minLength: 4,
        },
        saveAs: 'saveNotice',
      },
      await createWindowRectPolicyStep({
        window: windows.main,
        policyId: 'main',
        mode: 'compact',
        saveAs: 'mainWindowRect',
      }),
    ],
  };
}

export async function createViewShotLabSpec({
  window = windows.main,
  policyId = 'main',
  mode = 'wide',
  includeTmpfileRelease = false,
}) {
  return {
    name: 'view-shot-lab',
    defaultTimeoutMs: defaultStepTimeoutMs,
    steps: [
      ...waitForLocator(window, byAutomationId('view-shot.action.capture-ref')),
      await createWindowRectPolicyStep({window, policyId, mode}),
      {
        type: 'click',
        window,
        locator: byAutomationId('view-shot.action.capture-ref'),
      },
      {
        type: 'waitText',
        window,
        locator: byAutomationId('view-shot.result.managed-tmpfile'),
        matcher: {
          regex: '^[A-Za-z]:\\\\.+',
        },
        timeoutMs: defaultCaptureResultTimeoutMs,
        saveAs: 'captureRefPath',
      },
      {
        type: 'click',
        window,
        locator: byAutomationId('view-shot.action.capture-data-uri'),
      },
      {
        type: 'waitText',
        window,
        locator: byAutomationId('view-shot.result.latest-result'),
        matcher: {
          regex: '^data:image/png;base64,',
          minLength: 48,
        },
        timeoutMs: defaultCaptureResultTimeoutMs,
        saveAs: 'componentDataUri',
      },
      {
        type: 'click',
        window,
        locator: byAutomationId('view-shot.action.capture-screen'),
      },
      {
        type: 'waitText',
        window,
        locator: byAutomationId('view-shot.result.latest-result'),
        matcher: {
          regex: '^[A-Za-z]:\\\\.+',
        },
        timeoutMs: defaultCaptureResultTimeoutMs,
        saveAs: 'captureScreenPath',
      },
      ...(includeTmpfileRelease
        ? [
            {
              type: 'click',
              window,
              locator: byAutomationId('view-shot.action.release-tmpfile'),
            },
            {
              type: 'waitText',
              window,
              locator: byAutomationId('view-shot.result.managed-tmpfile'),
              matcher: {
                notRegex: '^[A-Za-z]:\\\\.+',
              },
              timeoutMs: defaultCaptureResultTimeoutMs,
            },
          ]
        : []),
    ],
  };
}

export async function createViewShotCaptureRefSpec({
  window = windows.main,
  policyId = 'main',
  mode = 'wide',
}) {
  return {
    name: 'view-shot-capture-ref',
    defaultTimeoutMs: defaultStepTimeoutMs,
    steps: [
      ...waitForLocator(window, byAutomationId('view-shot.action.capture-ref')),
      await createWindowRectPolicyStep({window, policyId, mode}),
      {
        type: 'click',
        window,
        locator: byAutomationId('view-shot.action.capture-ref'),
      },
      {
        type: 'waitText',
        window,
        locator: byAutomationId('view-shot.result.managed-tmpfile'),
        matcher: {
          regex: '^[A-Za-z]:\\\\.+',
        },
        timeoutMs: defaultCaptureResultTimeoutMs,
        saveAs: 'captureRefPath',
      },
    ],
  };
}

export async function createViewShotDataUriAndScreenSpec({
  window = windows.main,
}) {
  return {
    name: 'view-shot-data-uri-and-screen',
    defaultTimeoutMs: defaultStepTimeoutMs,
    steps: [
      ...waitForLocator(window, byAutomationId('view-shot.action.capture-data-uri')),
      {
        type: 'click',
        window,
        locator: byAutomationId('view-shot.action.capture-data-uri'),
      },
      {
        type: 'waitText',
        window,
        locator: byAutomationId('view-shot.result.latest-result'),
        matcher: {
          regex: '^data:image/png;base64,',
          minLength: 48,
        },
        timeoutMs: defaultCaptureResultTimeoutMs,
        saveAs: 'componentDataUri',
      },
      {
        type: 'click',
        window,
        locator: byAutomationId('view-shot.action.capture-screen'),
      },
      {
        type: 'waitText',
        window,
        locator: byAutomationId('view-shot.result.latest-result'),
        matcher: {
          regex: '^[A-Za-z]:\\\\.+',
        },
        timeoutMs: defaultCaptureResultTimeoutMs,
        saveAs: 'captureScreenPath',
      },
    ],
  };
}

export async function createViewShotTmpfileReleaseSpec({
  window = windows.main,
}) {
  return {
    name: 'view-shot-release-tmpfile',
    defaultTimeoutMs: defaultStepTimeoutMs,
    steps: [
      ...waitForLocator(window, byAutomationId('view-shot.action.release-tmpfile')),
      {
        type: 'click',
        window,
        locator: byAutomationId('view-shot.action.release-tmpfile'),
      },
      {
        type: 'waitText',
        window,
        locator: byAutomationId('view-shot.result.managed-tmpfile'),
        matcher: {
          notRegex: '^[A-Za-z]:\\\\.+',
        },
        timeoutMs: defaultCaptureResultTimeoutMs,
      },
    ],
  };
}

export async function createWindowCaptureLabSpec({
  window = windows.main,
  policyId = 'main',
  mode = 'wide',
}) {
  return {
    name: 'window-capture-lab',
    defaultTimeoutMs: defaultStepTimeoutMs,
    steps: [
      ...waitForLocator(window, byAutomationId('window-capture.action.refresh')),
      await createWindowRectPolicyStep({window, policyId, mode}),
      {
        type: 'click',
        window,
        locator: byAutomationId('window-capture.action.refresh'),
      },
      {
        type: 'waitText',
        window,
        locator: byAutomationId('window-capture.metric.match-count'),
        matcher: {
          regex: '^[1-9]\\d*$',
        },
      },
      {
        type: 'click',
        window,
        locator: byAutomationId('window-capture.action.capture-window'),
      },
      {
        type: 'waitText',
        window,
        locator: byAutomationId('window-capture.result.output-path'),
        matcher: {
          regex: '^[A-Za-z]:\\\\.+',
        },
        timeoutMs: defaultCaptureResultTimeoutMs,
        saveAs: 'captureWindowPath',
      },
      {
        type: 'click',
        window,
        locator: byAutomationId('window-capture.action.capture-client'),
      },
      {
        type: 'waitText',
        window,
        locator: byAutomationId('window-capture.result.output-path'),
        matcher: {
          regex: '^[A-Za-z]:\\\\.+',
        },
        timeoutMs: defaultCaptureResultTimeoutMs,
        saveAs: 'captureClientPath',
      },
    ],
  };
}

export async function createAgentWorkbenchSpec({
  window = windows.main,
}) {
  return {
    name: 'agent-workbench',
    defaultTimeoutMs: defaultStepTimeoutMs,
    steps: [
      ...waitForLocator(
        window,
        byAutomationId('agent-workbench.action.run-git-status'),
      ),
      {
        type: 'click',
        window,
        locator: byAutomationId('agent-workbench.workspace.opapp-frontend'),
      },
      {
        type: 'waitText',
        window,
        locator: byAutomationId('agent-workbench.detail.selected-cwd'),
        matcher: {
          includes: 'opapp-frontend',
        },
      },
      {
        type: 'click',
        window,
        locator: byAutomationId('agent-workbench.action.run-git-status'),
      },
      {
        type: 'waitText',
        window,
        locator: byAutomationId('agent-workbench.run.command'),
        matcher: {
          includes: 'git status',
        },
      },
      {
        type: 'waitText',
        window,
        locator: byAutomationId('agent-workbench.terminal.transcript'),
        matcher: {
          includes: 'git status',
        },
      },
    ],
  };
}

export async function createAgentWorkbenchApprovalSpec({
  window = windows.main,
  decision = 'approve',
}) {
  if (decision !== 'approve' && decision !== 'reject') {
    throw new Error(
      `Agent workbench approval UI spec requires decision='approve' or 'reject', received '${decision}'.`,
    );
  }

  const decisionButtonAutomationId =
    decision === 'approve'
      ? 'agent-workbench.action.approve-request'
      : 'agent-workbench.action.reject-request';
  const outcomeTranscriptMatcher =
    decision === 'approve'
      ? {
          type: 'waitText',
          window,
          locator: byAutomationId('agent-workbench.terminal.transcript'),
          matcher: {
            includes: 'approvedAt=',
          },
          timeoutMs: defaultChatResponseTimeoutMs,
          saveAs: 'approvalTranscript',
        }
      : null;

  return {
    name: `agent-workbench-approval-${decision}`,
    defaultTimeoutMs: defaultStepTimeoutMs,
    steps: [
      ...waitForLocator(
        window,
        byAutomationId('agent-workbench.action.request-write-approval'),
      ),
      {
        type: 'click',
        window,
        locator: byAutomationId('agent-workbench.workspace.opapp-frontend'),
      },
      {
        type: 'waitText',
        window,
        locator: byAutomationId('agent-workbench.detail.selected-cwd'),
        matcher: {
          includes: 'opapp-frontend',
        },
      },
      waitForElementState({
        window,
        locator: byAutomationId('agent-workbench.action.request-write-approval'),
        matcher: {
          enabled: true,
        },
      }),
      {
        type: 'click',
        window,
        locator: byAutomationId('agent-workbench.action.request-write-approval'),
      },
      {
        type: 'waitText',
        window,
        locator: byAutomationId('agent-workbench.status.message'),
        matcher: {
          minLength: 4,
        },
      },
      sendKeys({
        window,
        keys: '{PGDN}',
        delayMs: 300,
        label: 'scroll-to-approval-panel',
      }),
      waitForElementState({
        window,
        locator: byAutomationId('agent-workbench.action.approve-request'),
        matcher: {
          enabled: true,
        },
      }),
      waitForElementState({
        window,
        locator: byAutomationId('agent-workbench.action.reject-request'),
        matcher: {
          enabled: true,
        },
      }),
      {
        type: 'click',
        window,
        locator: byAutomationId(decisionButtonAutomationId),
      },
      {
        type: 'assertElementMissing',
        window,
        locator: byAutomationId('agent-workbench.action.approve-request'),
        timeoutMs: defaultLocatorTimeoutMs,
      },
      {
        type: 'assertElementMissing',
        window,
        locator: byAutomationId('agent-workbench.action.reject-request'),
        timeoutMs: defaultLocatorTimeoutMs,
      },
      ...(outcomeTranscriptMatcher ? [outcomeTranscriptMatcher] : []),
      waitForElementState({
        window,
        locator: byAutomationId('agent-workbench.action.request-write-approval'),
        matcher: {
          enabled: true,
        },
        timeoutMs:
          decision === 'approve'
            ? defaultChatResponseTimeoutMs
            : defaultLocatorTimeoutMs,
      }),
    ],
  };
}

export async function createLlmChatSpec({
  window = windows.main,
  policyId = 'main',
  mode = 'wide',
  baseUrl,
  model,
  token,
  prompt,
  expectedAssistantText = null,
  expectedErrorText = null,
}) {
  if (!baseUrl || !model || !token || !prompt) {
    throw new Error('LLM chat UI spec requires baseUrl, model, token, and prompt.');
  }

  return {
    name: 'llm-chat',
    defaultTimeoutMs: defaultStepTimeoutMs,
    steps: [
      ...waitForLocator(window, byAutomationId('llm-chat.composer.prompt')),
      await createWindowRectPolicyStep({window, policyId, mode}),
      {
        type: 'setValue',
        window,
        locator: byAutomationId('llm-chat.config.base-url'),
        value: baseUrl,
      },
      {
        type: 'setValue',
        window,
        locator: byAutomationId('llm-chat.config.model'),
        value: model,
      },
      {
        type: 'setValue',
        window,
        locator: byAutomationId('llm-chat.config.token'),
        value: token,
      },
      {
        type: 'setValue',
        window,
        locator: byAutomationId('llm-chat.composer.prompt'),
        value: prompt,
      },
      {
        type: 'click',
        window,
        locator: byAutomationId('llm-chat.action.send'),
      },
      expectedAssistantText
        ? {
            type: 'waitText',
            window,
            locator: byAutomationId('llm-chat.message.assistant.content', {
              index: -1,
            }),
            matcher: {
              includes: expectedAssistantText,
            },
            timeoutMs: defaultChatResponseTimeoutMs,
            saveAs: 'assistantText',
          }
        : {
            type: 'waitText',
            window,
            locator: byAutomationId('llm-chat.error.message'),
            matcher: {
              includes: expectedErrorText,
            },
            timeoutMs: defaultChatResponseTimeoutMs,
            saveAs: 'errorText',
          },
    ],
  };
}

export {windows};
