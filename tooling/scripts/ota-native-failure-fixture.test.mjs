import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {createNativeOtaFailureFixture} from './ota-native-failure-fixture.mjs';

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

test('createNativeOtaFailureFixture writes an index and omits bundle-manifest.json for manifest 404 fixtures', async () => {
  const registryRoot = path.join(tmpdir(), `ota-native-failure-fixture-${Date.now()}-404`);
  try {
    const fixture = await createNativeOtaFailureFixture({
      mode: 'download-manifest-404',
      outDir: registryRoot,
    });

    const index = await readJson(path.join(registryRoot, 'index.json'));
    assert.equal(index.bundles['opapp.companion.main'].latestVersion, '9.9.9');
    await assert.rejects(readFile(fixture.manifestPath, 'utf8'));
  } finally {
    await rm(registryRoot, {recursive: true, force: true});
  }
});

test('createNativeOtaFailureFixture writes corrupt JSON for manifest-parse fixtures', async () => {
  const registryRoot = path.join(tmpdir(), `ota-native-failure-fixture-${Date.now()}-parse`);
  try {
    const fixture = await createNativeOtaFailureFixture({
      mode: 'manifest-parse',
      outDir: registryRoot,
    });

    await assert.rejects(readJson(fixture.manifestPath));
  } finally {
    await rm(registryRoot, {recursive: true, force: true});
  }
});

test('createNativeOtaFailureFixture writes checksum-mismatch manifests that do not match bundle bytes', async () => {
  const registryRoot = path.join(tmpdir(), `ota-native-failure-fixture-${Date.now()}-checksum`);
  try {
    const fixture = await createNativeOtaFailureFixture({
      mode: 'checksum-mismatch',
      outDir: registryRoot,
    });

    const manifest = await readJson(fixture.manifestPath);
    const bundleContents = await readFile(fixture.entryFilePath, 'utf8');
    const actualChecksum = createHash('sha256').update(bundleContents).digest('hex');

    assert.equal(manifest.checksum.algorithm, 'sha256');
    assert.notEqual(manifest.checksum.value, actualChecksum);
  } finally {
    await rm(registryRoot, {recursive: true, force: true});
  }
});
