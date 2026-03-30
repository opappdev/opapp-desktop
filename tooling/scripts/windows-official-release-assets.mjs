import {mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';

import {
  appPackagesRoot,
  copyTreeFiltered,
  createZipFromDirectory,
  findPreferredMsixFile,
  packageManifestPath,
  portableReleaseRoot,
  repoRoot,
  shouldCopyMsixRelativePath,
  shouldCopyPortableRelativePath,
  writeChecksumsFile,
} from './windows-release-assets-common.mjs';
import {
  ensurePathExists,
  normalizeCliValue,
  readPfxSubject,
  resolveSigntoolPath,
  signMsixWithPfxAndExportCertificate,
  assertCertificateSubjectMatchesPublisher,
} from './windows-signing.mjs';
import {parseOfficialReleaseTag} from './windows-official-release-manifest.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === scriptPath;

export const defaultOutDir = path.join(repoRoot, '.dist', 'windows-release');
export const portableFolderName = 'opapp-windows-x64-portable';
export const msixBundleFolderName = 'opapp-windows-x64-msix-bundle';
export const portableZipName = `${portableFolderName}.zip`;
export const msixBundleZipName = `${msixBundleFolderName}.zip`;
export const checksumsFileName = 'opapp-windows-SHA256SUMS.txt';
export const metadataFileName = 'opapp-windows-release-metadata.json';
export const releaseNotesFileName = 'opapp-windows-release-notes.md';

function readRequiredManifestValue(manifestContent, pattern, label) {
  const match = manifestContent.match(pattern);
  if (!match?.[1]) {
    throw new Error(`Could not resolve ${label} from Package.appxmanifest.`);
  }

  return match[1];
}

export function readPackagePublisherFromManifest(manifestContent) {
  return readRequiredManifestValue(
    manifestContent,
    /<Identity\b[^>]*\bPublisher="([^"]+)"/i,
    'Publisher',
  );
}

export function readPackageVersionFromManifest(manifestContent) {
  return readRequiredManifestValue(
    manifestContent,
    /<Identity\b[^>]*\bVersion="([^"]+)"/i,
    'Version',
  );
}

export function readPackagePublisherDisplayNameFromManifest(manifestContent) {
  return readRequiredManifestValue(
    manifestContent,
    /<PublisherDisplayName>([^<]*)<\/PublisherDisplayName>/i,
    'PublisherDisplayName',
  );
}

export function assertHttpsUrl(value, label = 'timestamp URL') {
  let parsedUrl;
  try {
    parsedUrl = new URL(value);
  } catch {
    throw new Error(`Invalid ${label} '${value}'. Provide --timestamp-url=<https-url>.`);
  }

  if (parsedUrl.protocol !== 'https:') {
    throw new Error(`Invalid ${label} '${value}'. Provide --timestamp-url=<https-url>.`);
  }
}

export function assertOfficialManifestOverridesApplied(manifestContent, options) {
  const manifestPublisher = readPackagePublisherFromManifest(manifestContent);
  if (manifestPublisher !== options.publisher) {
    throw new Error(
      `Package.appxmanifest Publisher is '${manifestPublisher}', but the official release expects '${options.publisher}'. Run windows-official-release-manifest.mjs before building release assets.`,
    );
  }

  const manifestVersion = readPackageVersionFromManifest(manifestContent);
  if (manifestVersion !== options.msixVersion) {
    throw new Error(
      `Package.appxmanifest Version is '${manifestVersion}', but the official release expects '${options.msixVersion}'. Run windows-official-release-manifest.mjs before building release assets.`,
    );
  }

  const manifestPublisherDisplayName =
    readPackagePublisherDisplayNameFromManifest(manifestContent);
  if (manifestPublisherDisplayName !== options.publisherDisplayName) {
    throw new Error(
      `Package.appxmanifest PublisherDisplayName is '${manifestPublisherDisplayName}', but the official release expects '${options.publisherDisplayName}'. Run windows-official-release-manifest.mjs before building release assets.`,
    );
  }
}

