import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {access, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {generateRegistryIndex} from './artifact-source.mjs';
import {
  applyBundlePublishOverrides,
  deriveR2Endpoint,
  mergeRegistryIndexes,
  uploadFilesToCloudflare,
  uploadFilesToR2,
  upsertBundleSidecars,
  withFileRollback,
} from './ota-cloudflare-publish.mjs';

test('mergeRegistryIndexes unions versions, prefers local channel mapping, and drops stale pins', () => {
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

test('applyBundlePublishOverrides drops stale existing channel pins while adding the published version', () => {
  const current = {
    bundles: {
      'companion-app': {
        latestVersion: '0.1.0',
        versions: ['0.1.0'],
        channels: {
          stable: '0.1.0',
          beta: '9.9.9',
        },
      },
    },
  };

  const overridden = applyBundlePublishOverrides(current, {
    bundleId: 'companion-app',
    version: '0.1.1',
    channel: 'stable',
    rolloutPercent: 50,
  });
  assert.deepEqual(overridden.bundles['companion-app'].channels, {
    stable: '0.1.1',
  });
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

test('mergeRegistryIndexes drops stale channel pins from remote-only bundles', () => {
  const remote = {
    bundles: {
      'legacy-bundle': {
        latestVersion: '9.9.9',
        versions: ['9.9.9'],
        channels: {
          stable: '1.0.0',
          nightly: '9.9.9',
        },
      },
    },
  };

  const merged = mergeRegistryIndexes(remote, {bundles: {}});
  assert.deepEqual(merged.bundles['legacy-bundle'].channels, {
    nightly: '9.9.9',
  });
});

test('mergeRegistryIndexes treats explicit empty versions lists as authoritative and drops stale pins', () => {
  const remote = {
    bundles: {
      'legacy-bundle': {
        latestVersion: '9.9.9',
        versions: [],
        channels: {
          stable: '9.9.9',
        },
      },
    },
  };

  const merged = mergeRegistryIndexes(remote, {bundles: {}});
  assert.deepEqual(merged.bundles['legacy-bundle'], {
    latestVersion: null,
    versions: [],
  });
});

test('mergeRegistryIndexes preserves legacy latestVersion when versions are absent', () => {
  const remote = {
    bundles: {
      'legacy-bundle': {
        latestVersion: '9.9.9',
        channels: {
          stable: '9.9.9',
        },
      },
    },
  };

  const merged = mergeRegistryIndexes(remote, {bundles: {}});
  assert.deepEqual(merged.bundles['legacy-bundle'], {
    latestVersion: '9.9.9',
    versions: ['9.9.9'],
    channels: {
      stable: '9.9.9',
    },
  });
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

test('generateRegistryIndex drops channel pins for versions that are not present', async t => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'ota-index-channels-'));
  t.after(async () => {
    await rm(fixtureRoot, {recursive: true, force: true});
  });

  const bundleRoot = path.join(fixtureRoot, 'companion-app');
  await mkdir(path.join(bundleRoot, '0.1.0'), {recursive: true});
  await mkdir(path.join(bundleRoot, '0.2.0'), {recursive: true});
  await writeFile(
    path.join(bundleRoot, 'channels.json'),
    JSON.stringify({stable: '0.2.0', nightly: '9.9.9'}, null, 2) + '\n',
    'utf8',
  );

  const index = await generateRegistryIndex(fixtureRoot);
  assert.deepEqual(index.bundles['companion-app'].channels, {
    stable: '0.2.0',
  });
});

test('generateRegistryIndex drops all channel pins when no versions are present', async t => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'ota-index-empty-versions-'));
  t.after(async () => {
    await rm(fixtureRoot, {recursive: true, force: true});
  });

  const bundleRoot = path.join(fixtureRoot, 'companion-app');
  await mkdir(bundleRoot, {recursive: true});
  await writeFile(
    path.join(bundleRoot, 'channels.json'),
    JSON.stringify({stable: '9.9.9'}, null, 2) + '\n',
    'utf8',
  );

  const index = await generateRegistryIndex(fixtureRoot);
  assert.deepEqual(index.bundles['companion-app'], {
    latestVersion: null,
    versions: [],
  });
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

test('deriveR2Endpoint prefers explicit endpoint and derives jurisdiction-specific defaults', () => {
  assert.equal(
    deriveR2Endpoint({
      accountId: 'account-123',
      endpoint: 'https://custom.example.com',
      jurisdiction: 'eu',
    }),
    'https://custom.example.com',
  );
  assert.equal(
    deriveR2Endpoint({
      accountId: 'account-123',
      endpoint: null,
      jurisdiction: 'default',
    }),
    'https://account-123.r2.cloudflarestorage.com',
  );
  assert.equal(
    deriveR2Endpoint({
      accountId: 'account-123',
      endpoint: null,
      jurisdiction: 'eu',
    }),
    'https://account-123.eu.r2.cloudflarestorage.com',
  );
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

test('uploadFilesToR2 compensates by deleting uploaded keys when upload fails', async t => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'ota-cloudflare-publish-r2-'));
  t.after(async () => {
    await rm(fixtureRoot, {recursive: true, force: true});
  });

  const manifestPath = path.join(fixtureRoot, 'bundle-manifest.json');
  const bundlePath = path.join(fixtureRoot, 'main.hbc');
  const indexPath = path.join(fixtureRoot, 'index.json');
  await writeFile(manifestPath, '{"bundleId":"companion-app"}\n', 'utf8');
  await writeFile(bundlePath, 'bundle-bytes\n', 'utf8');
  await writeFile(indexPath, '{"bundles":{}}\n', 'utf8');

  const calls = [];
  const compensationEvents = [];
  const executeObjectRequest = async options => {
    calls.push({
      method: options.method,
      objectKey: options.objectKey,
    });
    if (options.method === 'PUT' && options.objectKey === 'registry/index.json') {
      throw new Error('simulated index upload failure');
    }
    return {ok: true, status: 200};
  };

  await assert.rejects(
    uploadFilesToR2({
      files: [
        {
          localPath: manifestPath,
          relativeRegistryPath: 'companion-app/0.2.0/windows/bundle-manifest.json',
        },
        {
          localPath: bundlePath,
          relativeRegistryPath: 'companion-app/0.2.0/windows/main.hbc',
        },
        {
          localPath: indexPath,
          relativeRegistryPath: 'index.json',
        },
      ],
      bucket: 'ota-bucket',
      objectPrefix: 'registry',
      r2Endpoint: 'https://account-123.r2.cloudflarestorage.com',
      r2AccessKeyId: 'AKIAEXAMPLE',
      r2SecretAccessKey: 'secret-example',
      dryRun: false,
      executeObjectRequest,
      reportCompensationEvent: event => {
        compensationEvents.push(event);
      },
    }),
    /simulated index upload failure/,
  );

  assert.deepEqual(calls, [
    {
      method: 'PUT',
      objectKey: 'registry/companion-app/0.2.0/windows/bundle-manifest.json',
    },
    {
      method: 'PUT',
      objectKey: 'registry/companion-app/0.2.0/windows/main.hbc',
    },
    {
      method: 'PUT',
      objectKey: 'registry/index.json',
    },
    {
      method: 'DELETE',
      objectKey: 'registry/companion-app/0.2.0/windows/main.hbc',
    },
    {
      method: 'DELETE',
      objectKey: 'registry/companion-app/0.2.0/windows/bundle-manifest.json',
    },
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
