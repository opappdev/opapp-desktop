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

const timingSummaryRegex =
  /timing summary scenario=(\S+) launchMode=(packaged|portable) startupMs=(\d+) scenarioMs=(\d+) totalMarkerMs=(\d+)/;
const verifyTimingSummaryRegex = /scenario timing summary totalMs=(\d+) scenarioCount=(\d+)/;

export function parseMarkerTimingSummaryLine(line) {
  const match = line.match(timingSummaryRegex);
  if (!match) {
    return null;
  }

  return {
    launchMode: match[2],
    markerTotalDurationMs: Number(match[5]),
    scenarioName: match[1],
    scenarioPhaseDurationMs: Number(match[4]),
    startupPhaseDurationMs: Number(match[3]),
  };
}

export function parseVerifyTimingSummaryLine(line) {
  const match = line.match(verifyTimingSummaryRegex);
  if (!match) {
    return null;
  }

  return {
    scenarioCount: Number(match[2]),
    totalDurationMs: Number(match[1]),
  };
}

function getNearestRankValue(values, percentile) {
  const sortedValues = [...values].sort((a, b) => a - b);
  const percentileIndex = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil(sortedValues.length * percentile) - 1),
  );
  return sortedValues[percentileIndex];
}

export function buildTimingBudgetRecommendation(
  timingSummaries,
  {headroomMs = 5_000, percentile = 0.95} = {},
) {
  if (!Array.isArray(timingSummaries) || timingSummaries.length === 0) {
    throw new Error('timing summary recommendation requires at least one sample.');
  }

  if (!Number.isFinite(headroomMs) || headroomMs < 0) {
    throw new Error(`headroomMs must be a non-negative finite number; received ${headroomMs}.`);
  }

  if (!Number.isFinite(percentile) || percentile <= 0 || percentile > 1) {
    throw new Error(`percentile must be in (0, 1]; received ${percentile}.`);
  }

  const startupDurations = timingSummaries.map(summary => summary.startupPhaseDurationMs);
  const scenarioDurations = timingSummaries.map(summary => summary.scenarioPhaseDurationMs);
  const startupPercentileMs = getNearestRankValue(startupDurations, percentile);
  const scenarioPercentileMs = getNearestRankValue(scenarioDurations, percentile);

  return {
    headroomMs,
    percentile,
    sampleCount: timingSummaries.length,
    scenario: {
      maxMs: Math.max(...scenarioDurations),
      percentileMs: scenarioPercentileMs,
      recommendedBudgetMs: scenarioPercentileMs + headroomMs,
    },
    startup: {
      maxMs: Math.max(...startupDurations),
      percentileMs: startupPercentileMs,
      recommendedBudgetMs: startupPercentileMs + headroomMs,
    },
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
