import {spawnSync} from 'node:child_process';
import {createHash, randomBytes} from 'node:crypto';
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(scriptDir, '..', '..');
export const defaultOutDir = path.join(repoRoot, '.dist', 'windows-nightly-release');
export const portableReleaseRoot = path.join(
  repoRoot,
  'hosts',
  'windows-host',
  'windows',
  'x64',
  'Release',
);
export const appPackagesRoot = path.join(
  repoRoot,
  'hosts',
  'windows-host',
  'windows',
  'OpappWindowsHost.Package',
  'AppPackages',
);
export const packageManifestPath = path.join(
  repoRoot,
  'hosts',
  'windows-host',
  'windows',
  'OpappWindowsHost.Package',
  'Package.appxmanifest',
);
export const windowsKitsBinRoot =
  process.env['ProgramFiles(x86)']?.trim()
    ? path.join(process.env['ProgramFiles(x86)'].trim(), 'Windows Kits', '10', 'bin')
    : path.join('C:\\Program Files (x86)', 'Windows Kits', '10', 'bin');

const portableFolderName = 'opapp-windows-nightly-x64-portable';
const msixBundleFolderName = 'opapp-windows-nightly-x64-msix-bundle';
const portableZipName = `${portableFolderName}.zip`;
const msixBundleZipName = `${msixBundleFolderName}.zip`;
const checksumsFileName = 'opapp-windows-nightly-SHA256SUMS.txt';
const metadataFileName = 'opapp-windows-nightly-metadata.json';
const releaseNotesFileName = 'opapp-windows-nightly-release-notes.md';

export function parseArgs(argv) {
  const options = {
    outDir: defaultOutDir,
    releaseLabel: 'nightly',
    desktopSha: normalizeCliValue(process.env.GITHUB_SHA) ?? 'unknown',
    frontendRef: normalizeCliValue(process.env.OPAPP_FRONTEND_REF) ?? 'unknown',
    generatedAt: new Date().toISOString(),
  };

  for (const arg of argv) {
    if (arg === '--help') {
      options.help = true;
      continue;
    }

    const separatorIndex = arg.indexOf('=');
    if (!arg.startsWith('--') || separatorIndex <= 2) {
      throw new Error(`Unknown argument '${arg}'. Expected --key=value.`);
    }

    const key = arg.slice(2, separatorIndex);
    const value = normalizeCliValue(arg.slice(separatorIndex + 1));
    if (!value) {
      throw new Error(`Argument '${arg}' is missing a value.`);
    }

    switch (key) {
      case 'out-dir':
        options.outDir = path.resolve(value);
        break;
      case 'release-label':
        options.releaseLabel = value;
        break;
      case 'desktop-sha':
        options.desktopSha = value;
        break;
      case 'frontend-ref':
        options.frontendRef = value;
        break;
      case 'generated-at':
        options.generatedAt = value;
        break;
      default:
        throw new Error(`Unknown argument '--${key}'.`);
    }
  }

  return options;
}

function normalizeCliValue(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  return normalized ? normalized : null;
}

function log(message) {
  console.log(`[windows-nightly-release-assets] ${message}`);
}

export function shouldCopyPortableRelativePath(relativePath) {
  if (!relativePath) {
    return true;
  }

  const normalized = relativePath.replace(/\\/g, '/');
  if (normalized === 'sourcemaps' || normalized.startsWith('sourcemaps/')) {
    return false;
  }

  if (normalized.endsWith('.pdb')) {
    return false;
  }

  return true;
}

export function compareMsixCandidates(a, b) {
  const aDebug = /_Debug(?:_|\.msix$)/i.test(a.filePath.replace(/\\/g, '/'));
  const bDebug = /_Debug(?:_|\.msix$)/i.test(b.filePath.replace(/\\/g, '/'));
  if (aDebug !== bDebug) {
    return aDebug ? 1 : -1;
  }

  if (a.mtimeMs !== b.mtimeMs) {
    return b.mtimeMs - a.mtimeMs;
  }

  return a.filePath.localeCompare(b.filePath);
}

