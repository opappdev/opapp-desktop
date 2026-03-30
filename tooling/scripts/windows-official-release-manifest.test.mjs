import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyPackageManifestOverrides,
  parseOfficialReleaseTag,
} from './windows-official-release-manifest.mjs';

test('parseOfficialReleaseTag maps windows tag to release and MSIX versions', () => {
  assert.deepEqual(parseOfficialReleaseTag('windows-v1.2.3'), {
    releaseTag: 'windows-v1.2.3',
    releaseVersion: '1.2.3',
    msixVersion: '1.2.3.0',
    releaseTitle: 'OPApp Windows v1.2.3',
  });
});

test('parseOfficialReleaseTag rejects unsupported tags', () => {
  assert.throws(
    () => parseOfficialReleaseTag('v1.2.3'),
    /Expected windows-vX\.Y\.Z/,
  );
});

test('applyPackageManifestOverrides updates publisher, display name, and version', () => {
  const currentManifest = [
    '<Package>',
    '  <Identity Name="OpappWindowsHost" Publisher="CN=ArrayZoneYour" Version="1.0.0.0" />',
    '  <Properties>',
    '    <PublisherDisplayName>ArrayZoneYour</PublisherDisplayName>',
    '  </Properties>',
    '</Package>',
  ].join('\n');

  const nextManifest = applyPackageManifestOverrides(currentManifest, {
    publisher: 'CN=Contoso Software, O=Contoso Corporation, C=US',
    publisherDisplayName: 'Contoso Software',
    version: '2.3.4.0',
  });

  assert.match(nextManifest, /Publisher="CN=Contoso Software, O=Contoso Corporation, C=US"/);
  assert.match(nextManifest, /Version="2.3.4.0"/);
  assert.match(nextManifest, /<PublisherDisplayName>Contoso Software<\/PublisherDisplayName>/);
});
