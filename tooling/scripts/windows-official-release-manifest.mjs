import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';

import {packageManifestPath} from './windows-release-assets-common.mjs';
import {normalizeCliValue} from './windows-signing.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === scriptPath;
export const officialReleaseTagPattern = /^windows-v(\d+)\.(\d+)\.(\d+)$/;

export function parseOfficialReleaseTag(tag) {
  const normalizedTag = normalizeCliValue(tag);
  if (!normalizedTag) {
    throw new Error('Official Windows release requires a non-empty Git tag like windows-v1.2.3.');
  }

  const match = normalizedTag.match(officialReleaseTagPattern);
  if (!match) {
    throw new Error(
      `Unsupported Windows release tag '${normalizedTag}'. Expected windows-vX.Y.Z.`,
    );
  }

  const [, major, minor, patch] = match;
  const releaseVersion = `${major}.${minor}.${patch}`;
  return {
    releaseTag: normalizedTag,
    releaseVersion,
    msixVersion: `${releaseVersion}.0`,
    releaseTitle: `OPApp Windows v${releaseVersion}`,
  };
}

function escapeXmlText(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export function applyPackageManifestOverrides(
  manifestContent,
  {publisher, publisherDisplayName, version},
) {
  let nextContent = manifestContent;
  const replacements = [
    {
      pattern: /(<Identity\b[^>]*\bPublisher=")([^"]+)(")/i,
      value: escapeXmlText(publisher),
      label: 'Identity Publisher',
    },
    {
      pattern: /(<Identity\b[^>]*\bVersion=")([^"]+)(")/i,
      value: escapeXmlText(version),
      label: 'Identity Version',
    },
    {
      pattern: /(<PublisherDisplayName>)([^<]*)(<\/PublisherDisplayName>)/i,
      value: escapeXmlText(publisherDisplayName),
      label: 'PublisherDisplayName',
    },
  ];

  for (const replacement of replacements) {
    if (!replacement.pattern.test(nextContent)) {
      throw new Error(`Could not find ${replacement.label} in Package.appxmanifest.`);
    }

    nextContent = nextContent.replace(
      replacement.pattern,
      (_, prefix, _currentValue, suffix) => `${prefix}${replacement.value}${suffix}`,
    );
  }

  return nextContent;
}

export function parseArgs(argv, env = process.env) {
  const options = {
    manifestPath: packageManifestPath,
    tag: normalizeCliValue(env.GITHUB_REF_NAME),
    publisher: normalizeCliValue(env.OPAPP_WINDOWS_OFFICIAL_PUBLISHER),
    publisherDisplayName: normalizeCliValue(
      env.OPAPP_WINDOWS_OFFICIAL_PUBLISHER_DISPLAY_NAME,
    ),
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
      case 'manifest-path':
        options.manifestPath = path.resolve(value);
        break;
      case 'tag':
        options.tag = value;
        break;
      case 'publisher':
        options.publisher = value;
        break;
      case 'publisher-display-name':
        options.publisherDisplayName = value;
        break;
      default:
        throw new Error(`Unknown argument '--${key}'.`);
    }
  }

  if (options.help) {
    return options;
  }

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

  return options;
}

export async function writeOfficialReleaseManifest({
  manifestPath = packageManifestPath,
  tag,
  publisher,
  publisherDisplayName,
}) {
  const release = parseOfficialReleaseTag(tag);
  const currentManifest = await readFile(manifestPath, 'utf8');
  const nextManifest = applyPackageManifestOverrides(currentManifest, {
    publisher,
    publisherDisplayName,
    version: release.msixVersion,
  });
  await writeFile(manifestPath, nextManifest, 'utf8');

  return {
    manifestPath,
    publisher,
    publisherDisplayName,
    ...release,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(
      [
        'Usage:',
        '  node tooling/scripts/windows-official-release-manifest.mjs',
        '    --tag=windows-vX.Y.Z --publisher=<subject>',
        '    --publisher-display-name=<name> [--manifest-path=<path>]',
      ].join('\n'),
    );
    return;
  }

  const result = await writeOfficialReleaseManifest({
    manifestPath: options.manifestPath,
    tag: options.tag,
    publisher: options.publisher,
    publisherDisplayName: options.publisherDisplayName,
  });
  process.stdout.write(JSON.stringify(result));
}

if (isDirectRun) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
