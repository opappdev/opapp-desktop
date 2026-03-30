import {spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {readFile, rm, stat} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

export const windowsKitsBinRoot =
  process.env['ProgramFiles(x86)']?.trim()
    ? path.join(process.env['ProgramFiles(x86)'].trim(), 'Windows Kits', '10', 'bin')
    : path.join('C:\\Program Files (x86)', 'Windows Kits', '10', 'bin');

export const requiredSelfSignedCertificateExtensionOids = [
  '2.5.29.19',
  '2.5.29.15',
  '2.5.29.37',
  '2.5.29.14',
];

export function normalizeCliValue(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  return normalized ? normalized : null;
}

export function escapePowerShellLiteral(value) {
  return value.replace(/'/g, "''");
}

export async function ensurePathExists(filePath, label) {
  try {
    await stat(filePath);
  } catch (error) {
    const reason =
      error instanceof Error && error.message ? error.message : String(error);
    throw new Error(`${label} not found at ${filePath}: ${reason}`);
  }
}

export function writeChildProcessOutput(result) {
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
}

export function runPowerShell(commandText, {cwd = process.cwd(), env = process.env} = {}) {
  return spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      commandText,
    ],
    {
      cwd,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: false,
    },
  );
}

export function runPowerShellOrThrow(
  commandText,
  {cwd = process.cwd(), env = process.env, label = 'PowerShell'} = {},
) {
  const result = runPowerShell(commandText, {cwd, env});
  writeChildProcessOutput(result);

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`${label} exited with status ${result.status ?? 1}.`);
  }

  return result;
}

export function runExecutable(command, args, {cwd = process.cwd(), env = process.env} = {}) {
  return spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false,
  });
}

export function runExecutableOrThrow(
  command,
  args,
  label,
  {cwd = process.cwd(), env = process.env} = {},
) {
  const result = runExecutable(command, args, {cwd, env});
  writeChildProcessOutput(result);

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`${label} exited with status ${result.status ?? 1}.`);
  }

  return result;
}

export async function resolveSigntoolPath(searchRoot = windowsKitsBinRoot) {
  await ensurePathExists(searchRoot, 'Windows Kits bin root');
  const {readdir} = await import('node:fs/promises');
  const entries = await readdir(searchRoot, {withFileTypes: true});
  const candidates = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const candidatePath = path.join(searchRoot, entry.name, 'x64', 'signtool.exe');
    try {
      await stat(candidatePath);
      candidates.push({
        filePath: candidatePath,
        version: entry.name,
      });
    } catch {}
  }

  if (candidates.length === 0) {
    throw new Error(`Could not find signtool.exe under ${searchRoot}.`);
  }

  candidates.sort((left, right) =>
    right.version.localeCompare(left.version, undefined, {
      numeric: true,
      sensitivity: 'base',
    }),
  );
  return candidates[0].filePath;
}

export async function readPackagePublisher(manifestFilePath) {
  const manifestContent = await readFile(manifestFilePath, 'utf8');
  const publisherMatch = manifestContent.match(
    /<Identity\b[^>]*\bPublisher="([^"]+)"/i,
  );
  if (!publisherMatch?.[1]) {
    throw new Error(`Could not resolve Publisher from ${manifestFilePath}.`);
  }

  return publisherMatch[1];
}

export async function readPackageVersion(manifestFilePath) {
  const manifestContent = await readFile(manifestFilePath, 'utf8');
  const versionMatch = manifestContent.match(
    /<Identity\b[^>]*\bVersion="([^"]+)"/i,
  );
  if (!versionMatch?.[1]) {
    throw new Error(`Could not resolve Version from ${manifestFilePath}.`);
  }

  return versionMatch[1];
}

export function inspectMsixSignature(
  msixFilePath,
  signtoolPath,
  {cwd = process.cwd(), env = process.env} = {},
) {
  const result = runExecutable(signtoolPath, ['verify', '/pa', '/v', msixFilePath], {
    cwd,
    env,
  });
  const combinedOutput = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;

  if (result.status === 0) {
    return {
      state: 'trusted',
      result,
    };
  }

  if (/No signature found/i.test(combinedOutput)) {
    return {
      state: 'absent',
      result,
    };
  }

  if (/not trusted by the trust provider/i.test(combinedOutput)) {
    return {
      state: 'present-untrusted',
      result,
    };
  }

  return {
    state: 'invalid',
    result,
  };
}

