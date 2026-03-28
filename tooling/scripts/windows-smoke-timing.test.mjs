import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildTimingBudgetRecommendation,
  buildTimingPhaseResult,
  formatMarkerTimeoutMessage,
  formatMarkerTimingSummary,
  parseMarkerTimingSummaryLine,
  parseVerifyLaunchModeLine,
  parseVerifyTimingSummaryLine,
} from './windows-smoke-timing.mjs';

test('buildTimingPhaseResult omits low-headroom hint when slack is healthy', () => {
  const result = buildTimingPhaseResult({
    phaseLabel: 'startup markers',
    elapsedMs: 6_000,
    budgetMs: 12_000,
    timeoutFlag: '--startup-ms',
  });

  assert.equal(result.slackMs, 6_000);
  assert.equal(result.hint, null);
  assert.match(result.message, /startup markers completed in 6000ms/);
  assert.match(result.message, /utilization=50.0%/);
});

test('buildTimingPhaseResult emits low-headroom hint and recommendation', () => {
  const result = buildTimingPhaseResult({
    phaseLabel: 'scenario success markers',
    elapsedMs: 9_500,
    budgetMs: 11_000,
    timeoutFlag: '--scenario-ms',
  });

  assert.equal(result.slackMs, 1_500);
  assert.equal(result.recommendedBudgetMs, 14_500);
  assert.ok(result.hint);
  assert.match(result.hint, /--scenario-ms/);
  assert.match(result.hint, />=14500/);
});

test('formatMarkerTimeoutMessage references scenario and timeout flag', () => {
  const message = formatMarkerTimeoutMessage({
    phaseLabel: 'startup markers',
    scenarioName: 'secondary-window',
    timeoutFlag: '--startup-ms',
    timeoutMs: 20_000,
  });

  assert.match(message, /secondary-window/);
  assert.match(message, /20000ms/);
  assert.match(message, /configured by --startup-ms/);
});

test('formatMarkerTimingSummary prints scenario/launch timing tuple', () => {
  const message = formatMarkerTimingSummary({
    scenarioName: 'tab-session',
    launchMode: 'portable',
    startupPhaseDurationMs: 8_000,
    scenarioPhaseDurationMs: 11_000,
    markerTotalDurationMs: 19_500,
  });

  assert.equal(
    message,
    'timing summary scenario=tab-session launchMode=portable startupMs=8000 scenarioMs=11000 totalMarkerMs=19500',
  );
});

test('parseMarkerTimingSummaryLine extracts timing tuple from summary log line', () => {
  const parsed = parseMarkerTimingSummaryLine(
    '[smoke] timing summary scenario=tab-session launchMode=portable startupMs=8000 scenarioMs=11000 totalMarkerMs=19500',
  );

  assert.deepEqual(parsed, {
    launchMode: 'portable',
    markerTotalDurationMs: 19_500,
    scenarioName: 'tab-session',
    scenarioPhaseDurationMs: 11_000,
    startupPhaseDurationMs: 8_000,
  });
});

test('buildTimingBudgetRecommendation computes nearest-rank percentile recommendations', () => {
  const recommendation = buildTimingBudgetRecommendation(
    [
      {
        startupPhaseDurationMs: 8_000,
        scenarioPhaseDurationMs: 12_000,
      },
      {
        startupPhaseDurationMs: 8_500,
        scenarioPhaseDurationMs: 10_000,
      },
      {
        startupPhaseDurationMs: 9_200,
        scenarioPhaseDurationMs: 12_500,
      },
      {
        startupPhaseDurationMs: 7_900,
        scenarioPhaseDurationMs: 9_700,
      },
    ],
    {headroomMs: 3_000, percentile: 0.75},
  );

  assert.equal(recommendation.sampleCount, 4);
  assert.equal(recommendation.startup.percentileMs, 8_500);
  assert.equal(recommendation.startup.recommendedBudgetMs, 11_500);
  assert.equal(recommendation.scenario.percentileMs, 12_000);
  assert.equal(recommendation.scenario.recommendedBudgetMs, 15_000);
});

test('parseVerifyTimingSummaryLine extracts verify total duration summary', () => {
  const parsed = parseVerifyTimingSummaryLine(
    "[verify] scenario timing summary totalMs=58123 scenarioCount=7",
  );

  assert.deepEqual(parsed, {
    scenarioCount: 7,
    totalDurationMs: 58_123,
  });
});

test('parseVerifyLaunchModeLine extracts verify launch mode marker', () => {
  assert.equal(parseVerifyLaunchModeLine('[verify] launchMode=portable'), 'portable');
  assert.equal(parseVerifyLaunchModeLine('[verify] launchMode=packaged'), 'packaged');
  assert.equal(parseVerifyLaunchModeLine('[verify] scenario timing summary totalMs=58123'), null);
});

test('buildTimingBudgetRecommendation validates inputs', () => {
  assert.throws(() => buildTimingBudgetRecommendation([], {headroomMs: 5_000}), /at least one sample/);
  assert.throws(
    () =>
      buildTimingBudgetRecommendation(
        [
          {
            startupPhaseDurationMs: 8_000,
            scenarioPhaseDurationMs: 12_000,
          },
        ],
        {percentile: 0},
      ),
    /percentile must be in \(0, 1]/,
  );
  assert.throws(
    () =>
      buildTimingBudgetRecommendation(
        [
          {
            startupPhaseDurationMs: 8_000,
            scenarioPhaseDurationMs: 12_000,
          },
        ],
        {headroomMs: -1},
      ),
    /headroomMs must be a non-negative finite number/,
  );
});
