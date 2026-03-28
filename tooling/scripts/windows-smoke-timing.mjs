export function buildTimingPhaseResult({phaseLabel, elapsedMs, budgetMs, timeoutFlag}) {
  const slackMs = budgetMs - elapsedMs;
  const utilizationPercent = budgetMs > 0 ? (elapsedMs / budgetMs) * 100 : 0;
  const recommendedBudgetMs = elapsedMs + 5_000;

  const message =
    `${phaseLabel} completed in ${elapsedMs}ms ` +
    `(budget=${budgetMs}ms slack=${slackMs}ms utilization=${utilizationPercent.toFixed(1)}% flag=${timeoutFlag})`;

  const hint = slackMs <= 2_000
    ? `${phaseLabel} headroom is low (<=2000ms); consider raising ${timeoutFlag} to >=${recommendedBudgetMs} on slower hosts.`
    : null;

  return {
    hint,
    message,
    recommendedBudgetMs,
    slackMs,
    utilizationPercent,
  };
}

export function formatMarkerTimeoutMessage({phaseLabel, scenarioName, timeoutFlag, timeoutMs}) {
  return (
    `Windows release smoke timed out waiting for ${phaseLabel} in scenario '${scenarioName}' ` +
    `within ${timeoutMs}ms (configured by ${timeoutFlag}); consider increasing ${timeoutFlag}.`
  );
}

export function formatMarkerTimingSummary({
  launchMode,
  markerTotalDurationMs,
  scenarioName,
  scenarioPhaseDurationMs,
  startupPhaseDurationMs,
}) {
  return (
    `timing summary scenario=${scenarioName} launchMode=${launchMode} ` +
    `startupMs=${startupPhaseDurationMs} scenarioMs=${scenarioPhaseDurationMs} totalMarkerMs=${markerTotalDurationMs}`
  );
}
