const scenarioTimeoutDefaults = Object.freeze({
  'view-shot-current-window': 18_500,
});

function hasExplicitTimeoutFlag(argv, flagName) {
  return argv.some(
    argument => typeof argument === 'string' && argument.startsWith(`${flagName}=`),
  );
}

export function resolveScenarioTimeoutMs({
  argv,
  baseScenarioTimeoutMs,
  scenarioName,
}) {
  const normalizedBaseTimeoutMs = Math.floor(baseScenarioTimeoutMs);
  const scenarioDefaultTimeoutMs = scenarioTimeoutDefaults[scenarioName] ?? null;

  if (
    !scenarioDefaultTimeoutMs ||
    hasExplicitTimeoutFlag(argv, '--scenario-ms')
  ) {
    return {
      scenarioTimeoutMs: normalizedBaseTimeoutMs,
      source: null,
    };
  }

  const effectiveScenarioTimeoutMs = Math.max(
    normalizedBaseTimeoutMs,
    scenarioDefaultTimeoutMs,
  );

  return {
    scenarioTimeoutMs: effectiveScenarioTimeoutMs,
    source:
      effectiveScenarioTimeoutMs > normalizedBaseTimeoutMs
        ? 'scenario-default'
        : null,
  };
}
