import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildReleaseNotes,
  compareMsixCandidates,
  findPreferredMsixFile,
  shouldCopyMsixRelativePath,
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

test('findPreferredMsixFile prefers x64 package when multiple architectures exist', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opapp-nightly-msix-'));
  const arm64Dir = path.join(tempDir, 'OpappWindowsHost.Package_1.0.0.0_arm64_Test');
  const x64Dir = path.join(tempDir, 'OpappWindowsHost.Package_1.0.0.0_x64_Test');
  await mkdir(arm64Dir, {recursive: true});
  await mkdir(x64Dir, {recursive: true});

  const arm64Msix = path.join(arm64Dir, 'OpappWindowsHost.Package_1.0.0.0_arm64.msix');
  const x64Msix = path.join(x64Dir, 'OpappWindowsHost.Package_1.0.0.0_x64.msix');
  await writeFile(arm64Msix, 'arm64', 'utf8');
  await writeFile(x64Msix, 'x64', 'utf8');

  assert.equal(await findPreferredMsixFile(tempDir), x64Msix);
});

test('findPreferredMsixFile rejects non-x64 package sets', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opapp-nightly-msix-'));
  const arm64Dir = path.join(tempDir, 'OpappWindowsHost.Package_1.0.0.0_arm64_Test');
  await mkdir(arm64Dir, {recursive: true});
  await writeFile(
    path.join(arm64Dir, 'OpappWindowsHost.Package_1.0.0.0_arm64.msix'),
    'arm64',
    'utf8',
  );

  await assert.rejects(
    findPreferredMsixFile(tempDir),
    /Could not find a user-installable x64 \.msix/,
  );
});

test('shouldCopyMsixRelativePath trims debug symbols, telemetry, and non-x64 nightly baggage', () => {
  assert.equal(shouldCopyMsixRelativePath('OpappWindowsHost.Package_1.0.0.0_x64.msix'), true);
  assert.equal(shouldCopyMsixRelativePath('Dependencies\\x64\\Microsoft.WindowsAppRuntime.1.8.msix'), true);
  assert.equal(shouldCopyMsixRelativePath('Dependencies\\x86\\Microsoft.WindowsAppRuntime.1.8.msix'), true);
  assert.equal(shouldCopyMsixRelativePath('Dependencies\\ARM\\Microsoft.VCLibs.ARM.14.00.appx'), false);
  assert.equal(
    shouldCopyMsixRelativePath('Dependencies\\ARM64\\Microsoft.WindowsAppRuntime.1.8.msix'),
    false,
  );
  assert.equal(
    shouldCopyMsixRelativePath('Dependencies\\win32\\Microsoft.WindowsAppRuntime.1.8.msix'),
    false,
  );
  assert.equal(shouldCopyMsixRelativePath('TelemetryDependencies\\Microsoft.VisualStudio.Telemetry.dll'), false);
  assert.equal(shouldCopyMsixRelativePath('OpappWindowsHost.Package_1.0.0.0_x64.appxsym'), false);
});

test('buildReleaseNotes explains installable nightly assets', () => {
  const notes = buildReleaseNotes({
    desktopSha: '17b8787cafebabedeadbeef',
    frontendRef: 'f364aff6c1597c46e515d794af3705f9a28b965d',
    generatedAt: '2026-03-30T03:00:00.000Z',
  });

  assert.match(notes, /portable/);
  assert.match(notes, /Install\.ps1/);
  assert.match(notes, /do not open the \`\.msix\` directly/i);
  assert.match(notes, /test-signed/i);
});
