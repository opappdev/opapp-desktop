import path from 'node:path';

export function createLauncherDevScenarios({
  clearOptionalFile,
  companionStartupTargetPath,
  createBundleLauncherAgentWorkbenchRoundTripSpec,
  createBundleLauncherPostSettingsPointerSwitchSpec,
  createBundleLauncherPostSettingsViewShotPointerOpenSpec,
  createBundleLauncherPostSettingsWindowCapturePointerOpenSpec,
  createBundleLauncherSettingsRoundTripSpec,
  createBundleLauncherStartupPreferenceOpenSpec,
  mkdir,
  readOptionalFile,
  verifyDevPreferencesPath,
  writeFile,
}) {
  const restoreStartupTargetSnapshot = async state => {
    if (typeof state?.startupTargetSnapshot === 'string') {
      await mkdir(path.dirname(companionStartupTargetPath), {
        recursive: true,
      });
      await writeFile(
        companionStartupTargetPath,
        state.startupTargetSnapshot,
        'utf8',
      );
      return;
    }

    await clearOptionalFile(companionStartupTargetPath);
  };

  const createLauncherDevScenario = ({
    name,
    description,
    buildUiSpec,
    successSummary,
  }) => ({
    name,
    description,
    allowInstalledDebugReuse: false,
    async prepareState() {
      const startupTargetSnapshot = await readOptionalFile(
        companionStartupTargetPath,
      );
      await clearOptionalFile(companionStartupTargetPath);
      return {
        startupTargetSnapshot,
      };
    },
    launchConfig: {
      preferences: {
        path: verifyDevPreferencesPath,
      },
    },
    async cleanupState(state) {
      await restoreStartupTargetSnapshot(state);
    },
    async buildUiSpec() {
      return await buildUiSpec();
    },
    successSummary,
  });

  return [
    createLauncherDevScenario({
      name: 'launcher-agent-workbench-current-window',
      description:
        'Metro-backed launcher opens Agent Workbench from the home action button and returns to the launcher in the current window',
      async buildUiSpec() {
        return await createBundleLauncherAgentWorkbenchRoundTripSpec({});
      },
      successSummary:
        'Metro-backed Windows host completed launcher -> Agent Workbench -> launcher current-window smoke.',
    }),
    createLauncherDevScenario({
      name: 'launcher-startup-preference-open-current-window',
      description:
        'Metro-backed launcher opens the selected startup preference entry in the current window without requiring a second click',
      async buildUiSpec() {
        return await createBundleLauncherStartupPreferenceOpenSpec({});
      },
      successSummary:
        'Metro-backed Windows host opened a selected launcher startup preference in the current window and returned home.',
    }),
    createLauncherDevScenario({
      name: 'launcher-settings-round-trip-current-window',
      description:
        'Metro-backed launcher opens Settings from startup preferences, returns home, then reopens Settings from startup preferences without a second click',
      async buildUiSpec() {
        return await createBundleLauncherSettingsRoundTripSpec({});
      },
      successSummary:
        'Metro-backed Windows host reopened Settings from launcher startup preferences after returning home.',
    }),
    createLauncherDevScenario({
      name: 'launcher-post-settings-pointer-switch-current-window',
      description:
        'Metro-backed launcher supports pointer-driven startup target switching after returning home from Settings',
      async buildUiSpec() {
        return await createBundleLauncherPostSettingsPointerSwitchSpec({});
      },
      successSummary:
        'Metro-backed Windows host switched launcher startup targets with pointer input after returning from Settings.',
    }),
    createLauncherDevScenario({
      name: 'launcher-post-settings-view-shot-pointer-open-current-window',
      description:
        'Metro-backed launcher opens View Shot from startup preferences after returning home from Settings with pointer input',
      async buildUiSpec() {
        return await createBundleLauncherPostSettingsViewShotPointerOpenSpec(
          {},
        );
      },
      successSummary:
        'Metro-backed Windows host opened View Shot from launcher startup preferences after returning from Settings.',
    }),
    createLauncherDevScenario({
      name: 'launcher-post-settings-window-capture-pointer-open-current-window',
      description:
        'Metro-backed launcher opens Window Capture from startup preferences after returning home from Settings with pointer input',
      async buildUiSpec() {
        return await createBundleLauncherPostSettingsWindowCapturePointerOpenSpec(
          {},
        );
      },
      successSummary:
        'Metro-backed Windows host opened Window Capture from launcher startup preferences after returning from Settings.',
    }),
  ];
}
