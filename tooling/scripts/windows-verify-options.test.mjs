import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
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

test('verify-windows validate-only accepts supported single-scenario filters', () => {
  const result = runVerifyValidateOnly(['--scenario=secondary-window']);

  assert.equal(result.status, 0);
});

test('verify-windows validate-only accepts comma-separated scenario filters', () => {
  const result = runVerifyValidateOnly(['--scenario=tab-session,secondary-window']);

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

test('verify-windows validate-only accepts packaged launch mode explicitly', () => {
  const result = runVerifyValidateOnly(['--launch=packaged']);

  assert.equal(result.status, 0);
});

test('verify-windows validate-only accepts portable launch mode', () => {
  const result = runVerifyValidateOnly(['--launch=portable']);

  assert.equal(result.status, 0);
});

test('verify-windows validate-only rejects non-positive smoke timeout flags', () => {
  const result = runVerifyValidateOnly(['--smoke-ms=0']);

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
