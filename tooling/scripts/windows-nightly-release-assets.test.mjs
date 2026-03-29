import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildReleaseNotes,
  compareMsixCandidates,
  shouldCopyPortableRelativePath,
} from './windows-nightly-release-assets.mjs';

test('shouldCopyPortableRelativePath drops debug-only portable entries', () => {
  assert.equal(shouldCopyPortableRelativePath('OpappWindowsHost.exe'), true);
  assert.equal(shouldCopyPortableRelativePath('Bundle\\index.main.windows.bundle'), true);
  assert.equal(shouldCopyPortableRelativePath('sourcemaps'), false);
  assert.equal(shouldCopyPortableRelativePath('sourcemaps\\react\\index.windows.bundle.map'), false);
  assert.equal(shouldCopyPortableRelativePath('OpappWindowsHost.pdb'), false);
});

test('compareMsixCandidates prefers release package over debug package', () => {
  const releaseCandidate = {
    filePath: 'AppPackages\\OpappWindowsHost.Package_1.0.0.0_x64_Test\\OpappWindowsHost.Package_1.0.0.0_x64.msix',
    mtimeMs: 10,
  };
  const debugCandidate = {
    filePath: 'AppPackages\\OpappWindowsHost.Package_1.0.0.0_x64_Debug_Test\\OpappWindowsHost.Package_1.0.0.0_x64_Debug.msix',
    mtimeMs: 20,
  };

  assert(compareMsixCandidates(releaseCandidate, debugCandidate) < 0);
});

test('buildReleaseNotes explains installable nightly assets', () => {
  const notes = buildReleaseNotes({
    desktopSha: '17b8787cafebabedeadbeef',
    frontendRef: 'f364aff6c1597c46e515d794af3705f9a28b965d',
    generatedAt: '2026-03-30T03:00:00.000Z',
  });

  assert.match(notes, /portable/);
  assert.match(notes, /Install\.ps1/);
  assert.match(notes, /bare exe/i);
});
