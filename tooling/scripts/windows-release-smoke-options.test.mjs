import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const smokeScriptPath = path.join(scriptDir, 'windows-release-smoke.mjs');

function runSmokeValidateOnly(args = []) {
  const result = spawnSync(process.execPath, [smokeScriptPath, '--validate-only', ...args], {
    stdio: 'ignore',
    windowsHide: true,
  });
  if (result.error) {
    throw result.error;
  }
  return result;
}

function runSmokePreflightOnly(args = []) {
  const result = spawnSync(process.execPath, [smokeScriptPath, '--preflight-only', ...args], {
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...process.env,
      OPAPP_WINDOWS_RELEASE_SKIP_PREFLIGHT_FAILFAST: '1',
    },
  });
  if (result.error) {
    throw result.error;
  }
  return result;
}

function withTimeoutDefaultsFile(content, run) {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'opapp-timeout-defaults-'));
  const defaultsPath = path.join(tempDir, 'timeout-defaults.json');
  writeFileSync(defaultsPath, JSON.stringify(content), 'utf8');
  try {
    return run(defaultsPath);
  } finally {
    rmSync(tempDir, {force: true, recursive: true});
  }
}

test('windows-release-smoke validate-only accepts default scenario', () => {
  const result = runSmokeValidateOnly();

  assert.equal(result.status, 0);
});

test('windows-release-smoke validate-only accepts explicit secondary-window portable launch', () => {
  const result = runSmokeValidateOnly(['--scenario=secondary-window', '--launch=portable']);

  assert.equal(result.status, 0);
});

test('windows-release-smoke validate-only accepts --portable with --launch=portable', () => {
  const result = runSmokeValidateOnly(['--portable', '--launch=portable']);

  assert.equal(result.status, 0);
});

test('windows-release-smoke validate-only rejects unknown scenario', () => {
  const result = runSmokeValidateOnly(['--scenario=unknown']);

  assert.notEqual(result.status, 0);
});

test('windows-release-smoke validate-only rejects empty scenario', () => {
  const result = runSmokeValidateOnly(['--scenario=']);

  assert.notEqual(result.status, 0);
});

test('windows-release-smoke validate-only rejects multi-scenario filters', () => {
  const result = runSmokeValidateOnly(['--scenario=tab-session,secondary-window']);

  assert.notEqual(result.status, 0);
});

test('windows-release-smoke validate-only rejects conflicting secondary-only and explicit scenario flags', () => {
  const result = runSmokeValidateOnly(['--include-secondary-window', '--scenario=tab-session']);

  assert.notEqual(result.status, 0);
});

test('windows-release-smoke validate-only rejects unknown launch mode', () => {
  const result = runSmokeValidateOnly(['--launch=invalid']);

  assert.notEqual(result.status, 0);
});

test('windows-release-smoke validate-only rejects conflicting --portable and --launch flags', () => {
  const result = runSmokeValidateOnly(['--portable', '--launch=packaged']);

  assert.notEqual(result.status, 0);
});

test('windows-release-smoke validate-only rejects conflicting validate/preflight execution modes', () => {
  const result = spawnSync(process.execPath, [smokeScriptPath, '--validate-only', '--preflight-only'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  if (result.error) {
    throw result.error;
  }

  assert.notEqual(result.status, 0);
});

test('windows-release-smoke preflight-only runs release probe without bundle/build', () => {
  const result = runSmokePreflightOnly(['--scenario=tab-session']);

  assert.equal(result.status, 0);
});

test('windows-release-smoke validate-only accepts positive readiness/smoke/startup/scenario timeouts', () => {
  const result = runSmokeValidateOnly([
    '--readiness-ms=15000',
    '--smoke-ms=14000',
    '--startup-ms=13000',
    '--scenario-ms=12000',
  ]);

  assert.equal(result.status, 0);
});

test('windows-release-smoke validate-only accepts timeout defaults file', () => {
  const result = withTimeoutDefaultsFile(
    {
      suggestedDefaults: [
        {
          launchMode: 'packaged',
          readinessMs: 30_000,
          smokeMs: 30_000,
          startupMs: 28_000,
          scenarioMs: 30_000,
          verifyTotalMs: 75_000,
        },
      ],
    },
    defaultsPath => runSmokeValidateOnly([`--timeout-defaults=${defaultsPath}`]),
  );

  assert.equal(result.status, 0);
});

test('windows-release-smoke validate-only rejects missing timeout defaults file', () => {
  const missingPath = path.join(tmpdir(), 'opapp-timeout-defaults-smoke-missing.json');
  const result = runSmokeValidateOnly([`--timeout-defaults=${missingPath}`]);

  assert.notEqual(result.status, 0);
});

test('windows-release-smoke validate-only accepts launch=portable with launch=all timeout defaults', () => {
  const result = withTimeoutDefaultsFile(
    {
      suggestedDefaults: [
        {
          launchMode: 'all',
          readinessMs: 30_000,
          smokeMs: 30_000,
          startupMs: 29_000,
          scenarioMs: 30_000,
        },
      ],
    },
    defaultsPath =>
      runSmokeValidateOnly(['--launch=portable', `--timeout-defaults=${defaultsPath}`]),
  );

  assert.equal(result.status, 0);
});

test('windows-release-smoke validate-only rejects duplicate timeout defaults flags', () => {
  const result = withTimeoutDefaultsFile(
    {
      suggestedDefaults: [
        {
          launchMode: 'packaged',
          readinessMs: 30_000,
        },
      ],
    },
    defaultsPath =>
      runSmokeValidateOnly([
        `--timeout-defaults=${defaultsPath}`,
        '--timeout-defaults=other.json',
      ]),
  );

  assert.notEqual(result.status, 0);
});

test('windows-release-smoke validate-only rejects non-positive readiness timeout', () => {
  const result = runSmokeValidateOnly(['--readiness-ms=0']);

  assert.notEqual(result.status, 0);
});

test('windows-release-smoke validate-only rejects non-positive smoke timeout', () => {
  const result = runSmokeValidateOnly(['--smoke-ms=0']);

  assert.notEqual(result.status, 0);
});

test('windows-release-smoke validate-only rejects non-positive startup timeout', () => {
  const result = runSmokeValidateOnly(['--startup-ms=0']);

  assert.notEqual(result.status, 0);
});

test('windows-release-smoke validate-only rejects non-positive scenario timeout', () => {
  const result = runSmokeValidateOnly(['--scenario-ms=0']);

  assert.notEqual(result.status, 0);
});
