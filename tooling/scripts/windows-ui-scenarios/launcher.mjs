import {
  byAutomationId,
  createWindowRectPolicyStep,
  defaultLocatorTimeoutMs,
  defaultStepTimeoutMs,
  waitForLocator,
  windows,
} from './shared.mjs';

export const bundleLauncherReadyLocator = byAutomationId(
  'bundle-launcher.action.check-updates',
);

const bundleLauncherServiceDetailLocator = byAutomationId(
  'bundle-launcher.service.detail',
);
const bundleLauncherOpenAgentWorkbenchLocator = byAutomationId(
  'bundle-launcher.action.open-agent-workbench',
);
const bundleLauncherDetailTitleLocator = byAutomationId(
  'bundle-launcher.detail.title',
);
const bundleLauncherMainRowLocator = byAutomationId(
  'bundle-launcher.row.opapp.companion.main',
);
const bundleLauncherStartupPreferencesHeaderLocator = byAutomationId(
  'bundle-launcher.startup-preferences.header',
);
const bundleLauncherStartupPreferencesSelectedTargetLocator = byAutomationId(
  'bundle-launcher.startup-target.selected',
);
const bundleLauncherAgentWorkbenchStartupTargetLocator = byAutomationId(
  'bundle-launcher.startup-target.agent-workbench',
);
const bundleLauncherSettingsStartupTargetLocator = byAutomationId(
  'bundle-launcher.startup-target.settings',
);
const bundleLauncherViewShotStartupTargetLocator = byAutomationId(
  'bundle-launcher.startup-target.view-shot',
);
const bundleLauncherWindowCaptureStartupTargetLocator = byAutomationId(
  'bundle-launcher.startup-target.window-capture',
);
const bundleLauncherDetailPrimaryActionLocator = byAutomationId(
  'bundle-launcher.detail.action.primary',
);
const settingsReadyLocator = byAutomationId('settings.action.save-preferences');
const viewShotReadyLocator = byAutomationId('view-shot.frame.action.return-home');
const windowCaptureReadyLocator = byAutomationId(
  'window-capture.frame.action.return-home',
);

export const bundleLauncherReadyTimeoutMs = 35_000;

export async function createBundleLauncherRootSpec({
  window = windows.main,
  policyId = 'main',
  mode = 'wide',
}) {
  return {
    name: 'bundle-launcher-root',
    defaultTimeoutMs: defaultStepTimeoutMs,
    steps: [
      ...waitForLocator(
        window,
        bundleLauncherReadyLocator,
        bundleLauncherReadyTimeoutMs,
      ),
      {
        type: 'waitText',
        window,
        locator: bundleLauncherServiceDetailLocator,
        matcher: {
          minLength: 4,
        },
        timeoutMs: defaultLocatorTimeoutMs,
        saveAs: 'serviceDetail',
      },
      {
        type: 'waitText',
        window,
        locator: bundleLauncherDetailTitleLocator,
        matcher: {
          minLength: 2,
        },
        timeoutMs: defaultLocatorTimeoutMs,
        saveAs: 'selectedBundleTitle',
      },
      {
        // Rows need a real pointer path after the selectable-row polish, but
        // the disclosure header is a semantic button and may sit near the fold
        // in CI-sized windows. Use button activation here so UIA does not
        // pointer-click outside the window.
        type: 'click',
        window,
        locator: bundleLauncherStartupPreferencesHeaderLocator,
        timeoutMs: defaultLocatorTimeoutMs,
        captureScreenshot: true,
      },
      {
        type: 'waitElement',
        window,
        locator: bundleLauncherStartupPreferencesSelectedTargetLocator,
        timeoutMs: defaultLocatorTimeoutMs,
      },
      await createWindowRectPolicyStep({window, policyId, mode}),
    ],
  };
}

export async function createBundleLauncherAgentWorkbenchRoundTripSpec({
  window = windows.main,
}) {
  return {
    name: 'bundle-launcher-agent-workbench-round-trip',
    defaultTimeoutMs: defaultStepTimeoutMs,
    steps: [
      ...waitForLocator(
        window,
        bundleLauncherReadyLocator,
        bundleLauncherReadyTimeoutMs,
      ),
      {
        type: 'click',
        window,
        locator: bundleLauncherOpenAgentWorkbenchLocator,
        timeoutMs: defaultLocatorTimeoutMs,
        captureScreenshot: true,
      },
      ...waitForLocator(
        window,
        byAutomationId('agent-workbench.action.return-main'),
      ),
      {
        type: 'click',
        window,
        locator: byAutomationId('agent-workbench.action.return-main'),
        timeoutMs: defaultLocatorTimeoutMs,
      },
      ...waitForLocator(
        window,
        bundleLauncherReadyLocator,
        bundleLauncherReadyTimeoutMs,
      ),
    ],
  };
}

