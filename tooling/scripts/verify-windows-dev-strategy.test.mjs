import assert from 'node:assert/strict';
import test from 'node:test';
import {resolveVerifyDevScenarioLaunchStrategy} from './verify-windows-dev-strategy.mjs';

test('verify-windows-dev strategy uses full prepare for the initial scenario by default', () => {
  assert.deepEqual(
    resolveVerifyDevScenarioLaunchStrategy({
      skipPrepare: false,
      scenarioIndex: 0,
    }),
    {
      launchMode: 'full-prepare',
      source: 'initial-scenario',
    },
  );
});

test('verify-windows-dev strategy reuses the installed debug app for later scenarios', () => {
  assert.deepEqual(
    resolveVerifyDevScenarioLaunchStrategy({
      skipPrepare: false,
      scenarioIndex: 1,
    }),
    {
      launchMode: 'installed-debug-relaunch',
      source: 'multi-scenario-reuse',
    },
  );
});

test('verify-windows-dev strategy respects explicit skip-prepare for every scenario', () => {
  assert.deepEqual(
    resolveVerifyDevScenarioLaunchStrategy({
      skipPrepare: true,
      scenarioIndex: 0,
      allowInstalledDebugReuse: false,
    }),
    {
      launchMode: 'installed-debug-relaunch',
      source: 'cli-skip-prepare',
    },
  );
});

test('verify-windows-dev strategy allows scenarios to opt out of installed-debug reuse', () => {
  assert.deepEqual(
    resolveVerifyDevScenarioLaunchStrategy({
      skipPrepare: false,
      scenarioIndex: 2,
      allowInstalledDebugReuse: false,
    }),
    {
      launchMode: 'full-prepare',
      source: 'scenario-opt-out',
    },
  );
});
