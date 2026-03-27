import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {access, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {
  applyBundlePublishOverrides,
  mergeRegistryIndexes,
  uploadFilesToCloudflare,
  upsertBundleSidecars,
  withFileRollback,
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

test('upsertBundleSidecars writes channels and removes rollout for 100%', async t => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'ota-cloudflare-publish-'));
  t.after(async () => {
    await rm(fixtureRoot, {recursive: true, force: true});
  });

  const bundleId = 'companion-app';
  const bundleRoot = path.join(fixtureRoot, bundleId);
  const channelsPath = path.join(bundleRoot, 'channels.json');
  const rolloutPath = path.join(bundleRoot, 'rollout.json');

  await upsertBundleSidecars(fixtureRoot, bundleId, 'beta', '0.2.0', 35);

  const firstChannels = JSON.parse(await readFile(channelsPath, 'utf8'));
  const firstRollout = JSON.parse(await readFile(rolloutPath, 'utf8'));
  assert.deepEqual(firstChannels, {beta: '0.2.0'});
  assert.equal(firstRollout.percent, 35);
  assert.equal(typeof firstRollout.updatedAt, 'string');

  await upsertBundleSidecars(fixtureRoot, bundleId, 'stable', '0.2.1', 100);

  const secondChannels = JSON.parse(await readFile(channelsPath, 'utf8'));
  assert.deepEqual(secondChannels, {
    beta: '0.2.0',
    stable: '0.2.1',
  });
  await assert.rejects(access(rolloutPath));
});

test('withFileRollback restores sidecar snapshots after failure', async t => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'ota-cloudflare-publish-rollback-'));
  t.after(async () => {
    await rm(fixtureRoot, {recursive: true, force: true});
  });

  const bundleRoot = path.join(fixtureRoot, 'companion-app');
  const channelsPath = path.join(bundleRoot, 'channels.json');
  const rolloutPath = path.join(bundleRoot, 'rollout.json');

  await mkdir(bundleRoot, {recursive: true});
  await writeFile(channelsPath, JSON.stringify({stable: '0.1.0'}, null, 2) + '\n', 'utf8');
  await writeFile(rolloutPath, JSON.stringify({percent: 20}, null, 2) + '\n', 'utf8');

  await assert.rejects(
    withFileRollback([channelsPath, rolloutPath], async () => {
      await writeFile(channelsPath, JSON.stringify({stable: '0.2.0'}, null, 2) + '\n', 'utf8');
      await rm(rolloutPath, {force: true});
      throw new Error('simulated sidecar write failure');
    }),
  );

  const restoredChannels = JSON.parse(await readFile(channelsPath, 'utf8'));
  const restoredRollout = JSON.parse(await readFile(rolloutPath, 'utf8'));
  assert.deepEqual(restoredChannels, {stable: '0.1.0'});
  assert.deepEqual(restoredRollout, {percent: 20});
});

test('uploadFilesToCloudflare compensates by deleting uploaded keys when upload fails', async () => {
  const calls = [];
  const compensationEvents = [];
  const executeCommand = async (_command, args) => {
    calls.push(args);
    if (args.includes('put') && args.some(value => String(value).includes('index.json'))) {
      throw new Error('simulated index upload failure');
    }
    return {code: 0};
  };

  await assert.rejects(
    uploadFilesToCloudflare({
      files: [
        {
          localPath: 'C:/tmp/bundle-manifest.json',
          relativeRegistryPath: 'companion-app/0.2.0/windows/bundle-manifest.json',
        },
        {
          localPath: 'C:/tmp/main.hbc',
          relativeRegistryPath: 'companion-app/0.2.0/windows/main.hbc',
        },
        {
          localPath: 'C:/tmp/index.json',
          relativeRegistryPath: 'index.json',
        },
      ],
      bucket: 'ota-bucket',
      objectPrefix: 'registry',
      wranglerBin: 'wrangler',
      wranglerConfig: null,
      dryRun: false,
      executeCommand,
      reportCompensationEvent: event => {
        compensationEvents.push(event);
      },
    }),
    /simulated index upload failure/,
  );

  const commandTuples = calls.map(args => [args[2], args[3]]);
  assert.deepEqual(commandTuples, [
    ['put', 'ota-bucket/registry/companion-app/0.2.0/windows/bundle-manifest.json'],
    ['put', 'ota-bucket/registry/companion-app/0.2.0/windows/main.hbc'],
    ['put', 'ota-bucket/registry/index.json'],
    ['delete', 'ota-bucket/registry/companion-app/0.2.0/windows/main.hbc'],
    ['delete', 'ota-bucket/registry/companion-app/0.2.0/windows/bundle-manifest.json'],
  ]);
  assert.deepEqual(compensationEvents, [
    {
      phase: 'cleanup-start',
      uploadError: 'simulated index upload failure',
      attemptedDeletes: 2,
    },
    {
      phase: 'cleanup-delete',
      objectKey: 'registry/companion-app/0.2.0/windows/main.hbc',
      status: 'deleted',
    },
    {
      phase: 'cleanup-delete',
      objectKey: 'registry/companion-app/0.2.0/windows/bundle-manifest.json',
      status: 'deleted',
    },
    {
      phase: 'cleanup-summary',
      attemptedDeletes: 2,
      cleanedCount: 2,
      failedCount: 0,
    },
  ]);
});

