import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {resolveOutputCaptureCandidates} from './windows-dev-common.mjs';

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
