import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {channelSet} from './registry-ops.mjs';

test('channelSet rejects versions that do not exist in the bundle registry directory', async t => {
  const registryRoot = await mkdtemp(path.join(os.tmpdir(), 'registry-ops-'));
  t.after(async () => {
    await rm(registryRoot, {recursive: true, force: true});
  });

  await mkdir(path.join(registryRoot, 'companion-app', '0.1.0'), {recursive: true});

  await assert.rejects(
    channelSet(registryRoot, 'companion-app', 'nightly', '9.9.9', false),
    /version '9\.9\.9' does not exist/,
  );
});

test('channelSet writes channels.json when the target version exists', async t => {
  const registryRoot = await mkdtemp(path.join(os.tmpdir(), 'registry-ops-'));
  t.after(async () => {
    await rm(registryRoot, {recursive: true, force: true});
  });

  const bundleRoot = path.join(registryRoot, 'companion-app');
  await mkdir(path.join(bundleRoot, '0.1.0'), {recursive: true});
  await mkdir(path.join(bundleRoot, '0.2.0'), {recursive: true});
  await writeFile(
    path.join(bundleRoot, 'channels.json'),
    JSON.stringify({stable: '0.1.0'}, null, 2) + '\n',
    'utf8',
  );

  const result = await channelSet(registryRoot, 'companion-app', 'nightly', '0.2.0', false);
  assert.deepEqual(result.channels, {
    stable: '0.1.0',
    nightly: '0.2.0',
  });

  const persisted = JSON.parse(await readFile(path.join(bundleRoot, 'channels.json'), 'utf8'));
  assert.deepEqual(persisted, {
    stable: '0.1.0',
    nightly: '0.2.0',
  });
});