export function buildSelfSignedCertificatePowerShell({
  publisher,
  pfxPath,
  certificatePath,
  pfxPassword,
}) {
  const escapedPublisher = escapePowerShellLiteral(publisher);
  const escapedCertificate = escapePowerShellLiteral(certificatePath);
  const escapedPfxPath = escapePowerShellLiteral(pfxPath);
  const escapedPassword = escapePowerShellLiteral(pfxPassword);

  return [
    `$dn = New-Object System.Security.Cryptography.X509Certificates.X500DistinguishedName '${escapedPublisher}'`,
    '$rsa = [System.Security.Cryptography.RSA]::Create(2048)',
    '$request = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new($dn, $rsa, [System.Security.Cryptography.HashAlgorithmName]::SHA256, [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)',
    '$basicConstraints = [System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($false, $false, 0, $false)',
    '$request.CertificateExtensions.Add($basicConstraints)',
    '$keyUsage = [System.Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new([System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature, $false)',
    '$request.CertificateExtensions.Add($keyUsage)',
    '$enhancedKeyUsageOids = New-Object System.Security.Cryptography.OidCollection',
    "[void]$enhancedKeyUsageOids.Add([System.Security.Cryptography.Oid]::new('1.3.6.1.5.5.7.3.3'))",
    '$enhancedKeyUsage = [System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($enhancedKeyUsageOids, $false)',
    '$request.CertificateExtensions.Add($enhancedKeyUsage)',
    '$subjectKeyIdentifier = [System.Security.Cryptography.X509Certificates.X509SubjectKeyIdentifierExtension]::new($request.PublicKey, $false)',
    '$request.CertificateExtensions.Add($subjectKeyIdentifier)',
    '$cert = $null',
    '$exportableCert = $null',
    'try {',
    '  $cert = $request.CreateSelfSigned([System.DateTimeOffset]::UtcNow.AddDays(-1), [System.DateTimeOffset]::UtcNow.AddYears(2))',
    "  if (-not $cert) { throw 'Could not create the nightly MSIX signing certificate.' }",
    `  $exportableCert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($cert.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx, '${escapedPassword}'), '${escapedPassword}', [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::Exportable)`,
    `  $pfxBytes = $exportableCert.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx, '${escapedPassword}')`,
    `  [System.IO.File]::WriteAllBytes('${escapedPfxPath}', $pfxBytes)`,
    '  $cerBytes = $exportableCert.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Cert)',
    `  [System.IO.File]::WriteAllBytes('${escapedCertificate}', $cerBytes)`,
    '} finally {',
    '  if ($exportableCert) { $exportableCert.Dispose() }',
    '  if ($cert) { $cert.Dispose() }',
    '  $rsa.Dispose()',
    '}',
  ].join('; ');
}

export function buildExportPublicCertificatePowerShell({
  pfxPath,
  pfxPassword,
  certificatePath,
}) {
  const escapedPfxPath = escapePowerShellLiteral(pfxPath);
  const escapedPassword = escapePowerShellLiteral(pfxPassword);
  const escapedCertificate = escapePowerShellLiteral(certificatePath);

  return [
    '$certificate = $null',
    'try {',
    '  $certificate = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2',
    `  $certificate.Import('${escapedPfxPath}', '${escapedPassword}', [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::DefaultKeySet)`,
    '  $cerBytes = $certificate.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Cert)',
    `  [System.IO.File]::WriteAllBytes('${escapedCertificate}', $cerBytes)`,
    '} finally {',
    '  if ($certificate) { $certificate.Dispose() }',
    '}',
  ].join('; ');
}

export async function readPfxSubject({
  pfxPath,
  pfxPassword,
  cwd = process.cwd(),
  env = process.env,
}) {
  await ensurePathExists(pfxPath, 'Windows signing PFX');
  const escapedPfxPath = escapePowerShellLiteral(pfxPath);
  const escapedPassword = escapePowerShellLiteral(pfxPassword);
  const result = runPowerShell(
    [
      '$certificate = $null',
      'try {',
      '  $certificate = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2',
      `  $certificate.Import('${escapedPfxPath}', '${escapedPassword}', [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::DefaultKeySet)`,
      '  [Console]::Out.Write($certificate.Subject)',
      '} finally {',
      '  if ($certificate) { $certificate.Dispose() }',
      '}',
    ].join('; '),
    {cwd, env},
  );

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    writeChildProcessOutput(result);
    throw new Error(`Could not read the signing certificate subject from ${pfxPath}.`);
  }

  return normalizeCliValue(result.stdout) ?? '';
}

export function normalizeDistinguishedName(value) {
  return String(value ?? '')
    .split(',')
    .map(part => part.trim().replace(/\s+/g, ' '))
    .filter(Boolean)
    .join(',')
    .toUpperCase();
}

