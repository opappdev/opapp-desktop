import {mkdir, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';

import {
  appPackagesRoot,
  copyTreeFiltered,
  createZipFromDirectory,
  findPreferredMsixFile,
  portableReleaseRoot,
  repoRoot,
  shouldCopyMsixRelativePath,
  shouldCopyPortableRelativePath,
  writeChecksumsFile,
  compareMsixCandidates,
} from './windows-release-assets-common.mjs';
import {normalizeCliValue} from './windows-signing.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === scriptPath;

export {compareMsixCandidates, findPreferredMsixFile, shouldCopyMsixRelativePath, shouldCopyPortableRelativePath};
export const defaultOutDir = path.join(repoRoot, '.dist', 'windows-nightly-release');

const portableFolderName = 'opapp-windows-nightly-x64-portable';
const portableZipName = `${portableFolderName}.zip`;
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

function log(message) {
  console.log(`[windows-nightly-release-assets] ${message}`);
}

export function buildReleaseNotes({
  desktopSha,
  frontendRef,
  generatedAt,
  portableZipName: portableAssetName = portableZipName,
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
    `- \`${portableAssetName}\`: unzip, keep the folder intact, and run \`OpappWindowsHost.exe\`. This is the supported nightly path.`,
    '',
    '## Notes',
    '',
    '- Windows release builds default their OTA remote base to `https://r2.opapp.dev` unless launch config or `OPAPP_OTA_REMOTE_URL` overrides it for smoke/testing.',
    '- Packaged builds only embed `opapp.companion.main`; private bundles such as `opapp.hbr.workspace` are expected to hydrate from the remote OTA catalog on demand.',
    '- The direct-run executable must stay beside its bundled DLLs and `Bundle/` directory; downloading a bare exe by itself is not a supported distribution shape.',
    '- Nightly publishing does not ship a packaged MSIX bundle anymore; local Debug AppX installs can share the same package identity/version and make nightly sideloads look like a dev launch. Use the portable zip for nightly validation, and keep packaged MSIX distribution for tagged official releases.',
    '- These assets are nightly builds intended for internal testing and fast validation, not polished end-user installers.',
    '',
  ].join('\n');
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

async function stagePortableBundle(stagingRoot) {
  const portableStageRoot = path.join(stagingRoot, portableFolderName);
  await copyTreeFiltered(
    portableReleaseRoot,
    portableStageRoot,
    shouldCopyPortableRelativePath,
  );
  await writePortableReadme(portableStageRoot);
  return portableStageRoot;
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

  const portableZipPath = path.join(options.outDir, portableZipName);
  await createZipFromDirectory(portableStageRoot, portableZipPath);

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
  await writeChecksumsFile([portableZipPath], checksumsPath);

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
        },
        assets: [
          {
            path: portableZipPath,
            label: 'portable',
            recommended: true,
          },
          {
            path: checksumsPath,
            label: 'checksums',
            recommended: false,
          },
        ],
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );

  log(`portableZip=${portableZipPath}`);
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