test('uploadFilesToCloudflare reports cleanup failures when delete compensation fails', async () => {
  const calls = [];
  const compensationEvents = [];
  const executeCommand = async (_command, args) => {
    calls.push(args);
    if (args[2] === 'put' && args[3] === 'ota-bucket/registry/index.json') {
      throw new Error('simulated put failure');
    }
    if (args[2] === 'delete') {
      throw new Error(`simulated delete failure for ${args[3]}`);
    }
    return {code: 0};
  };

  await assert.rejects(
    uploadFilesToCloudflare({
      files: [
        {
          localPath: 'C:/tmp/main.hbc',
          relativeRegistryPath: 'companion-app/0.2.0/windows/main.hbc',
        },
        {
          localPath: 'C:/tmp/index.json',
          relativeRegistryPath: 'index.json',
        },
      ],
      bucket: 'ota-bucket',
      objectPrefix: 'registry',
      wranglerBin: 'wrangler',
      wranglerConfig: null,
      dryRun: false,
      executeCommand,
      reportCompensationEvent: event => {
        compensationEvents.push(event);
      },
    }),
    /upload failed and cleanup was partial/,
  );

  assert.ok(
    calls.some(args => args[2] === 'delete' && args[3] === 'ota-bucket/registry/companion-app/0.2.0/windows/main.hbc'),
  );
  assert.deepEqual(compensationEvents, [
    {
      phase: 'cleanup-start',
      uploadError: 'simulated put failure',
      attemptedDeletes: 1,
    },
    {
      phase: 'cleanup-delete',
      objectKey: 'registry/companion-app/0.2.0/windows/main.hbc',
      status: 'failed',
      message: 'simulated delete failure for ota-bucket/registry/companion-app/0.2.0/windows/main.hbc',
    },
    {
      phase: 'cleanup-summary',
      attemptedDeletes: 1,
      cleanedCount: 0,
      failedCount: 1,
    },
  ]);
});

test('uploadFilesToCloudflare rethrows original upload error when nothing was uploaded', async () => {
  const calls = [];
  const compensationEvents = [];
  const executeCommand = async (_command, args) => {
    calls.push(args);
    throw new Error('simulated first upload failure');
  };

  await assert.rejects(
    uploadFilesToCloudflare({
      files: [
        {
          localPath: 'C:/tmp/bundle-manifest.json',
          relativeRegistryPath: 'companion-app/0.2.0/windows/bundle-manifest.json',
        },
      ],
      bucket: 'ota-bucket',
      objectPrefix: 'registry',
      wranglerBin: 'wrangler',
      wranglerConfig: null,
      dryRun: false,
      executeCommand,
      reportCompensationEvent: event => {
        compensationEvents.push(event);
      },
    }),
    /simulated first upload failure/,
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0][2], 'put');
  assert.deepEqual(compensationEvents, [
    {
      phase: 'cleanup-start',
      uploadError: 'simulated first upload failure',
      attemptedDeletes: 0,
    },
    {
      phase: 'cleanup-summary',
      attemptedDeletes: 0,
      cleanedCount: 0,
      failedCount: 0,
    },
  ]);
});
