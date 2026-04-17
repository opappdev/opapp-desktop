import path from 'node:path';
import {launcherCurrentWindowScenarioCatalog} from '../windows-launcher-current-window-scenarios.mjs';

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
  const uiSpecFactories = {
    createBundleLauncherAgentWorkbenchRoundTripSpec,
    createBundleLauncherStartupPreferenceOpenSpec,
    createBundleLauncherSettingsRoundTripSpec,
    createBundleLauncherPostSettingsPointerSwitchSpec,
    createBundleLauncherPostSettingsViewShotPointerOpenSpec,
    createBundleLauncherPostSettingsWindowCapturePointerOpenSpec,
  };

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

  return launcherCurrentWindowScenarioCatalog.map(
    ({name, uiSpecFactoryName, devDescription, successSummary}) => {
      const buildUiSpec = uiSpecFactories[uiSpecFactoryName];
      if (typeof buildUiSpec !== 'function') {
        throw new Error(
          `Unknown launcher dev UI spec factory '${uiSpecFactoryName}' for scenario '${name}'.`,
        );
      }

      return createLauncherDevScenario({
        name,
        description: devDescription,
        async buildUiSpec() {
          return await buildUiSpec({});
        },
        successSummary,
      });
    },
  );
}
