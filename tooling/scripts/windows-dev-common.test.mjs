import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  classifyDeterministicCommandFailure,
  detectDeterministicCommandFailureFromHost,
  resolveHostCommandOutputPath,
  resolveOutputCaptureCandidates,
} from './windows-dev-common.mjs';

test('resolveOutputCaptureCandidates returns an empty list when no path is provided', () => {
  assert.deepEqual(resolveOutputCaptureCandidates(null), []);
  assert.deepEqual(resolveOutputCaptureCandidates(''), []);
});

test('resolveOutputCaptureCandidates appends tmp-dir fallback path based on filename', () => {
  const requestedPath = 'D:\\code\\opappdev\\.tmp\\opapp-windows-host.dev.command.log';
  const candidates = resolveOutputCaptureCandidates(requestedPath, {
    tmpDir: 'C:\\Users\\ArrayZoneYour\\AppData\\Local\\Temp',
  });

  assert.deepEqual(candidates, [
    path.normalize(requestedPath),
    path.normalize('C:\\Users\\ArrayZoneYour\\AppData\\Local\\Temp\\opapp-windows-host.dev.command.log'),
  ]);
});

test('resolveOutputCaptureCandidates deduplicates fallback path when it matches requested path', () => {
  const candidates = resolveOutputCaptureCandidates('C:\\Temp\\opapp.log', {
    tmpDir: 'c:\\temp',
  });

  assert.deepEqual(candidates, [path.normalize('C:\\Temp\\opapp.log')]);
});

test('classifyDeterministicCommandFailure matches nested cmd spawn EPERM signatures', () => {
  const classification = classifyDeterministicCommandFailure(
    'Error: spawnSync C:\\\\WINDOWS\\\\system32\\\\cmd.exe EPERM',
  );

  assert.deepEqual(classification, {
    code: 'cmd-spawn-eperm',
    summary: 'nested cmd spawn rejected (EPERM)',
  });
});

test('classifyDeterministicCommandFailure ignores EPERM lines that do not mention cmd', () => {
  const classification = classifyDeterministicCommandFailure(
    'Error: spawnSync C:\\\\tools\\\\node.exe EPERM',
  );

  assert.equal(classification, null);
});

test('resolveHostCommandOutputPath prefers capture path from host child', () => {
  const resolved = resolveHostCommandOutputPath(
    {opappOutputCapturePath: 'D:\\tmp\\captured.log'},
    'D:\\tmp\\fallback.log',
  );
  assert.equal(resolved, path.normalize('D:\\tmp\\captured.log'));
});

test('resolveHostCommandOutputPath falls back to requested path when host child has none', () => {
  const resolved = resolveHostCommandOutputPath({}, 'D:\\tmp\\fallback.log');
  assert.equal(resolved, path.normalize('D:\\tmp\\fallback.log'));
});

test('detectDeterministicCommandFailureFromHost returns classification with fallback path', async () => {
  const tempPath = path.join(
    os.tmpdir(),
    `opapp-dev-common-${Date.now()}-${Math.random().toString(16).slice(2)}.log`,
  );

  try {
    await fsp.writeFile(tempPath, 'Error: spawnSync C:\\\\WINDOWS\\\\system32\\\\cmd.exe EPERM', 'utf8');
    const result = await detectDeterministicCommandFailureFromHost(
      {},
      {fallbackOutputPath: tempPath},
    );

    assert.deepEqual(result, {
      code: 'cmd-spawn-eperm',
      summary: 'nested cmd spawn rejected (EPERM)',
      commandOutputPath: path.normalize(tempPath),
    });
  } finally {
    await fsp.rm(tempPath, {force: true});
  }
});
