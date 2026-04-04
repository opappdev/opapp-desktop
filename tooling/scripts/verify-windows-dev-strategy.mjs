export function resolveVerifyDevScenarioLaunchStrategy({
  skipPrepare = false,
  scenarioIndex = 0,
  allowInstalledDebugReuse = true,
}) {
  if (skipPrepare) {
    return {
      launchMode: 'installed-debug-relaunch',
      source: 'cli-skip-prepare',
    };
  }

  if (scenarioIndex > 0 && allowInstalledDebugReuse) {
    return {
      launchMode: 'installed-debug-relaunch',
      source: 'multi-scenario-reuse',
    };
  }

  return {
    launchMode: 'full-prepare',
    source:
      scenarioIndex === 0 ? 'initial-scenario' : 'scenario-opt-out',
  };
}
