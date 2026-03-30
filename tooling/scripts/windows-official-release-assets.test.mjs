import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildReleaseNotes,
  parseArgs,
  validateOfficialReleaseOptions,
} from './windows-official-release-assets.mjs';

test('validateOfficialReleaseOptions maps tag to release versions', () => {
  const options = validateOfficialReleaseOptions({
    outDir: 'D:\\temp\\out',
    tag: 'windows-v1.2.3',
    publisher: 'CN=Contoso Software, O=Contoso Corporation, C=US',
    publisherDisplayName: 'Contoso Software',
    signingPfxPath: 'D:\\temp\\contoso-signing.pfx',
    signingPfxPassword: 'secret',
    timestampUrl: 'https://timestamp.example.test',
    desktopSha: 'abc1234',
    frontendRef: 'def5678',
    generatedAt: '2026-03-30T08:00:00.000Z',
    validateOnly: false,
  });

  assert.equal(options.releaseVersion, '1.2.3');
  assert.equal(options.msixVersion, '1.2.3.0');
  assert.equal(options.releaseTitle, 'OPApp Windows v1.2.3');
});

test('validateOfficialReleaseOptions rejects missing timestamp URL', () => {
  assert.throws(
    () =>
      validateOfficialReleaseOptions({
        tag: 'windows-v1.2.3',
        publisher: 'CN=Contoso Software, O=Contoso Corporation, C=US',
        publisherDisplayName: 'Contoso Software',
        signingPfxPath: 'D:\\temp\\contoso-signing.pfx',
        signingPfxPassword: 'secret',
      }),
    /Missing timestamp URL/,
  );
});

test('parseArgs accepts validate-only official release invocations', () => {
  const options = parseArgs([
    '--validate-only',
    '--tag=windows-v1.2.3',
    '--publisher=CN=Contoso Software, O=Contoso Corporation, C=US',
    '--publisher-display-name=Contoso Software',
    '--signing-pfx-path=D:\\temp\\contoso-signing.pfx',
    '--signing-pfx-password=secret',
    '--timestamp-url=https://timestamp.example.test',
  ]);

  assert.equal(options.validateOnly, true);
  assert.equal(options.tag, 'windows-v1.2.3');
});

test('buildReleaseNotes calls out reinstall path from nightly builds', () => {
  const notes = buildReleaseNotes({
    releaseTitle: 'OPApp Windows v1.2.3',
    releaseTag: 'windows-v1.2.3',
    releaseVersion: '1.2.3',
    desktopSha: '1234567deadbeef',
    frontendRef: '89abcde1234567',
    generatedAt: '2026-03-30T08:00:00.000Z',
  });

  assert.match(notes, /CA-issued Windows code-signing certificate/i);
  assert.match(notes, /Uninstall the nightly package first/i);
  assert.match(notes, /Install\.ps1/);
});
