import assert from 'node:assert/strict';
import test from 'node:test';
import {resolveScenarioTimeoutMs} from './windows-scenario-timeouts.mjs';

test('resolveScenarioTimeoutMs raises view-shot timeout when no explicit scenario flag is set', () => {
  const result = resolveScenarioTimeoutMs({
    argv: ['node', 'windows-release-smoke.mjs'],
    baseScenarioTimeoutMs: 12_500,
    scenarioName: 'view-shot-current-window',
  });

  assert.deepEqual(result, {
    scenarioTimeoutMs: 18_500,
    source: 'scenario-default',
  });
});

test('resolveScenarioTimeoutMs preserves explicit scenario timeout flags', () => {
  const result = resolveScenarioTimeoutMs({
    argv: ['node', 'windows-release-smoke.mjs', '--scenario-ms=12000'],
    baseScenarioTimeoutMs: 12_000,
    scenarioName: 'view-shot-current-window',
  });

  assert.deepEqual(result, {
    scenarioTimeoutMs: 12_000,
    source: null,
  });
});

test('resolveScenarioTimeoutMs leaves unrelated scenarios unchanged', () => {
  const result = resolveScenarioTimeoutMs({
    argv: ['node', 'windows-release-smoke.mjs'],
    baseScenarioTimeoutMs: 12_500,
    scenarioName: 'window-capture-current-window',
  });

  assert.deepEqual(result, {
    scenarioTimeoutMs: 12_500,
    source: null,
  });
});
