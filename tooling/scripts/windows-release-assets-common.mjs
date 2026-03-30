import {createHash} from 'node:crypto';
import {copyFile, mkdir, readdir, readFile, stat, writeFile} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';

import {
  ensurePathExists,
  escapePowerShellLiteral,
  runPowerShellOrThrow,
} from './windows-signing.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(scriptDir, '..', '..');
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

export async function findPreferredMsixFile(searchRoot = appPackagesRoot) {
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
    const discoveredArchitectures = [
      ...new Set(candidates.map(candidate => detectMsixArchitecture(candidate.filePath))),
    ].sort();
    throw new Error(
      `Could not find a user-installable ${preferredArchitecture} .msix under ${searchRoot}. Found architectures: ${discoveredArchitectures.join(', ')}.`,
    );
  }

  preferredCandidates.sort(compareMsixCandidates);
  return preferredCandidates[0].filePath;
}

export async function copyTreeFiltered(sourceRoot, destinationRoot, filterRelativePath) {
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

export async function createZipFromDirectory(
  sourceDirectoryPath,
  zipFilePath,
  {cwd = repoRoot, env = process.env} = {},
) {
  const escapedSource = escapePowerShellLiteral(sourceDirectoryPath);
  const escapedDestination = escapePowerShellLiteral(zipFilePath);
  runPowerShellOrThrow(
    `Compress-Archive -LiteralPath '${escapedSource}' -DestinationPath '${escapedDestination}' -Force`,
    {cwd, env, label: 'Compress-Archive'},
  );
}

export async function sha256File(filePath) {
  const content = await readFile(filePath);
  return createHash('sha256').update(content).digest('hex');
}

export async function writeChecksumsFile(outputPaths, checksumsPath) {
  const lines = [];
  for (const outputPath of outputPaths) {
    const checksum = await sha256File(outputPath);
    lines.push(`${checksum}  ${path.basename(outputPath)}`);
  }

  await writeFile(checksumsPath, lines.join('\n') + '\n', 'utf8');
}
