import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildOtaFailedLastRunRecord,
  buildOtaUpToDateLastRunRecord,
  buildOtaUpdateLastRunRecord,
} from './ota-updater.mjs';

test('buildOtaUpdateLastRunRecord preserves rollout and channel context', () => {
  const record = buildOtaUpdateLastRunRecord(
    {
      bundleId: 'opapp.companion.main',
      channel: 'nightly',
      currentVersion: '0.9.0',
      latestVersion: '1.0.0',
      deviceId: 'device-123',
      inRollout: true,
      rolloutPercent: 25,
      channels: {
        stable: '0.9.0',
        nightly: '1.0.0',
      },
    },
    {
      bundleId: 'opapp.companion.main',
      version: '1.0.0',
      stagedAt: '2026-03-29T00:00:00.000Z',
    },
  );

  assert.deepEqual(record, {
    hasUpdate: true,
    status: 'updated',
    bundleId: 'opapp.companion.main',
    channel: 'nightly',
    currentVersion: '0.9.0',
    latestVersion: '1.0.0',
    version: '1.0.0',
    previousVersion: '0.9.0',
    stagedAt: '2026-03-29T00:00:00.000Z',
    deviceId: 'device-123',
    inRollout: true,
    rolloutPercent: 25,
    channels: {
      stable: '0.9.0',
      nightly: '1.0.0',
    },
  });
});

test('buildOtaUpdateLastRunRecord omits optional rollout metadata when absent', () => {
  const record = buildOtaUpdateLastRunRecord(
    {
      bundleId: 'opapp.companion.main',
      channel: 'stable',
      currentVersion: null,
      latestVersion: '1.0.0',
      deviceId: 'device-456',
      inRollout: false,
    },
    {
      version: '1.0.0',
      stagedAt: '2026-03-29T01:00:00.000Z',
    },
  );

  assert.equal(record.rolloutPercent, undefined);
  assert.equal(record.channels, undefined);
  assert.equal(record.bundleId, 'opapp.companion.main');
  assert.equal(record.previousVersion, null);
  assert.equal(record.inRollout, false);
  assert.equal(record.hasUpdate, true);
});

test('buildOtaUpToDateLastRunRecord keeps check metadata without inventing a staged version', () => {
  const record = buildOtaUpToDateLastRunRecord({
    hasUpdate: false,
    inRollout: false,
    rolloutPercent: 25,
    deviceId: 'device-789',
    currentVersion: '0.9.0',
    latestVersion: '1.0.0',
    bundleId: 'opapp.companion.main',
    channel: 'nightly',
    channels: {
      stable: '0.9.0',
      nightly: '1.0.0',
    },
  });

  assert.deepEqual(record, {
    status: 'up-to-date',
    hasUpdate: false,
    inRollout: false,
    rolloutPercent: 25,
    deviceId: 'device-789',
    currentVersion: '0.9.0',
    latestVersion: '1.0.0',
    bundleId: 'opapp.companion.main',
    channel: 'nightly',
    channels: {
      stable: '0.9.0',
      nightly: '1.0.0',
    },
  });
  assert.equal(record.version, undefined);
});

test('buildOtaFailedLastRunRecord preserves resolved update metadata for diagnostics', () => {
  const record = buildOtaFailedLastRunRecord({
    hasUpdate: true,
    bundleId: 'opapp.companion.main',
    channel: 'nightly',
    currentVersion: '0.9.0',
    latestVersion: '1.0.0',
    deviceId: 'device-321',
    inRollout: true,
    rolloutPercent: 25,
    channels: {
      stable: '0.9.0',
      nightly: '1.0.0',
    },
  });

  assert.deepEqual(record, {
    status: 'failed',
    hasUpdate: true,
    bundleId: 'opapp.companion.main',
    channel: 'nightly',
    currentVersion: '0.9.0',
    latestVersion: '1.0.0',
    deviceId: 'device-321',
    inRollout: true,
    rolloutPercent: 25,
    channels: {
      stable: '0.9.0',
      nightly: '1.0.0',
    },
  });
});

test('buildOtaFailedLastRunRecord omits undefined staging-only fields', () => {
  const record = buildOtaFailedLastRunRecord({
    bundleId: 'opapp.companion.main',
    currentVersion: null,
    latestVersion: '1.0.0',
    hasUpdate: false,
    version: '1.0.0',
    stagedAt: '2026-03-29T02:00:00.000Z',
  });

  assert.deepEqual(record, {
    status: 'failed',
    bundleId: 'opapp.companion.main',
    currentVersion: null,
    latestVersion: '1.0.0',
    hasUpdate: false,
  });
  assert.equal(record.version, undefined);
  assert.equal(record.stagedAt, undefined);
});