export async function createBundleLauncherStartupPreferenceOpenSpec({
  window = windows.main,
}) {
  return {
    name: 'bundle-launcher-startup-preference-open',
    defaultTimeoutMs: defaultStepTimeoutMs,
    steps: [
      ...waitForLocator(
        window,
        bundleLauncherReadyLocator,
        bundleLauncherReadyTimeoutMs,
      ),
      {
        type: 'click',
        window,
        locator: bundleLauncherMainRowLocator,
        timeoutMs: defaultLocatorTimeoutMs,
      },
      {
        type: 'click',
        window,
        locator: bundleLauncherStartupPreferencesHeaderLocator,
        timeoutMs: defaultLocatorTimeoutMs,
      },
      ...waitForLocator(
        window,
        bundleLauncherAgentWorkbenchStartupTargetLocator,
        defaultLocatorTimeoutMs,
      ),
      {
        type: 'click',
        window,
        locator: bundleLauncherAgentWorkbenchStartupTargetLocator,
        timeoutMs: defaultLocatorTimeoutMs,
        captureScreenshot: true,
      },
      {
        type: 'click',
        window,
        locator: bundleLauncherDetailPrimaryActionLocator,
        timeoutMs: defaultLocatorTimeoutMs,
      },
      ...waitForLocator(
        window,
        byAutomationId('agent-workbench.action.return-main'),
      ),
      {
        type: 'click',
        window,
        locator: byAutomationId('agent-workbench.action.return-main'),
        timeoutMs: defaultLocatorTimeoutMs,
      },
      ...waitForLocator(
        window,
        bundleLauncherReadyLocator,
        bundleLauncherReadyTimeoutMs,
      ),
    ],
  };
}

export async function createBundleLauncherSettingsRoundTripSpec({
  window = windows.main,
}) {
  return {
    name: 'bundle-launcher-settings-round-trip',
    defaultTimeoutMs: defaultStepTimeoutMs,
    steps: [
      ...waitForLocator(
        window,
        bundleLauncherReadyLocator,
        bundleLauncherReadyTimeoutMs,
      ),
      {
        type: 'click',
        window,
        locator: bundleLauncherMainRowLocator,
        timeoutMs: defaultLocatorTimeoutMs,
      },
      {
        type: 'click',
        window,
        locator: bundleLauncherStartupPreferencesHeaderLocator,
        timeoutMs: defaultLocatorTimeoutMs,
      },
      ...waitForLocator(
        window,
        bundleLauncherSettingsStartupTargetLocator,
        defaultLocatorTimeoutMs,
      ),
      {
        type: 'click',
        window,
        locator: bundleLauncherSettingsStartupTargetLocator,
        timeoutMs: defaultLocatorTimeoutMs,
      },
      {
        type: 'click',
        window,
        locator: bundleLauncherDetailPrimaryActionLocator,
        timeoutMs: defaultLocatorTimeoutMs,
      },
      ...waitForLocator(window, settingsReadyLocator),
      {
        type: 'click',
        window,
        locator: byAutomationId('settings.frame.action.return-home'),
        timeoutMs: defaultLocatorTimeoutMs,
      },
      ...waitForLocator(
        window,
        bundleLauncherReadyLocator,
        bundleLauncherReadyTimeoutMs,
      ),
      {
        type: 'click',
        window,
        locator: bundleLauncherDetailPrimaryActionLocator,
        timeoutMs: defaultLocatorTimeoutMs,
        captureScreenshot: true,
      },
      ...waitForLocator(window, settingsReadyLocator),
    ],
  };
}

