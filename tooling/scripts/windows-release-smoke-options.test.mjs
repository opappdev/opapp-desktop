import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
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

test('windows-release-smoke validate-only rejects non-positive scenario timeout', () => {
  const result = runSmokeValidateOnly(['--scenario-ms=0']);

  assert.notEqual(result.status, 0);
});
