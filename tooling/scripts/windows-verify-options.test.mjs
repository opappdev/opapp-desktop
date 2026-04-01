import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const verifyScriptPath = path.join(scriptDir, 'verify-windows.mjs');

function runVerifyValidateOnly(args = []) {
  const result = spawnSync(process.execPath, [verifyScriptPath, '--validate-only', ...args], {
    stdio: 'ignore',
    windowsHide: true,
  });
  if (result.error) {
    throw result.error;
  }
  return result;
}

function runVerifyPreflightOnly(args = []) {
  const result = spawnSync(process.execPath, [verifyScriptPath, '--preflight-only', ...args], {
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

test('verify-windows validate-only accepts supported single-scenario filters', () => {
  const result = runVerifyValidateOnly(['--scenario=view-shot-current-window']);

  assert.equal(result.status, 0);
});

test('verify-windows validate-only accepts companion chat scenario filter', () => {
  const result = runVerifyValidateOnly(['--scenario=companion-chat-current-window']);

  assert.equal(result.status, 0);
});

test('verify-windows validate-only accepts companion chat server-error scenario filter', () => {
  const result = runVerifyValidateOnly([
    '--scenario=companion-chat-current-window-server-error',
  ]);

  assert.equal(result.status, 0);
});

test('verify-windows validate-only accepts startup-target launcher scenario filter', () => {
  const result = runVerifyValidateOnly(['--scenario=startup-target-main-launcher']);

  assert.equal(result.status, 0);
});

test('verify-windows validate-only accepts launcher provenance scenario filter', () => {
  const result = runVerifyValidateOnly(['--scenario=launcher-provenance']);

  assert.equal(result.status, 0);
});

test('verify-windows validate-only accepts legacy startup-target launcher scenario filter', () => {
  const result = runVerifyValidateOnly(['--scenario=legacy-startup-target-main-launcher']);

  assert.equal(result.status, 0);
});

test('verify-windows validate-only accepts startup-target settings scenario filter', () => {
  const result = runVerifyValidateOnly(['--scenario=startup-target-settings']);

  assert.equal(result.status, 0);
});

test('verify-windows validate-only accepts comma-separated scenario filters', () => {
  const result = runVerifyValidateOnly(['--scenario=tab-session,companion-chat-current-window']);

  assert.equal(result.status, 0);
});

test('verify-windows validate-only rejects unknown scenario filters', () => {
  const result = runVerifyValidateOnly(['--scenario=unknown']);

  assert.notEqual(result.status, 0);
});

test('verify-windows validate-only rejects empty scenario filters', () => {
  const result = runVerifyValidateOnly(['--scenario=']);

  assert.notEqual(result.status, 0);
});

test('verify-windows validate-only rejects conflicting secondary-only and explicit scenario flags', () => {
  const result = runVerifyValidateOnly(['--include-secondary-window', '--scenario=tab-session']);

  assert.notEqual(result.status, 0);
});

test('verify-windows validate-only accepts positive smoke/readiness timeout flags', () => {
  const result = runVerifyValidateOnly(['--readiness-ms=15000', '--smoke-ms=12000']);

  assert.equal(result.status, 0);
});

test('verify-windows validate-only accepts positive startup/scenario timeout flags', () => {
  const result = runVerifyValidateOnly(['--startup-ms=9000', '--scenario-ms=12000']);

  assert.equal(result.status, 0);
});

test('verify-windows validate-only accepts timeout defaults file for packaged launch', () => {
  const result = withTimeoutDefaultsFile(
    {
      suggestedDefaults: [
        {
          launchMode: 'packaged',
          readinessMs: 31_000,
          smokeMs: 33_000,
          startupMs: 29_000,
          scenarioMs: 32_000,
          verifyTotalMs: 80_000,
        },
      ],
    },
    defaultsPath => runVerifyValidateOnly([`--timeout-defaults=${defaultsPath}`]),
  );

  assert.equal(result.status, 0);
});

test('verify-windows validate-only rejects missing timeout defaults file', () => {
  const missingPath = path.join(tmpdir(), 'opapp-timeout-defaults-missing.json');
  const result = runVerifyValidateOnly([`--timeout-defaults=${missingPath}`]);

  assert.notEqual(result.status, 0);
});

test('verify-windows validate-only rejects timeout defaults without matching launch entry', () => {
  const result = withTimeoutDefaultsFile(
    {
      suggestedDefaults: [
        {
          launchMode: 'portable',
          readinessMs: 26_000,
          smokeMs: 27_000,
          startupMs: 25_000,
          scenarioMs: 27_000,
        },
      ],
    },
    defaultsPath => runVerifyValidateOnly([`--timeout-defaults=${defaultsPath}`]),
  );

  assert.notEqual(result.status, 0);
});

test('verify-windows validate-only accepts launch=portable with launch=all timeout defaults', () => {
  const result = withTimeoutDefaultsFile(
    {
      suggestedDefaults: [
        {
          launchMode: 'all',
          readinessMs: 29_000,
          smokeMs: 30_000,
          startupMs: 28_000,
          scenarioMs: 30_000,
        },
      ],
    },
    defaultsPath =>
      runVerifyValidateOnly(['--launch=portable', `--timeout-defaults=${defaultsPath}`]),
  );

  assert.equal(result.status, 0);
});

test('verify-windows validate-only rejects duplicate timeout defaults flags', () => {
  const result = withTimeoutDefaultsFile(
    {
      suggestedDefaults: [
        {
          launchMode: 'packaged',
          readinessMs: 31_000,
        },
      ],
    },
    defaultsPath =>
      runVerifyValidateOnly([
        `--timeout-defaults=${defaultsPath}`,
        '--timeout-defaults=other.json',
      ]),
  );

  assert.notEqual(result.status, 0);
});

test('verify-windows validate-only accepts packaged launch mode explicitly', () => {
  const result = runVerifyValidateOnly(['--launch=packaged']);

  assert.equal(result.status, 0);
});

test('verify-windows validate-only accepts portable launch mode', () => {
  const result = runVerifyValidateOnly(['--launch=portable']);

  assert.equal(result.status, 0);
});

test('verify-windows validate-only accepts ota remote/channel/force/expected-status flags', () => {
  const result = runVerifyValidateOnly([
    '--ota-remote=https://r2.opapp.dev',
    '--ota-channel=nightly',
    '--ota-force',
    '--ota-expected-status=failed',
  ]);

  assert.equal(result.status, 0);
});

test('verify-windows validate-only rejects non-positive smoke timeout flags', () => {
  const result = runVerifyValidateOnly(['--smoke-ms=0']);

  assert.notEqual(result.status, 0);
});

test('verify-windows validate-only rejects ota channel without remote', () => {
  const result = runVerifyValidateOnly(['--ota-channel=nightly']);

  assert.notEqual(result.status, 0);
});

test('verify-windows validate-only rejects ota force without remote', () => {
  const result = runVerifyValidateOnly(['--ota-force']);

  assert.notEqual(result.status, 0);
});

test('verify-windows validate-only rejects ota expected status without remote', () => {
  const result = runVerifyValidateOnly(['--ota-expected-status=failed']);

  assert.notEqual(result.status, 0);
});

test('verify-windows validate-only rejects invalid ota expected status', () => {
  const result = runVerifyValidateOnly([
    '--ota-remote=https://r2.opapp.dev',
    '--ota-expected-status=broken',
  ]);

  assert.notEqual(result.status, 0);
});

test('verify-windows validate-only rejects non-positive startup timeout flags', () => {
  const result = runVerifyValidateOnly(['--startup-ms=0']);

  assert.notEqual(result.status, 0);
});

test('verify-windows validate-only rejects non-positive scenario timeout flags', () => {
  const result = runVerifyValidateOnly(['--scenario-ms=0']);

  assert.notEqual(result.status, 0);
});

test('verify-windows validate-only rejects unknown launch mode', () => {
  const result = runVerifyValidateOnly(['--launch=invalid']);

  assert.notEqual(result.status, 0);
});

test('verify-windows validate-only rejects conflicting --portable and --launch flags', () => {
  const result = runVerifyValidateOnly(['--portable', '--launch=packaged']);

  assert.notEqual(result.status, 0);
});

test('verify-windows validate-only rejects conflicting validate/preflight execution modes', () => {
  const result = runVerifyValidateOnly(['--preflight-only']);

  assert.notEqual(result.status, 0);
});

test('verify-windows preflight-only accepts packaged launch mode', () => {
  const result = runVerifyPreflightOnly(['--scenario=secondary-window']);

  assert.equal(result.status, 0);
});

test('verify-windows preflight-only accepts portable launch mode', () => {
  const result = runVerifyPreflightOnly(['--launch=portable', '--scenario=secondary-window']);

  assert.equal(result.status, 0);
});
