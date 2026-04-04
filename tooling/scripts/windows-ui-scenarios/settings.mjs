import {
  byAutomationId,
  createWindowRectPolicyStep,
  defaultStepTimeoutMs,
  waitForElementState,
  waitForLocator,
  windows,
} from './shared.mjs';
import {
  bundleLauncherReadyLocator,
  bundleLauncherReadyTimeoutMs,
} from './launcher.mjs';

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
      ...waitForLocator(
        windows.main,
        bundleLauncherReadyLocator,
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