export function parseArgs(argv, env = process.env) {
  const options = {
    outDir: defaultOutDir,
    tag: normalizeCliValue(env.GITHUB_REF_NAME),
    desktopSha: normalizeCliValue(env.GITHUB_SHA) ?? 'unknown',
    frontendRef: normalizeCliValue(env.OPAPP_FRONTEND_REF) ?? 'unknown',
    publisher: normalizeCliValue(env.OPAPP_WINDOWS_OFFICIAL_PUBLISHER),
    publisherDisplayName: normalizeCliValue(
      env.OPAPP_WINDOWS_OFFICIAL_PUBLISHER_DISPLAY_NAME,
    ),
    signingPfxPath: normalizeCliValue(env.OPAPP_WINDOWS_SIGNING_PFX_PATH),
    signingPfxPassword: normalizeCliValue(env.OPAPP_WINDOWS_SIGNING_PFX_PASSWORD),
    timestampUrl: normalizeCliValue(env.OPAPP_WINDOWS_SIGNING_TIMESTAMP_URL),
    generatedAt: new Date().toISOString(),
    validateOnly: false,
  };

  for (const arg of argv) {
    if (arg === '--help') {
      options.help = true;
      continue;
    }
    if (arg === '--validate-only') {
      options.validateOnly = true;
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
      case 'tag':
        options.tag = value;
        break;
      case 'desktop-sha':
        options.desktopSha = value;
        break;
      case 'frontend-ref':
        options.frontendRef = value;
        break;
      case 'publisher':
        options.publisher = value;
        break;
      case 'publisher-display-name':
        options.publisherDisplayName = value;
        break;
      case 'signing-pfx-path':
        options.signingPfxPath = path.resolve(value);
        break;
      case 'signing-pfx-password':
        options.signingPfxPassword = value;
        break;
      case 'timestamp-url':
        options.timestampUrl = value;
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

export function validateOfficialReleaseOptions(options) {
  if (!options.tag) {
    throw new Error('Missing Windows release tag. Provide --tag=windows-vX.Y.Z.');
  }
  if (!options.publisher) {
    throw new Error('Missing official Publisher. Provide --publisher=<subject>.');
  }
  if (!options.publisherDisplayName) {
    throw new Error(
      'Missing official PublisherDisplayName. Provide --publisher-display-name=<value>.',
    );
  }
  if (!options.signingPfxPath) {
    throw new Error('Missing signing PFX path. Provide --signing-pfx-path=<path>.');
  }
  if (!options.signingPfxPassword) {
    throw new Error(
      'Missing signing PFX password. Provide --signing-pfx-password=<value>.',
    );
  }
  if (!options.timestampUrl) {
    throw new Error('Missing timestamp URL. Provide --timestamp-url=<https-url>.');
  }
  assertHttpsUrl(options.timestampUrl);

  return {
    ...options,
    ...parseOfficialReleaseTag(options.tag),
  };
}

function log(message) {
  console.log(`[windows-official-release-assets] ${message}`);
}

export function buildReleaseNotes({
  releaseTitle,
  releaseTag,
  releaseVersion,
  desktopSha,
  frontendRef,
  generatedAt,
  portableZipAssetName = portableZipName,
  msixZipAssetName = msixBundleZipName,
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
    `# ${releaseTitle}`,
    '',
    `Tag \`${releaseTag}\` built at \`${generatedAt}\` from desktop \`${shortDesktopSha}\` with pinned frontend \`${shortFrontendRef}\`.`,
    '',
    '## Downloads',
    '',
    `- \`${portableZipAssetName}\`: unzip, keep the folder intact, and run \`OpappWindowsHost.exe\`.`,
    `- \`${msixZipAssetName}\`: unzip and run \`Install.ps1\` for the packaged MSIX sideload flow.`,
    '',
    '## Notes',
    '',
    '- This release signs the MSIX with the configured CA-issued Windows code-signing certificate.',
    '- Existing nightly/test-signed installations are not an upgrade target. Uninstall the nightly package first, then install this official release.',
    '- Packaged builds only embed `opapp.companion.main`; private bundles such as `opapp.hbr.workspace` remain remote-only and hydrate from OTA on demand.',
    '- Windows release builds default their OTA remote base to `https://r2.opapp.dev` unless launch config or `OPAPP_OTA_REMOTE_URL` overrides it for smoke/testing.',
    `- Portable and packaged assets are released together for OPApp Windows v${releaseVersion}.`,
    '',
  ].join('\n');
}

async function validateOfficialSigningConfig(options) {
  await ensurePathExists(options.signingPfxPath, 'Windows signing PFX');
  const subject = await readPfxSubject({
    pfxPath: options.signingPfxPath,
    pfxPassword: options.signingPfxPassword,
    cwd: repoRoot,
  });
  assertCertificateSubjectMatchesPublisher({
    publisher: options.publisher,
    subject,
    label: 'Windows signing PFX',
  });

  return {
    subject,
    releaseTag: options.releaseTag,
    releaseVersion: options.releaseVersion,
    msixVersion: options.msixVersion,
    releaseTitle: options.releaseTitle,
  };
}

async function assertManifestReadyForOfficialRelease(options) {
  const manifestContent = await readFile(packageManifestPath, 'utf8');
  assertOfficialManifestOverridesApplied(manifestContent, options);
}

async function writePortableReadme(destinationRoot, releaseVersion) {
  const readmePath = path.join(destinationRoot, 'README.txt');
  const content = [
    `OPApp Windows ${releaseVersion} (portable)`,
    '',
    '1. Extract this archive to a normal writable folder.',
    '2. Keep OpappWindowsHost.exe beside the bundled DLL files and Bundle\\.',
    '3. Launch OpappWindowsHost.exe from this folder.',
    '',
  ].join('\r\n');
  await writeFile(readmePath, content, 'utf8');
}

async function writeMsixReadme(destinationRoot, releaseVersion, certificateFileName) {
  const readmePath = path.join(destinationRoot, 'README.txt');
  const content = [
    `OPApp Windows ${releaseVersion} (MSIX sideload)`,
    '',
    '1. Extract this archive to a normal writable folder.',
    '2. If you currently have a nightly/test-signed OPApp package installed, uninstall it first.',
    '3. Run Install.ps1 from this folder.',
    `4. ${certificateFileName} is included for signer inspection and enterprise trust troubleshooting; standard CA-trusted installs should not prompt for manual certificate trust.`,
    '',
  ].join('\r\n');
  await writeFile(readmePath, content, 'utf8');
}

async function stagePortableBundle(stagingRoot, options) {
  await ensurePathExists(portableReleaseRoot, 'Windows portable release root');
  const portableStageRoot = path.join(stagingRoot, portableFolderName);
  await copyTreeFiltered(
    portableReleaseRoot,
    portableStageRoot,
    shouldCopyPortableRelativePath,
  );
  await writePortableReadme(portableStageRoot, options.releaseVersion);
  return portableStageRoot;
}

async function stageMsixBundle(stagingRoot, options) {
  const msixPath = await findPreferredMsixFile(appPackagesRoot);
  const msixSourceRoot = path.dirname(msixPath);
  const msixStageRoot = path.join(stagingRoot, msixBundleFolderName);

  await copyTreeFiltered(msixSourceRoot, msixStageRoot, shouldCopyMsixRelativePath);
  const stagedMsixPath = path.join(msixStageRoot, path.basename(msixPath));
  const certificateFileName = `${path.parse(stagedMsixPath).name}.cer`;
  const certificatePath = path.join(msixStageRoot, certificateFileName);
  const signtoolPath = await resolveSigntoolPath();

  await signMsixWithPfxAndExportCertificate({
    msixFilePath: stagedMsixPath,
    certificatePath,
    pfxPath: options.signingPfxPath,
    pfxPassword: options.signingPfxPassword,
    timestampUrl: options.timestampUrl,
    publisher: options.publisher,
    signtoolPath,
    cwd: repoRoot,
    log,
  });

  await writeMsixReadme(msixStageRoot, options.releaseVersion, certificateFileName);

  return {
    sourceMsixPath: msixPath,
    stagedMsixPath,
    msixStageRoot,
    certificatePath,
  };
}

async function main() {
  const parsedOptions = parseArgs(process.argv.slice(2));
  if (parsedOptions.help) {
    console.log(
      [
        'Usage:',
        '  node tooling/scripts/windows-official-release-assets.mjs --tag=windows-vX.Y.Z',
        '    --publisher=<subject> --publisher-display-name=<name>',
        '    --signing-pfx-path=<path> --signing-pfx-password=<password>',
        '    --timestamp-url=<https-url> [--out-dir=<path>] [--desktop-sha=<sha>]',
        '    [--frontend-ref=<ref>] [--generated-at=<iso-string>] [--validate-only]',
      ].join('\n'),
    );
    return;
  }

  const options = validateOfficialReleaseOptions(parsedOptions);
  const signingSummary = await validateOfficialSigningConfig(options);
  if (options.validateOnly) {
    process.stdout.write(JSON.stringify(signingSummary));
    return;
  }

  await assertManifestReadyForOfficialRelease(options);

  const stagingRoot = path.join(options.outDir, 'payload');
  await rm(options.outDir, {recursive: true, force: true});
  await mkdir(stagingRoot, {recursive: true});

  log(`stagingRoot=${stagingRoot}`);
  const portableStageRoot = await stagePortableBundle(stagingRoot, options);
  const msixBundle = await stageMsixBundle(stagingRoot, options);

  const portableZipPath = path.join(options.outDir, portableZipName);
  const msixBundleZipPath = path.join(options.outDir, msixBundleZipName);
  await createZipFromDirectory(portableStageRoot, portableZipPath);
  await createZipFromDirectory(msixBundle.msixStageRoot, msixBundleZipPath);

  const releaseNotesPath = path.join(options.outDir, releaseNotesFileName);
  await writeFile(
    releaseNotesPath,
    buildReleaseNotes({
      releaseTitle: options.releaseTitle,
      releaseTag: options.releaseTag,
      releaseVersion: options.releaseVersion,
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
        releaseTag: options.releaseTag,
        releaseTitle: options.releaseTitle,
        releaseVersion: options.releaseVersion,
        msixVersion: options.msixVersion,
        generatedAt: options.generatedAt,
        desktopSha: options.desktopSha,
        frontendRef: options.frontendRef,
        signing: {
          publisher: options.publisher,
          publisherDisplayName: options.publisherDisplayName,
          timestampUrl: options.timestampUrl,
          certificateSubject: signingSummary.subject,
        },
        sourceRoots: {
          portableReleaseRoot,
          msixAppPackagesRoot: appPackagesRoot,
          selectedMsixPath: msixBundle.sourceMsixPath,
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
          stagedMsixPath: msixBundle.stagedMsixPath,
          certificatePath: msixBundle.certificatePath,
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

if (isDirectRun) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
