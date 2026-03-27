import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyBundlePublishOverrides,
  mergeRegistryIndexes,
} from './ota-cloudflare-publish.mjs';

test('mergeRegistryIndexes unions versions and prefers local channel mapping', () => {
  const remote = {
    bundles: {
      'companion-app': {
        latestVersion: '0.1.0',
        versions: ['0.0.9', '0.1.0'],
        channels: {
          stable: '0.1.0',
          beta: '0.1.0-beta.1',
        },
        rolloutPercent: 20,
      },
    },
  };
  const local = {
    bundles: {
      'companion-app': {
        latestVersion: '0.1.1',
        versions: ['0.1.0', '0.1.1'],
        channels: {
          stable: '0.1.1',
        },
      },
    },
  };

  const merged = mergeRegistryIndexes(remote, local);
  const entry = merged.bundles['companion-app'];
  assert.deepEqual(entry.versions, ['0.0.9', '0.1.0', '0.1.1']);
  assert.equal(entry.latestVersion, '0.1.1');
  assert.deepEqual(entry.channels, {
    stable: '0.1.1',
    beta: '0.1.0-beta.1',
  });
  assert.equal(entry.rolloutPercent, 20);
});

test('applyBundlePublishOverrides removes rolloutPercent for full rollout', () => {
  const remote = {
    bundles: {
      'companion-app': {
        latestVersion: '0.1.0',
        versions: ['0.1.0'],
        rolloutPercent: 30,
      },
    },
  };
  const local = {
    bundles: {
      'companion-app': {
        latestVersion: '0.1.1',
        versions: ['0.1.1'],
        rolloutPercent: 100,
      },
    },
  };

  const merged = mergeRegistryIndexes(remote, local);
  const overridden = applyBundlePublishOverrides(merged, {
    bundleId: 'companion-app',
    version: '0.1.1',
    channel: 'stable',
    rolloutPercent: 100,
  });
  const entry = overridden.bundles['companion-app'];
  assert.equal(entry.latestVersion, '0.1.1');
  assert.equal('rolloutPercent' in entry, false);
  assert.equal(entry.channels.stable, '0.1.1');
});

test('mergeRegistryIndexes keeps remote-only bundles', () => {
  const remote = {
    bundles: {
      'companion-app': {
        latestVersion: '0.2.0',
        versions: ['0.2.0'],
      },
      'legacy-bundle': {
        latestVersion: '9.9.9',
        versions: ['9.9.9'],
      },
    },
  };
  const local = {
    bundles: {
      'companion-app': {
        latestVersion: '0.2.1',
        versions: ['0.2.1'],
      },
    },
  };

  const merged = mergeRegistryIndexes(remote, local);
  assert.equal(merged.bundles['legacy-bundle'].latestVersion, '9.9.9');
  assert.deepEqual(merged.bundles['legacy-bundle'].versions, ['9.9.9']);
});
