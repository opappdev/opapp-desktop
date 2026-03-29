import assert from 'node:assert/strict';
import test from 'node:test';

import {validateOtaLastRunRecord} from './windows-release-smoke.mjs';

function createBaseLastRun(overrides = {}) {
  return {
    mode: 'update',
    remoteBase: 'https://r2.opapp.dev',
    bundleId: 'opapp.companion.main',
    channel: 'stable',
    hasUpdate: true,
    deviceId: 'device-123',
    inRollout: true,
    rolloutPercent: 50,
    status: 'updated',
    currentVersion: '0.9.0',
    latestVersion: '1.0.0',
    version: '1.0.0',
    previousVersion: '0.9.0',
    stagedAt: '2026-03-29T01:23:45.000Z',
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
      hasUpdate: false,
      inRollout: false,
      version: undefined,
      previousVersion: undefined,
      stagedAt: undefined,
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

test('validateOtaLastRunRecord rejects up-to-date runs that claim staging metadata', () => {
  for (const field of ['previousVersion', 'stagedAt']) {
    assert.throws(
      () =>
        validateOtaLastRunRecord({
          otaLastRun: createBaseLastRun({
            status: 'up-to-date',
            version: undefined,
            [field]: 'unexpected',
          }),
          otaRemoteBase: 'https://r2.opapp.dev',
          loggedCurrentVersion: '0.9.0',
        }),
      /no update was applied/,
      `up-to-date run should not keep ${field}`,
    );
  }
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

test('validateOtaLastRunRecord rejects updated runs without stagedAt', () => {
  assert.throws(
    () =>
      validateOtaLastRunRecord({
        otaLastRun: createBaseLastRun({
          stagedAt: null,
        }),
        otaRemoteBase: 'https://r2.opapp.dev',
        loggedCurrentVersion: '0.9.0',
      }),
    /missing stagedAt/,
  );
});

test('validateOtaLastRunRecord rejects runs with inconsistent hasUpdate flags', () => {
  assert.throws(
    () =>
      validateOtaLastRunRecord({
        otaLastRun: createBaseLastRun({
          status: 'up-to-date',
          hasUpdate: true,
          version: undefined,
          previousVersion: undefined,
          stagedAt: undefined,
        }),
        otaRemoteBase: 'https://r2.opapp.dev',
        loggedCurrentVersion: '0.9.0',
      }),
    /hasUpdate=true even though no update was applied/,
  );

  assert.throws(
    () =>
      validateOtaLastRunRecord({
        otaLastRun: createBaseLastRun({
          hasUpdate: false,
        }),
        otaRemoteBase: 'https://r2.opapp.dev',
        loggedCurrentVersion: '0.9.0',
      }),
    /hasUpdate=false even though an update was applied/,
  );
});

test('validateOtaLastRunRecord rejects successful runs with missing resolved OTA metadata', () => {
  for (const [field, message] of [
    ['mode', /expected 'update'/],
    ['bundleId', /resolved bundleId/],
    ['channel', /resolved channel/],
    ['latestVersion', /resolved latestVersion/],
    ['hasUpdate', /boolean hasUpdate/],
  ]) {
    assert.throws(
      () =>
        validateOtaLastRunRecord({
          otaLastRun: createBaseLastRun({
            [field]: undefined,
          }),
          otaRemoteBase: 'https://r2.opapp.dev',
          loggedCurrentVersion: '0.9.0',
        }),
      message,
      `missing ${field} should fail validation`,
    );
  }
});
