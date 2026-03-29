import assert from 'node:assert/strict';
import test from 'node:test';

import {validateOtaLastRunRecord} from './windows-release-smoke.mjs';

function createBaseLastRun(overrides = {}) {
  return {
    remoteBase: 'https://r2.opapp.dev',
    deviceId: 'device-123',
    inRollout: true,
    rolloutPercent: 50,
    status: 'updated',
    currentVersion: '0.9.0',
    latestVersion: '1.0.0',
    version: '1.0.0',
    ...overrides,
  };
}

test('validateOtaLastRunRecord accepts updated runs with a staged version', () => {
  const result = validateOtaLastRunRecord({
    otaLastRun: createBaseLastRun(),
    otaRemoteBase: 'https://r2.opapp.dev',
    loggedCurrentVersion: '0.9.0',
  });

  assert.deepEqual(result, {requiresOtaState: true, status: 'updated'});
});

test('validateOtaLastRunRecord accepts up-to-date runs without a staged version', () => {
  const result = validateOtaLastRunRecord({
    otaLastRun: createBaseLastRun({
      status: 'up-to-date',
      inRollout: false,
      version: undefined,
    }),
    otaRemoteBase: 'https://r2.opapp.dev',
    loggedCurrentVersion: '0.9.0',
  });

  assert.deepEqual(result, {requiresOtaState: false, status: 'up-to-date'});
});

test('validateOtaLastRunRecord rejects up-to-date runs that claim a staged version', () => {
  assert.throws(
    () =>
      validateOtaLastRunRecord({
        otaLastRun: createBaseLastRun({
          status: 'up-to-date',
          version: '1.0.0',
        }),
        otaRemoteBase: 'https://r2.opapp.dev',
        loggedCurrentVersion: '0.9.0',
      }),
    /no update was applied/,
  );
});

test('validateOtaLastRunRecord rejects updated runs without a staged version', () => {
  assert.throws(
    () =>
      validateOtaLastRunRecord({
        otaLastRun: createBaseLastRun({
          version: null,
        }),
        otaRemoteBase: 'https://r2.opapp.dev',
        loggedCurrentVersion: '0.9.0',
      }),
    /missing the staged version/,
  );
});
