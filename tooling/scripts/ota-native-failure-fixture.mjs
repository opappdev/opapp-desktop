import {createHash} from 'node:crypto';
import {mkdir, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';

const DEFAULT_BUNDLE_ID = 'opapp.companion.main';
const DEFAULT_CHANNEL = 'stable';
const DEFAULT_PLATFORM = 'windows';
const DEFAULT_VERSION = '9.9.9';
const DEFAULT_MODE = 'download-manifest-404';
const ENTRY_FILE = 'bundle.js';

const fixtureModes = {
  'download-manifest-404': {
    description: 'Index resolves normally, but the version directory omits bundle-manifest.json.',
    expectedNativeMarker: 'OTA.Native.DownloadManifest',
  },
  'manifest-parse': {
    description: 'bundle-manifest.json exists but contains invalid JSON.',
    expectedNativeMarker: 'OTA.Native.ManifestParseFailed',
  },
  'manifest-missing-entry-file': {
    description: 'bundle-manifest.json exists but omits entryFile.',
    expectedNativeMarker: 'OTA.Native.ManifestMissingEntryFile',
  },
  'download-entry-file-404': {
    description: 'bundle-manifest.json points at a JS bundle that is missing from the registry.',
    expectedNativeMarker: 'OTA.Native.DownloadEntryFile',
  },
  'checksum-invalid-metadata': {
    description: 'bundle-manifest.json ships a checksum object with missing algorithm/value metadata.',
    expectedNativeMarker: 'OTA.Native.Checksum.Failed reason=invalid-checksum-metadata',
  },
  'checksum-unsupported-algorithm': {
    description: 'bundle-manifest.json requests a checksum algorithm that native OTA rejects.',
    expectedNativeMarker: 'OTA.Native.Checksum.Failed reason=unsupported-algorithm',
  },
  'checksum-mismatch': {
    description: 'bundle-manifest.json checksum does not match the downloaded bundle bytes.',
    expectedNativeMarker: 'OTA.Native.Checksum.Failed reason=mismatch',
  },
};

function parseArg(name) {
  return process.argv.find(argument => argument.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
}

function usage() {
  process.stdout.write(
    [
      'Usage: node ./tooling/scripts/ota-native-failure-fixture.mjs [options]',
      '',
      'Options:',
      `  --mode=<${Object.keys(fixtureModes).join('|')}>`,
      `  --bundle-id=<id>        Default: ${DEFAULT_BUNDLE_ID}`,
      `  --channel=<name>        Default: ${DEFAULT_CHANNEL}`,
      `  --platform=<name>       Default: ${DEFAULT_PLATFORM}`,
      `  --version=<value>       Default: ${DEFAULT_VERSION}`,
      '  --out-dir=<path>        Default: temp directory',
      '  --help                  Show this message',
      '',
      'The script prints a JSON summary. Serve the generated registry root over HTTP',
      'and pass that base URL to `npm run verify:windows -- --ota-remote=<url> --ota-expected-status=failed`.',
    ].join('\n') + '\n',
  );
}

async function writeJson(filePath, data) {
  await mkdir(path.dirname(filePath), {recursive: true});
  await writeFile(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function buildIndex({bundleId, channel, version}) {
  const channels = {stable: version};
  if (channel !== 'stable') {
    channels[channel] = version;
  }
  return {
    bundles: {
      [bundleId]: {
        latestVersion: version,
        versions: [version],
        channels,
      },
    },
  };
}

function buildBundleSource({bundleId, version, platform}) {
  return `// synthetic native OTA failure fixture: ${bundleId}@${version} [${platform}]\n`;
}

function buildManifest({bundleId, channel, mode, platform, version}) {
  const manifest = {
    bundleId,
    version,
    platform,
    sourceKind: 'synthetic-native-ota-failure-fixture',
  };
  if (mode !== 'manifest-missing-entry-file') {
    manifest.entryFile = ENTRY_FILE;
  }
  if (mode === 'checksum-invalid-metadata') {
    manifest.checksum = {algorithm: '', value: ''};
  } else if (mode === 'checksum-unsupported-algorithm') {
    manifest.checksum = {algorithm: 'sha1', value: 'placeholder'};
  } else if (mode === 'checksum-mismatch') {
    manifest.checksum = {
      algorithm: 'sha256',
      value: '0'.repeat(64),
    };
  }
  if (channel !== 'stable') {
    manifest.channel = channel;
  }
  return manifest;
}

export async function createNativeOtaFailureFixture({
  bundleId = DEFAULT_BUNDLE_ID,
  channel = DEFAULT_CHANNEL,
  mode = DEFAULT_MODE,
  outDir,
  platform = DEFAULT_PLATFORM,
  version = DEFAULT_VERSION,
} = {}) {
  const fixtureMode = fixtureModes[mode];
  if (!fixtureMode) {
    throw new Error(
      `Unsupported native OTA failure fixture mode '${mode}'. Supported modes: ${Object.keys(fixtureModes).join(', ')}.`,
    );
  }
  const registryRoot =
    outDir ??
    path.join(
      tmpdir(),
      `opapp-native-ota-failure-${mode}-${Date.now()}`,
    );
  const artifactDir = path.join(registryRoot, bundleId, version, platform);
  const manifestPath = path.join(artifactDir, 'bundle-manifest.json');
  const entryFilePath = path.join(artifactDir, ENTRY_FILE);

  await mkdir(artifactDir, {recursive: true});
  await writeJson(path.join(registryRoot, 'index.json'), buildIndex({bundleId, channel, version}));

  if (mode === 'download-manifest-404') {
    return {
      bundleId,
      channel,
      expectedNativeMarker: fixtureMode.expectedNativeMarker,
      manifestPath,
      mode,
      platform,
      registryRoot,
      version,
    };
  }

  if (mode === 'manifest-parse') {
    await writeFile(manifestPath, '{"broken": true', 'utf8');
    return {
      bundleId,
      channel,
      expectedNativeMarker: fixtureMode.expectedNativeMarker,
      manifestPath,
      mode,
      platform,
      registryRoot,
      version,
    };
  }

  const bundleSource = buildBundleSource({bundleId, platform, version});
  const manifest = buildManifest({bundleId, channel, mode, platform, version});
  await writeJson(manifestPath, manifest);

  if (mode !== 'download-entry-file-404') {
    await writeFile(entryFilePath, bundleSource, 'utf8');
  }

  return {
    bundleId,
    channel,
    description: fixtureMode.description,
    entryFilePath: mode === 'download-entry-file-404' ? null : entryFilePath,
    expectedNativeMarker: fixtureMode.expectedNativeMarker,
    manifestPath,
    mode,
    platform,
    registryRoot,
    version,
  };
}

async function main() {
  if (process.argv.includes('--help')) {
    usage();
    return;
  }

  const summary = await createNativeOtaFailureFixture({
    bundleId: parseArg('bundle-id') ?? DEFAULT_BUNDLE_ID,
    channel: parseArg('channel') ?? DEFAULT_CHANNEL,
    mode: parseArg('mode') ?? DEFAULT_MODE,
    outDir: parseArg('out-dir') ?? undefined,
    platform: parseArg('platform') ?? DEFAULT_PLATFORM,
    version: parseArg('version') ?? DEFAULT_VERSION,
  });
  process.stdout.write(
    JSON.stringify(
      {
        ...summary,
        expectedStatus: 'failed',
        nextStep:
          'Serve registryRoot over HTTP and pass the base URL to verify:windows with --ota-expected-status=failed.',
      },
      null,
      2,
    ) + '\n',
  );
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? '')) {
  main().catch(error => {
    process.stderr.write(`[ota-native-failure-fixture] ${error.stack ?? error.message}\n`);
    process.exit(1);
  });
}
