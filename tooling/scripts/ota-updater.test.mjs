import assert from 'node:assert/strict';
import test from 'node:test';

import {buildOtaUpdateLastRunRecord} from './ota-updater.mjs';

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
});