function escapePowerShellLiteral(value) {
  return value.replace(/'/g, "''");
}

export function detectMsixArchitecture(filePath) {
  const match = filePath
    .replace(/\\/g, '/')
    .match(/_(arm64|x64|x86|arm)(?=_|\.msix$)/i);
  return match ? match[1].toLowerCase() : 'unknown';
}

export function shouldCopyMsixRelativePath(relativePath) {
  if (!relativePath) {
    return true;
  }

  const normalized = relativePath.replace(/\\/g, '/');
  const normalizedLower = normalized.toLowerCase();
  if (normalizedLower.endsWith('.appxsym')) {
    return false;
  }

  if (
    normalizedLower === 'telemetrydependencies' ||
    normalizedLower.startsWith('telemetrydependencies/')
  ) {
    return false;
  }

  const excludedDependencyPrefixes = [
    'dependencies/arm/',
    'dependencies/arm64/',
    'dependencies/win32/',
  ];
  if (
    excludedDependencyPrefixes.some(prefix => normalizedLower.startsWith(prefix)) ||
    normalizedLower === 'dependencies/arm' ||
    normalizedLower === 'dependencies/arm64' ||
    normalizedLower === 'dependencies/win32'
  ) {
    return false;
  }

  return true;
}

export function buildReleaseNotes({
  desktopSha,
  frontendRef,
  generatedAt,
  portableZipName: portableAssetName = portableZipName,
  msixBundleZipName: msixAssetName = msixBundleZipName,
}) {
  const shortDesktopSha =
    typeof desktopSha === 'string' && desktopSha.length >= 7
      ? desktopSha.slice(0, 7)
      : desktopSha;
  const shortFrontendRef =
    typeof frontendRef === 'string' && frontendRef.length >= 7
      ? frontendRef.slice(0, 7)
      : frontendRef;

  return [
    '# OPApp Windows Nightly',
    '',
    `Built at \`${generatedAt}\` from desktop \`${shortDesktopSha}\` with pinned frontend \`${shortFrontendRef}\`.`,
    '',
    '## Recommended Downloads',
    '',
    `- \`${portableAssetName}\`: unzip, keep the folder intact, and run \`OpappWindowsHost.exe\`. This is the easiest direct-run nightly path.`,
    `- \`${msixAssetName}\`: unzip and run \`Install.ps1\` if you need the packaged MSIX sideload path. Do not open the \`.msix\` directly.`,
    '',
    '## Notes',
    '',
    '- Windows release builds default their OTA remote base to `https://r2.opapp.dev` unless launch config or `OPAPP_OTA_REMOTE_URL` overrides it for smoke/testing.',
    '- Packaged builds only embed `opapp.companion.main`; private bundles such as `opapp.hbr.workspace` are expected to hydrate from the remote OTA catalog on demand.',
    '- The direct-run executable must stay beside its bundled DLLs and `Bundle/` directory; downloading a bare exe by itself is not a supported distribution shape.',
    '- The MSIX nightly is test-signed. The zip now includes the matching `.cer`, and `Install.ps1` is the supported way to trust/install it for internal testing.',
    '- These assets are nightly builds intended for internal testing and fast validation, not polished end-user installers.',
    '',
  ].join('\n');
}

async function ensurePathExists(filePath, label) {
  try {
    await stat(filePath);
  } catch (error) {
    const reason =
      error instanceof Error && error.message ? error.message : String(error);
    throw new Error(`${label} not found at ${filePath}: ${reason}`);
  }
}

async function walkFiles(rootDir) {
  const entries = await readdir(rootDir, {withFileTypes: true});
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(entryPath)));
      continue;
    }

    files.push(entryPath);
  }

  return files;
}

export async function findPreferredMsixFile(searchRoot) {
  await ensurePathExists(searchRoot, 'Windows AppPackages directory');
  const files = await walkFiles(searchRoot);
  const candidates = await Promise.all(
    files
      .filter(filePath => filePath.toLowerCase().endsWith('.msix'))
      .filter(filePath => !filePath.includes(`${path.sep}Dependencies${path.sep}`))
      .map(async filePath => ({
        filePath,
        mtimeMs: (await stat(filePath)).mtimeMs,
      })),
  );

  if (candidates.length === 0) {
    throw new Error(`Could not find a user-installable .msix under ${searchRoot}.`);
  }

  const preferredArchitecture = 'x64';
  const preferredCandidates = candidates.filter(
    candidate => detectMsixArchitecture(candidate.filePath) === preferredArchitecture,
  );

  if (preferredCandidates.length === 0) {
    const discoveredArchitectures = [...new Set(candidates.map(candidate => detectMsixArchitecture(candidate.filePath)))].sort();
    throw new Error(
      `Could not find a user-installable ${preferredArchitecture} .msix under ${searchRoot}. Found architectures: ${discoveredArchitectures.join(', ')}.`,
    );
  }

  preferredCandidates.sort(compareMsixCandidates);
  return preferredCandidates[0].filePath;
}

