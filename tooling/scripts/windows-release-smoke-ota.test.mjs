import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveExpectedOtaLatestVersion,
  validateOtaLastRunRecord,
} from './windows-release-smoke.mjs';

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

function createFailedLastRun(overrides = {}) {
  return createBaseLastRun({
    status: 'failed',
    version: undefined,
    previousVersion: undefined,
    stagedAt: undefined,
    ...overrides,
  });
}

test('validateOtaLastRunRecord accepts updated runs with a staged version', () => {
  const result = validateOtaLastRunRecord({
    otaLastRun: createBaseLastRun(),
    otaRemoteBase: 'https://r2.opapp.dev',
    loggedCurrentVersion: '0.9.0',
    expectedLatestVersion: '1.0.0',
  });

  assert.deepEqual(result, {requiresOtaState: true, status: 'updated'});
});

test('validateOtaLastRunRecord accepts remote channels when last-run preserves them verbatim', () => {
  const result = validateOtaLastRunRecord({
    otaLastRun: createBaseLastRun({
      channels: {
        stable: '0.9.0',
        beta: '1.0.0',
      },
    }),
    otaRemoteBase: 'https://r2.opapp.dev',
    loggedCurrentVersion: '0.9.0',
    expectedChannels: {
      beta: '1.0.0',
      stable: '0.9.0',
    },
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

test('validateOtaLastRunRecord accepts explicit updated status expectations', () => {
  const result = validateOtaLastRunRecord({
    otaLastRun: createBaseLastRun(),
    otaRemoteBase: 'https://r2.opapp.dev',
    loggedCurrentVersion: '0.9.0',
    expectedStatus: 'updated',
  });

  assert.deepEqual(result, {requiresOtaState: true, status: 'updated'});
});

test('validateOtaLastRunRecord accepts explicit up-to-date status expectations', () => {
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
    expectedStatus: 'up-to-date',
  });

  assert.deepEqual(result, {requiresOtaState: false, status: 'up-to-date'});
});

test('validateOtaLastRunRecord accepts failed runs with preserved remote metadata', () => {
  const result = validateOtaLastRunRecord({
    otaLastRun: createFailedLastRun({
      channels: {
        stable: '0.9.0',
        beta: '1.0.0',
      },
    }),
    otaRemoteBase: 'https://r2.opapp.dev',
    loggedCurrentVersion: '0.9.0',
    expectedChannels: {
      beta: '1.0.0',
      stable: '0.9.0',
    },
    expectedLatestVersion: '1.0.0',
    expectedStatus: 'failed',
  });

  assert.deepEqual(result, {requiresOtaState: false, status: 'failed'});
});

test('validateOtaLastRunRecord accepts failed runs before bundle metadata is resolved', () => {
  const result = validateOtaLastRunRecord({
    otaLastRun: createFailedLastRun({
      bundleId: undefined,
      latestVersion: undefined,
      deviceId: undefined,
      hasUpdate: undefined,
      inRollout: undefined,
      rolloutPercent: undefined,
      channels: undefined,
    }),
    otaRemoteBase: 'https://r2.opapp.dev',
    loggedCurrentVersion: '0.9.0',
    expectedStatus: 'failed',
  });

  assert.deepEqual(result, {requiresOtaState: false, status: 'failed'});
});

test('resolveExpectedOtaLatestVersion prefers channel pins, then stable fallback, then versions[]', () => {
  assert.equal(
    resolveExpectedOtaLatestVersion({
      bundleInfo: {
        versions: ['0.9.0', '1.0.0'],
        latestVersion: '1.0.0',
        channels: {
          stable: '0.9.0',
          beta: '1.0.0',
        },
      },
      channel: 'beta',
    }),
    '1.0.0',
  );

  assert.equal(
    resolveExpectedOtaLatestVersion({
      bundleInfo: {
        versions: ['0.9.0', '1.0.0'],
        latestVersion: '1.0.0',
        channels: {
          stable: '0.9.0',
          nightly: '9.9.9',
        },
      },
      channel: 'nightly',
    }),
    '0.9.0',
  );

  assert.equal(
    resolveExpectedOtaLatestVersion({
      bundleInfo: {
        versions: ['0.9.0', '1.0.0'],
        latestVersion: '1.0.0',
      },
      channel: 'stable',
    }),
    '1.0.0',
  );
});

test('validateOtaLastRunRecord rejects explicit updated status expectations when no update was applied', () => {
  assert.throws(
    () =>
      validateOtaLastRunRecord({
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
        expectedStatus: 'updated',
      }),
    /expected 'updated'/,
  );
});

test('validateOtaLastRunRecord rejects runs that drop remote channels metadata', () => {
  assert.throws(
    () =>
      validateOtaLastRunRecord({
        otaLastRun: createBaseLastRun(),
        otaRemoteBase: 'https://r2.opapp.dev',
        loggedCurrentVersion: '0.9.0',
        expectedChannels: {
          stable: '0.9.0',
          beta: '1.0.0',
        },
      }),
    /missing the remote channels map/,
  );
});

test('validateOtaLastRunRecord rejects failed runs that keep staged metadata', () => {
  for (const field of ['version', 'previousVersion', 'stagedAt']) {
    assert.throws(
      () =>
        validateOtaLastRunRecord({
          otaLastRun: createFailedLastRun({
            [field]: 'unexpected',
          }),
          otaRemoteBase: 'https://r2.opapp.dev',
          loggedCurrentVersion: '0.9.0',
          expectedStatus: 'failed',
        }),
      /must not report staged/,
      `failed run should not keep ${field}`,
    );
  }
});

test('validateOtaLastRunRecord rejects failed runs that drop the resolved channel', () => {
  assert.throws(
    () =>
      validateOtaLastRunRecord({
        otaLastRun: createFailedLastRun({
          channel: undefined,
        }),
        otaRemoteBase: 'https://r2.opapp.dev',
        loggedCurrentVersion: '0.9.0',
        expectedStatus: 'failed',
      }),
    /missing the resolved channel/,
  );
});

test('validateOtaLastRunRecord rejects failed runs that drop currentVersion after the host logged it', () => {
  assert.throws(
    () =>
      validateOtaLastRunRecord({
        otaLastRun: createFailedLastRun({
          currentVersion: undefined,
        }),
        otaRemoteBase: 'https://r2.opapp.dev',
        loggedCurrentVersion: '0.9.0',
        expectedStatus: 'failed',
      }),
    /missing currentVersion even though the host logged it/,
  );
});

test('validateOtaLastRunRecord rejects failed runs that drop bundleId after remote resolution', () => {
  assert.throws(
    () =>
      validateOtaLastRunRecord({
        otaLastRun: createFailedLastRun({
          bundleId: undefined,
        }),
        otaRemoteBase: 'https://r2.opapp.dev',
        loggedCurrentVersion: '0.9.0',
        expectedLatestVersion: '1.0.0',
        expectedStatus: 'failed',
      }),
    /missing the resolved bundleId after remote resolution/,
  );
});

test('validateOtaLastRunRecord rejects failed runs that drop resolved latestVersion after remote resolution', () => {
  assert.throws(
    () =>
      validateOtaLastRunRecord({
        otaLastRun: createFailedLastRun({
          latestVersion: undefined,
        }),
        otaRemoteBase: 'https://r2.opapp.dev',
        loggedCurrentVersion: '0.9.0',
        expectedLatestVersion: '1.0.0',
        expectedStatus: 'failed',
      }),
    /missing the resolved latestVersion after remote resolution/,
  );
});

test('validateOtaLastRunRecord rejects failed runs that drop resolved remote channels metadata', () => {
  assert.throws(
    () =>
      validateOtaLastRunRecord({
        otaLastRun: createFailedLastRun(),
        otaRemoteBase: 'https://r2.opapp.dev',
        loggedCurrentVersion: '0.9.0',
        expectedChannels: {
          stable: '0.9.0',
          beta: '1.0.0',
        },
        expectedStatus: 'failed',
      }),
    /failed ota last-run is missing the remote channels map/,
  );
});

test('validateOtaLastRunRecord rejects runs with mismatched remote channels metadata', () => {
  assert.throws(
    () =>
      validateOtaLastRunRecord({
        otaLastRun: createBaseLastRun({
          channels: {
            stable: '0.9.0',
            beta: '1.1.0',
          },
        }),
        otaRemoteBase: 'https://r2.opapp.dev',
        loggedCurrentVersion: '0.9.0',
        expectedChannels: {
          stable: '0.9.0',
          beta: '1.0.0',
        },
      }),
    /did not match remote index channels/,
  );
});

test('validateOtaLastRunRecord rejects runs with mismatched resolved latestVersion', () => {
  assert.throws(
    () =>
      validateOtaLastRunRecord({
        otaLastRun: createBaseLastRun({
          latestVersion: '1.1.0',
        }),
        otaRemoteBase: 'https://r2.opapp.dev',
        loggedCurrentVersion: '0.9.0',
        expectedLatestVersion: '1.0.0',
      }),
    /did not match the remote index resolved version/,
  );
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