export function assertCertificateSubjectMatchesPublisher({
  publisher,
  subject,
  label = 'signing certificate',
}) {
  if (normalizeDistinguishedName(publisher) !== normalizeDistinguishedName(subject)) {
    throw new Error(
      `${label} subject '${subject}' does not match Publisher '${publisher}'.`,
    );
  }
}

export async function selfSignMsixAndExportCertificate({
  msixFilePath,
  certificatePath,
  publisher,
  signtoolPath,
  cwd = process.cwd(),
  env = process.env,
  log = () => {},
}) {
  const signatureBeforeSigning = inspectMsixSignature(msixFilePath, signtoolPath, {
    cwd,
    env,
  });
  if (
    signatureBeforeSigning.state === 'trusted' ||
    signatureBeforeSigning.state === 'present-untrusted'
  ) {
    throw new Error(
      `Expected an unsigned MSIX at ${msixFilePath}, but the package already carries a signature.`,
    );
  }

  if (signatureBeforeSigning.state !== 'absent') {
    writeChildProcessOutput(signatureBeforeSigning.result);
    throw new Error(`Could not determine the signature state for ${msixFilePath}.`);
  }

  const pfxPath = path.join(
    path.dirname(certificatePath),
    `${path.parse(certificatePath).name}.pfx`,
  );
  const pfxPassword = randomBytes(24).toString('hex');

  log(`self-signing MSIX with publisher ${publisher}`);
  runPowerShellOrThrow(
    buildSelfSignedCertificatePowerShell({
      publisher,
      pfxPath,
      certificatePath,
      pfxPassword,
    }),
    {cwd, env, label: 'PowerShell self-signed certificate export'},
  );

  try {
    runExecutableOrThrow(
      signtoolPath,
      ['sign', '/fd', 'SHA256', '/f', pfxPath, '/p', pfxPassword, msixFilePath],
      'signtool sign',
      {cwd, env},
    );
    const signatureAfterSigning = inspectMsixSignature(msixFilePath, signtoolPath, {
      cwd,
      env,
    });
    if (
      signatureAfterSigning.state !== 'trusted' &&
      signatureAfterSigning.state !== 'present-untrusted'
    ) {
      writeChildProcessOutput(signatureAfterSigning.result);
      throw new Error(
        `MSIX signing did not produce a recognizable signature for ${msixFilePath}.`,
      );
    }
  } finally {
    await rm(pfxPath, {force: true});
  }
}

export async function signMsixWithPfxAndExportCertificate({
  msixFilePath,
  certificatePath,
  pfxPath,
  pfxPassword,
  timestampUrl,
  publisher,
  signtoolPath,
  cwd = process.cwd(),
  env = process.env,
  log = () => {},
}) {
  const pfxSubject = await readPfxSubject({pfxPath, pfxPassword, cwd, env});
  assertCertificateSubjectMatchesPublisher({
    publisher,
    subject: pfxSubject,
    label: 'Windows signing PFX',
  });

  const signatureBeforeSigning = inspectMsixSignature(msixFilePath, signtoolPath, {
    cwd,
    env,
  });
  if (
    signatureBeforeSigning.state === 'trusted' ||
    signatureBeforeSigning.state === 'present-untrusted'
  ) {
    throw new Error(
      `Expected an unsigned MSIX at ${msixFilePath}, but the package already carries a signature.`,
    );
  }

  if (signatureBeforeSigning.state !== 'absent') {
    writeChildProcessOutput(signatureBeforeSigning.result);
    throw new Error(`Could not determine the signature state for ${msixFilePath}.`);
  }

  log(`signing official MSIX with publisher ${publisher}`);
  runPowerShellOrThrow(
    buildExportPublicCertificatePowerShell({
      pfxPath,
      pfxPassword,
      certificatePath,
    }),
    {cwd, env, label: 'PowerShell signing certificate export'},
  );

  const signArgs = ['sign', '/fd', 'SHA256', '/f', pfxPath, '/p', pfxPassword];
  if (timestampUrl) {
    signArgs.push('/tr', timestampUrl, '/td', 'SHA256');
  }
  signArgs.push(msixFilePath);

  runExecutableOrThrow(signtoolPath, signArgs, 'signtool sign', {cwd, env});
  const signatureAfterSigning = inspectMsixSignature(msixFilePath, signtoolPath, {
    cwd,
    env,
  });
  if (signatureAfterSigning.state !== 'trusted') {
    writeChildProcessOutput(signatureAfterSigning.result);
    throw new Error(
      `Official MSIX signature is not trusted after signing ${msixFilePath}.`,
    );
  }
}