async function copyTreeFiltered(sourceRoot, destinationRoot, filterRelativePath) {
  await mkdir(destinationRoot, {recursive: true});
  const entries = await readdir(sourceRoot, {withFileTypes: true});

  for (const entry of entries) {
    const sourcePath = path.join(sourceRoot, entry.name);
    const relativePath = path.relative(sourceRoot, sourcePath);
    if (!filterRelativePath(relativePath)) {
      continue;
    }

    const destinationPath = path.join(destinationRoot, entry.name);
    if (entry.isDirectory()) {
      await copyTreeFiltered(sourcePath, destinationPath, childRelativePath =>
        filterRelativePath(path.join(relativePath, childRelativePath)),
      );
      continue;
    }

    await mkdir(path.dirname(destinationPath), {recursive: true});
    await copyFile(sourcePath, destinationPath);
  }
}

function runPowerShellOrThrow(commandText) {
  const result = spawnSync(
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
      cwd: repoRoot,
      env: process.env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: false,
    },
  );

  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(
      `PowerShell exited with status ${result.status ?? 1} while preparing nightly release assets.`,
    );
  }
}

function runExecutable(command, args) {
  return spawnSync(command, args, {
    cwd: repoRoot,
    env: process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false,
  });
}

function writeChildProcessOutput(result) {
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
}

function runExecutableOrThrow(command, args, label) {
  const result = runExecutable(command, args);
  writeChildProcessOutput(result);

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(
      `${label} exited with status ${result.status ?? 1}.`,
    );
  }
}

export async function resolveSigntoolPath(searchRoot = windowsKitsBinRoot) {
  await ensurePathExists(searchRoot, 'Windows Kits bin root');
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

export async function readPackagePublisher(manifestFilePath = packageManifestPath) {
  const manifestContent = await readFile(manifestFilePath, 'utf8');
  const publisherMatch = manifestContent.match(
    /<Identity\b[^>]*\bPublisher="([^"]+)"/i,
  );
  if (!publisherMatch?.[1]) {
    throw new Error(`Could not resolve Publisher from ${manifestFilePath}.`);
  }

  return publisherMatch[1];
}