export async function createBundleLauncherPostSettingsPointerSwitchSpec({
  window = windows.main,
}) {
  return {
    name: 'bundle-launcher-post-settings-pointer-switch',
    defaultTimeoutMs: defaultStepTimeoutMs,
    steps: [
      ...waitForLocator(
        window,
        bundleLauncherReadyLocator,
        bundleLauncherReadyTimeoutMs,
      ),
      {
        type: 'click',
        window,
        locator: bundleLauncherMainRowLocator,
        timeoutMs: defaultLocatorTimeoutMs,
      },
      {
        type: 'click',
        window,
        locator: bundleLauncherStartupPreferencesHeaderLocator,
        timeoutMs: defaultLocatorTimeoutMs,
      },
      ...waitForLocator(
        window,
        bundleLauncherSettingsStartupTargetLocator,
        defaultLocatorTimeoutMs,
      ),
      {
        type: 'clickPointer',
        window,
        locator: bundleLauncherSettingsStartupTargetLocator,
        timeoutMs: defaultLocatorTimeoutMs,
      },
      {
        type: 'clickPointer',
        window,
        locator: bundleLauncherDetailPrimaryActionLocator,
        timeoutMs: defaultLocatorTimeoutMs,
      },
      ...waitForLocator(window, settingsReadyLocator),
      {
        type: 'click',
        window,
        locator: byAutomationId('settings.frame.action.return-home'),
        timeoutMs: defaultLocatorTimeoutMs,
      },
      ...waitForLocator(
        window,
        bundleLauncherReadyLocator,
        bundleLauncherReadyTimeoutMs,
      ),
      {
        type: 'click',
        window,
        locator: bundleLauncherStartupPreferencesHeaderLocator,
        timeoutMs: defaultLocatorTimeoutMs,
      },
      ...waitForLocator(
        window,
        bundleLauncherAgentWorkbenchStartupTargetLocator,
        defaultLocatorTimeoutMs,
      ),
      {
        type: 'clickPointer',
        window,
        locator: bundleLauncherAgentWorkbenchStartupTargetLocator,
        timeoutMs: defaultLocatorTimeoutMs,
        captureScreenshot: true,
      },
      {
        type: 'clickPointer',
        window,
        locator: bundleLauncherDetailPrimaryActionLocator,
        timeoutMs: defaultLocatorTimeoutMs,
      },
      ...waitForLocator(
        window,
        byAutomationId('agent-workbench.action.return-main'),
      ),
    ],
  };
}

async function createBundleLauncherPostSettingsPointerOpenSpec({
  window = windows.main,
  name,
  targetLocator,
  readyLocator,
  targetSelectionStepType = 'clickPointer',
}) {
  return {
    name,
    defaultTimeoutMs: defaultStepTimeoutMs,
    steps: [
      ...waitForLocator(
        window,
        bundleLauncherReadyLocator,
        bundleLauncherReadyTimeoutMs,
      ),
      {
        type: 'click',
        window,
        locator: bundleLauncherMainRowLocator,
        timeoutMs: defaultLocatorTimeoutMs,
      },
      {
        type: 'click',
        window,
        locator: bundleLauncherStartupPreferencesHeaderLocator,
        timeoutMs: defaultLocatorTimeoutMs,
      },
      ...waitForLocator(
        window,
        bundleLauncherSettingsStartupTargetLocator,
        defaultLocatorTimeoutMs,
      ),
      {
        type: 'clickPointer',
        window,
        locator: bundleLauncherSettingsStartupTargetLocator,
        timeoutMs: defaultLocatorTimeoutMs,
      },
      {
        type: 'clickPointer',
        window,
        locator: bundleLauncherDetailPrimaryActionLocator,
        timeoutMs: defaultLocatorTimeoutMs,
      },
      ...waitForLocator(window, settingsReadyLocator),
      {
        type: 'click',
        window,
        locator: byAutomationId('settings.frame.action.return-home'),
        timeoutMs: defaultLocatorTimeoutMs,
      },
      ...waitForLocator(
        window,
        bundleLauncherReadyLocator,
        bundleLauncherReadyTimeoutMs,
      ),
      {
        type: 'click',
        window,
        locator: bundleLauncherStartupPreferencesHeaderLocator,
        timeoutMs: defaultLocatorTimeoutMs,
      },
      ...waitForLocator(window, targetLocator, defaultLocatorTimeoutMs),
      {
        type: targetSelectionStepType,
        window,
        locator: targetLocator,
        timeoutMs: defaultLocatorTimeoutMs,
        captureScreenshot: true,
      },
      {
        type: 'clickPointer',
        window,
        locator: bundleLauncherDetailPrimaryActionLocator,
        timeoutMs: defaultLocatorTimeoutMs,
      },
      ...waitForLocator(window, readyLocator),
    ],
  };
}

export async function createBundleLauncherPostSettingsViewShotPointerOpenSpec({
  window = windows.main,
}) {
  return createBundleLauncherPostSettingsPointerOpenSpec({
    window,
    name: 'bundle-launcher-post-settings-view-shot-pointer-open',
    targetLocator: bundleLauncherViewShotStartupTargetLocator,
    readyLocator: viewShotReadyLocator,
  });
}

export async function createBundleLauncherPostSettingsWindowCapturePointerOpenSpec({
  window = windows.main,
}) {
  return createBundleLauncherPostSettingsPointerOpenSpec({
    window,
    name: 'bundle-launcher-post-settings-window-capture-pointer-open',
    targetLocator: bundleLauncherWindowCaptureStartupTargetLocator,
    readyLocator: windowCaptureReadyLocator,
    targetSelectionStepType: 'click',
  });
}
