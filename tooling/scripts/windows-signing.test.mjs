import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertCertificateSubjectMatchesPublisher,
  buildSelfSignedCertificatePowerShell,
  requiredSelfSignedCertificateExtensionOids,
} from './windows-signing.mjs';

test('self-signed certificate blueprint includes the required extension OIDs', () => {
  assert.deepEqual(requiredSelfSignedCertificateExtensionOids, [
    '2.5.29.19',
    '2.5.29.15',
    '2.5.29.37',
    '2.5.29.14',
  ]);
});

test('self-signed certificate PowerShell adds Basic Constraints and Subject Key Identifier', () => {
  const command = buildSelfSignedCertificatePowerShell({
    publisher: 'CN=ArrayZoneYour',
    pfxPath: 'C:\\temp\\nightly.pfx',
    certificatePath: 'C:\\temp\\nightly.cer',
    pfxPassword: 'secret',
  });

  assert.match(command, /X509BasicConstraintsExtension/);
  assert.match(command, /X509SubjectKeyIdentifierExtension/);
  assert.match(command, /1\.3\.6\.1\.5\.5\.7\.3\.3/);
});

test('certificate subject validation ignores trivial whitespace and case differences', () => {
  assert.doesNotThrow(() =>
    assertCertificateSubjectMatchesPublisher({
      publisher: 'CN=Contoso Software, O=Contoso Corporation, C=US',
      subject: 'cn=contoso software,  o=Contoso Corporation , c=US',
    }),
  );
});

test('certificate subject validation rejects mismatched publishers', () => {
  assert.throws(
    () =>
      assertCertificateSubjectMatchesPublisher({
        publisher: 'CN=Contoso Software, O=Contoso Corporation, C=US',
        subject: 'CN=Different Publisher, O=Contoso Corporation, C=US',
      }),
    /does not match Publisher/,
  );
});