function inspectMsixSignature(msixFilePath, signtoolPath) {
  const result = runExecutable(signtoolPath, ['verify', '/pa', '/v', msixFilePath]);
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

async function createZipFromDirectory(sourceDirectoryPath, zipFilePath) {
  const escapedSource = sourceDirectoryPath.replace(/'/g, "''");
  const escapedDestination = zipFilePath.replace(/'/g, "''");
  runPowerShellOrThrow(
    `Compress-Archive -LiteralPath '${escapedSource}' -DestinationPath '${escapedDestination}' -Force`,
  );
}

async function sha256File(filePath) {
  const content = await readFile(filePath);
  return createHash('sha256').update(content).digest('hex');
}

async function writePortableReadme(destinationRoot) {
  const readmePath = path.join(destinationRoot, 'README.txt');
  const content = [
    'OPApp Windows Nightly (portable)',
    '',
    '1. Extract this archive to a normal writable folder.',
    '2. Keep OpappWindowsHost.exe beside the bundled DLL files and Bundle\\.',
    '3. Launch OpappWindowsHost.exe from this folder.',
    '',
  ].join('\r\n');
  await writeFile(readmePath, content, 'utf8');
}

async function writeMsixReadme(destinationRoot, certificateFileName) {
  const readmePath = path.join(destinationRoot, 'README.txt');
  const content = [
    'OPApp Windows Nightly (MSIX sideload)',
    '',
    '1. Extract this archive to a normal writable folder.',
    '2. Run Install.ps1 from this folder.',
    `3. If Windows prompts about the nightly test certificate, trust the bundled ${certificateFileName}.`,
    '4. Do not open the .msix directly from Explorer before the certificate is trusted.',
    '',
  ].join('\r\n');
  await writeFile(readmePath, content, 'utf8');
}

async function stagePortableBundle(stagingRoot) {
  await ensurePathExists(portableReleaseRoot, 'Windows portable release root');
  const portableStageRoot = path.join(stagingRoot, portableFolderName);
  await copyTreeFiltered(
    portableReleaseRoot,
    portableStageRoot,
    shouldCopyPortableRelativePath,
  );
  await writePortableReadme(portableStageRoot);
  return portableStageRoot;
}

async function ensureSignedMsixAndExportCertificate(msixFilePath, destinationRoot) {
  const signtoolPath = await resolveSigntoolPath();
  const certificateFileName = `${path.parse(msixFilePath).name}.cer`;
  const certificatePath = path.join(destinationRoot, certificateFileName);
  const publisher = await readPackagePublisher();
  const signatureBeforeSigning = inspectMsixSignature(msixFilePath, signtoolPath);

  if (signatureBeforeSigning.state === 'absent') {
    const certificateBaseName = path.parse(msixFilePath).name;
    const pfxPath = path.join(destinationRoot, `${certificateBaseName}.pfx`);
    const pfxPassword = randomBytes(24).toString('hex');
    const escapedPublisher = escapePowerShellLiteral(publisher);
    const escapedCertificate = escapePowerShellLiteral(certificatePath);
    const escapedPfxPath = escapePowerShellLiteral(pfxPath);
    const escapedPassword = escapePowerShellLiteral(pfxPassword);

    log(`self-signing nightly MSIX with publisher ${publisher}`);
    runPowerShellOrThrow(
      [
        `$dn = New-Object System.Security.Cryptography.X509Certificates.X500DistinguishedName '${escapedPublisher}'`,
        '$rsa = [System.Security.Cryptography.RSA]::Create(2048)',
        '$request = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new($dn, $rsa, [System.Security.Cryptography.HashAlgorithmName]::SHA256, [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)',
        '$keyUsage = [System.Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new([System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature, $false)',
        '$request.CertificateExtensions.Add($keyUsage)',
        '$enhancedKeyUsageOids = New-Object System.Security.Cryptography.OidCollection',
        "[void]$enhancedKeyUsageOids.Add([System.Security.Cryptography.Oid]::new('1.3.6.1.5.5.7.3.3'))",
        '$enhancedKeyUsage = [System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($enhancedKeyUsageOids, $false)',
        '$request.CertificateExtensions.Add($enhancedKeyUsage)',
        '$cert = $request.CreateSelfSigned([System.DateTimeOffset]::UtcNow.AddDays(-1), [System.DateTimeOffset]::UtcNow.AddYears(2))',
        "if (-not $cert) { throw 'Could not create the nightly MSIX signing certificate.' }",
        `$exportableCert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($cert.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx, '${escapedPassword}'), '${escapedPassword}', [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::Exportable)`,
        `$pfxBytes = $exportableCert.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx, '${escapedPassword}')`,
        `[System.IO.File]::WriteAllBytes('${escapedPfxPath}', $pfxBytes)`,
        `$cerBytes = $exportableCert.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Cert)`,
        `[System.IO.File]::WriteAllBytes('${escapedCertificate}', $cerBytes)`,
        '$rsa.Dispose()',
      ].join('; '),
    );

    try {
      runExecutableOrThrow(
        signtoolPath,
        ['sign', '/fd', 'SHA256', '/f', pfxPath, '/p', pfxPassword, msixFilePath],
        'signtool sign',
      );
      const signatureAfterSigning = inspectMsixSignature(msixFilePath, signtoolPath);
      if (signatureAfterSigning.state === 'trusted') {
        log(`verified signed MSIX at ${msixFilePath}`);
      } else if (signatureAfterSigning.state === 'present-untrusted') {
        log(
          `verified self-signed MSIX at ${msixFilePath}; the bundled .cer is required before Windows trusts the publisher.`,
        );
      } else {
        writeChildProcessOutput(signatureAfterSigning.result);
        throw new Error(
          `MSIX signing did not produce a recognizable signature for ${msixFilePath}.`,
        );
      }
    } finally {
      await rm(pfxPath, {force: true});
    }
  } else if (
    signatureBeforeSigning.state === 'trusted' ||
    signatureBeforeSigning.state === 'present-untrusted'
  ) {
    throw new Error(
      `Expected an unsigned nightly MSIX at ${msixFilePath}, but the package already carries a signature. Update windows-nightly-release-assets.mjs to export that signer certificate instead of replacing it.`,
    );
  } else {
    writeChildProcessOutput(signatureBeforeSigning.result);
    throw new Error(`Could not determine the signature state for ${msixFilePath}.`);
  }

  return {
    certificateFileName,
    certificatePath,
  };
}

async function stageMsixBundle(stagingRoot) {
  const msixPath = await findPreferredMsixFile(appPackagesRoot);
  const msixSourceRoot = path.dirname(msixPath);
  const msixStageRoot = path.join(stagingRoot, msixBundleFolderName);

  await copyTreeFiltered(msixSourceRoot, msixStageRoot, shouldCopyMsixRelativePath);
  const stagedMsixPath = path.join(msixStageRoot, path.basename(msixPath));
  const {certificateFileName, certificatePath} = await ensureSignedMsixAndExportCertificate(
    stagedMsixPath,
    msixStageRoot,
  );
  await writeMsixReadme(msixStageRoot, certificateFileName);

  return {
    msixPath,
    msixStageRoot,
    certificatePath,
  };
}

async function writeChecksumsFile(outputPaths, checksumsPath) {
  const lines = [];
  for (const outputPath of outputPaths) {
    const checksum = await sha256File(outputPath);
    lines.push(`${checksum}  ${path.basename(outputPath)}`);
  }

  await writeFile(checksumsPath, lines.join('\n') + '\n', 'utf8');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(
      [
        'Usage:',
        '  node tooling/scripts/windows-nightly-release-assets.mjs [--out-dir=<path>]',
        '    [--release-label=<label>] [--desktop-sha=<sha>] [--frontend-ref=<ref>]',
        '    [--generated-at=<iso-string>]',
      ].join('\n'),
    );
    return;
  }

  const stagingRoot = path.join(options.outDir, 'payload');
  await rm(options.outDir, {recursive: true, force: true});
  await mkdir(stagingRoot, {recursive: true});

  log(`stagingRoot=${stagingRoot}`);
  const portableStageRoot = await stagePortableBundle(stagingRoot);
  const {msixPath, msixStageRoot, certificatePath} = await stageMsixBundle(stagingRoot);

  const portableZipPath = path.join(options.outDir, portableZipName);
  const msixBundleZipPath = path.join(options.outDir, msixBundleZipName);
  await createZipFromDirectory(portableStageRoot, portableZipPath);
  await createZipFromDirectory(msixStageRoot, msixBundleZipPath);

  const releaseNotesPath = path.join(options.outDir, releaseNotesFileName);
  await writeFile(
    releaseNotesPath,
    buildReleaseNotes({
      desktopSha: options.desktopSha,
      frontendRef: options.frontendRef,
      generatedAt: options.generatedAt,
    }),
    'utf8',
  );

  const checksumsPath = path.join(options.outDir, checksumsFileName);
  await writeChecksumsFile([portableZipPath, msixBundleZipPath], checksumsPath);

  const metadataPath = path.join(options.outDir, metadataFileName);
  await writeFile(
    metadataPath,
    JSON.stringify(
      {
        releaseLabel: options.releaseLabel,
        generatedAt: options.generatedAt,
        desktopSha: options.desktopSha,
        frontendRef: options.frontendRef,
        sourceRoots: {
          portableReleaseRoot,
          msixAppPackagesRoot: appPackagesRoot,
          selectedMsixPath: msixPath,
        },
        assets: [
          {
            path: portableZipPath,
            label: 'portable',
            recommended: true,
          },
          {
            path: msixBundleZipPath,
            label: 'msix-bundle',
            recommended: false,
          },
          {
            path: checksumsPath,
            label: 'checksums',
            recommended: false,
          },
        ],
        msixSupport: {
          certificatePath,
          dependencyDirectoriesIncluded: ['x64', 'x86'],
          dependencyDirectoriesExcluded: ['ARM', 'ARM64', 'win32'],
        },
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );

  log(`portableZip=${portableZipPath}`);
  log(`msixBundleZip=${msixBundleZipPath}`);
  log(`releaseNotes=${releaseNotesPath}`);
  log(`checksums=${checksumsPath}`);
  log(`metadata=${metadataPath}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
