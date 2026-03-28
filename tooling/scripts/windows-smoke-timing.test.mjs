import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildTimingPhaseResult,
  formatMarkerTimeoutMessage,
  formatMarkerTimingSummary,
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
