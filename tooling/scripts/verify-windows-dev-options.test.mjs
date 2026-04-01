import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const verifyDevScriptPath = path.join(scriptDir, 'verify-windows-dev.mjs');

function runVerifyDevValidateOnly(args = []) {
  const result = spawnSync(
    process.execPath,
    [verifyDevScriptPath, '--validate-only', ...args],
    {
      stdio: 'ignore',
      windowsHide: true,
    },
  );
  if (result.error) {
    throw result.error;
  }
  return result;
}

test('verify-windows-dev validate-only accepts the default scenario set', () => {
  const result = runVerifyDevValidateOnly();

  assert.equal(result.status, 0);
});

test('verify-windows-dev validate-only accepts explicit view-shot scenario filters', () => {
  const result = runVerifyDevValidateOnly(['--scenario=view-shot-current-window']);

  assert.equal(result.status, 0);
});

test('verify-windows-dev validate-only accepts explicit companion chat scenario filters', () => {
  const result = runVerifyDevValidateOnly(['--scenario=companion-chat-current-window']);

  assert.equal(result.status, 0);
});

test('verify-windows-dev validate-only accepts explicit companion chat server-error scenario filters', () => {
  const result = runVerifyDevValidateOnly([
    '--scenario=companion-chat-current-window-server-error',
  ]);

  assert.equal(result.status, 0);
});

test('verify-windows-dev validate-only accepts explicit companion chat malformed-chunk scenario filters', () => {
  const result = runVerifyDevValidateOnly([
    '--scenario=companion-chat-current-window-malformed-chunk',
  ]);

  assert.equal(result.status, 0);
});

test('verify-windows-dev validate-only accepts comma-separated scenario filters', () => {
  const result = runVerifyDevValidateOnly([
    '--scenario=view-shot-current-window,companion-chat-current-window',
  ]);

  assert.equal(result.status, 0);
});

test('verify-windows-dev validate-only rejects unknown scenario filters', () => {
  const result = runVerifyDevValidateOnly(['--scenario=unknown']);

  assert.notEqual(result.status, 0);
});

test('verify-windows-dev validate-only rejects empty scenario filters', () => {
  const result = runVerifyDevValidateOnly(['--scenario=']);

  assert.notEqual(result.status, 0);
});

test('verify-windows-dev validate-only accepts positive timeout flags', () => {
  const result = runVerifyDevValidateOnly(['--readiness-ms=15000', '--smoke-ms=12000']);

  assert.equal(result.status, 0);
});
