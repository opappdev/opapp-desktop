import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {createServer} from 'node:http';
import {cp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {publishToLocalRegistry, SiblingArtifactSource} from './artifact-source.mjs';
import {parsePositiveIntegerArg} from './windows-args-common.mjs';
import {
  classifyRunWindowsFailure,
  collectPortableMsbuildFallbackCandidates,
  collectPortableMsbuildFallbackProfiles,
  collectReleaseBuildProbe,
  formatReleaseFailureDiagnostics,
  formatReleaseProbeReport,
  getBlockingReleaseProbeFailure,
  getPortableMsbuildFallbackBlocker,
  formatReleaseProbeForLogs,
  refineReleaseFailureClassification,
} from './windows-release-diagnostics.mjs';
import {
  buildTimingPhaseResult,
  formatMarkerTimeoutMessage,
  formatMarkerTimingSummary,
} from './windows-smoke-timing.mjs';
import {loadTimeoutDefaultsForLaunch} from './windows-timeout-defaults.mjs';
import {assertPngCaptureLooksOpaque} from './windows-image-inspection.mjs';

const scenarioArg = process.argv
  .find(argument => argument.startsWith('--scenario='))
  ?.split('=')[1];
const includeSecondaryWindow = process.argv.includes('--include-secondary-window');
const validateOnly = process.argv.includes('--validate-only');
const preflightOnly = process.argv.includes('--preflight-only');
const skipPrepare = process.argv.includes('--skip-prepare');
const preserveState = process.argv.includes('--preserve-state');
const resetSessions = process.argv.includes('--reset-sessions');
const launchModeArg = process.argv.find(argument => argument.startsWith('--launch='))?.split('=')[1];
const portableFlag = process.argv.includes('--portable');
const otaRemoteToken = process.argv.find(argument => argument.startsWith('--ota-remote='));
const otaRemoteArg = otaRemoteToken?.split('=').slice(1).join('=');
const otaChannelToken = process.argv.find(argument => argument.startsWith('--ota-channel='));
const otaChannelArg = otaChannelToken?.split('=').slice(1).join('=');
const otaForceFlag = process.argv.includes('--ota-force');
const otaExpectedStatusToken = process.argv.find(argument => argument.startsWith('--ota-expected-status='));
const otaExpectedStatusArg = otaExpectedStatusToken?.split('=').slice(1).join('=');
const supportedOtaExpectedStatuses = new Set(['success', 'updated', 'up-to-date', 'failed']);
const otaExpectedStatus = otaExpectedStatusArg ?? 'success';
let activeOtaRemoteArg = otaRemoteArg ?? null;
let activeOtaChannelArg = otaChannelArg ?? null;
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');
const workspaceRoot = path.resolve(repoRoot, '..');
const frontendRoot = path.join(workspaceRoot, 'opapp-frontend');
const optionalPrivateScenarioModulePath = path.join(
  repoRoot,
  'tooling',
  'scripts',
  '.private-companion',
  'windows-private-scenarios.mjs',
);
const hermesBytecodeMagic = 0x1F1903C103BC1FC6n;
const frontendBundleScriptPath = path.join(frontendRoot, 'tooling', 'scripts', 'bundle-companion-windows.mjs');
const frontendBundleRoot = path.join(frontendRoot, '.dist', 'bundles', 'companion-app', 'windows');
const hostRoot = path.join(repoRoot, 'hosts', 'windows-host');
const hostBundleRoot = path.join(hostRoot, 'windows', 'OpappWindowsHost', 'Bundle');
const portableReleaseRoot = path.join(hostRoot, 'windows', 'x64', 'Release');
const portableExePath = path.join(portableReleaseRoot, 'OpappWindowsHost.exe');
const windowsSolutionRoot = path.join(hostRoot, 'windows');
const windowsSolutionPath = path.join(windowsSolutionRoot, 'OpappWindowsHost.sln');
const tempRoot = process.env.TEMP || process.env.TMP || path.join(workspaceRoot, '.tmp');
const logPath = path.join(tempRoot, 'opapp-windows-host.log');
const launchConfigPath = path.join(tempRoot, 'opapp-windows-host.launch.ini');
const preferencesPath = path.join(tempRoot, 'opapp-windows-host.preferences.ini');
const sessionsPath = path.join(tempRoot, 'opapp-windows-host.sessions.ini');
const otaCacheRoot = path.join(repoRoot, '.ota-cache');
const otaIndexPath = path.join(otaCacheRoot, 'index.json');
const otaLastRunPath = path.join(otaCacheRoot, 'last-run.json');
const otaStatePath = path.join(otaCacheRoot, 'ota-state.json');
const otaChannelPath = path.join(otaCacheRoot, 'channel.json');
const otaDeviceIdPath = path.join(otaCacheRoot, 'device-id.json');
const userDataRoot = path.join(
  process.env.LOCALAPPDATA || path.join(workspaceRoot, '.tmp'),
  'OPApp',
);
const companionStartupTargetPath = path.join(
  userDataRoot,
  'startup',
  'companion-startup-target.json',
);
const runWindowsCliWrapperPath = path.join(repoRoot, 'tooling', 'scripts', 'run-windows-cli-wrapper.cjs');
const packageName = 'OpappWindowsHost';
const applicationId = 'App';
const windowPolicyRegistryPath = path.join(frontendRoot, 'contracts', 'windowing', 'src', 'window-policy-registry.json');
const missingOptionalFile = Symbol('missingOptionalFile');
const launcherProvenanceFixture = {
  mainBundleId: 'opapp.companion.main',
  mainSurfaceIds: [
    'companion.main',
    'companion.settings',
    'companion.view-shot',
    'companion.window-capture',
  ],
  nativeApplied: {
    bundleId: 'opapp.hbr.workspace',
    latestVersion: '0.9.2',
    surfaceIds: ['hbr.challenge-advisor'],
  },
  versionDrift: {
    bundleId: 'opapp.hbr.archive',
    latestVersion: '0.9.0',
    localVersion: '0.8.0',
    surfaceIds: ['hbr.archive-advisor'],
    sourceKind: 'local-build',
  },
  localOnly: {
    bundleId: 'opapp.private.shadow',
    localVersion: '0.1.0',
    surfaceIds: ['hbr.private-shadow'],
    sourceKind: 'local-build',
  },
};
const companionChatBundleId = 'opapp.companion.chat';
const companionChatSurfaceId = 'companion.chat.main';
const companionChatBundleRootMarker = `Bundle\\bundles\\${companionChatBundleId}`;
const frontendChatBundleRoot = path.join(frontendBundleRoot, 'bundles', companionChatBundleId);
const launchMode = resolveLaunchModeOrThrow();
const timeoutDefaults = loadTimeoutDefaultsForLaunch({
  argv: process.argv,
  launchMode,
});
const timeoutDefaultsPath = timeoutDefaults?.defaultsPath ?? null;
const selectedTimeoutDefaults = timeoutDefaults?.defaults ?? null;
const suggestedVerifyTotalTimeoutMs = selectedTimeoutDefaults?.verifyTotalMs ?? null;
const defaultReadinessTimeoutMs = selectedTimeoutDefaults?.readinessMs ?? 25_000;
const readinessTimeoutMs = parsePositiveIntegerArg(
  process.argv,
  '--readiness-ms',
  defaultReadinessTimeoutMs,
);
const smokeTimeoutMs = parsePositiveIntegerArg(
  process.argv,
  '--smoke-ms',
  selectedTimeoutDefaults?.smokeMs ?? readinessTimeoutMs,
);
const startupTimeoutMs = parsePositiveIntegerArg(
  process.argv,
  '--startup-ms',
  selectedTimeoutDefaults?.startupMs ?? smokeTimeoutMs,
);
const scenarioTimeoutMs = parsePositiveIntegerArg(
  process.argv,
  '--scenario-ms',
  selectedTimeoutDefaults?.scenarioMs ?? smokeTimeoutMs,
);

let windowPolicyRegistryCache = null;

function resolveLaunchModeOrThrow() {
  if (portableFlag) {
    if (launchModeArg && launchModeArg !== 'portable') {
      throw new Error(
        `--portable conflicts with --launch=${launchModeArg}. Use --launch=portable or remove --portable.`,
      );
    }

    return 'portable';
  }

  if (!launchModeArg || launchModeArg === 'packaged') {
    return 'packaged';
  }

  if (launchModeArg === 'portable') {
    return 'portable';
  }

  throw new Error(
    `Unknown --launch=${launchModeArg}. Supported launch modes: packaged, portable.`,
  );
}

function resolveScenarioNameOrThrow() {
  if (scenarioArg !== undefined) {
    const normalizedScenarioName = scenarioArg.trim();
    if (!normalizedScenarioName) {
      throw new Error('`--scenario=` must include exactly one supported scenario name.');
    }
    if (normalizedScenarioName.includes(',')) {
      throw new Error(
        '`windows-release-smoke` accepts a single --scenario value; use verify-windows for multi-scenario execution.',
      );
    }
    if (!supportedScenarioNames.includes(normalizedScenarioName)) {
      throw new Error(
        `Unknown --scenario=${normalizedScenarioName}. Supported scenarios: ${supportedScenarioNames.join(', ')}`,
      );
    }
    if (includeSecondaryWindow && normalizedScenarioName !== 'secondary-window') {
      throw new Error(
        `--include-secondary-window conflicts with --scenario=${normalizedScenarioName}. ` +
          'Use --scenario=secondary-window when selecting an explicit scenario.',
      );
    }
    return normalizedScenarioName;
  }

  return includeSecondaryWindow ? 'secondary-window' : 'tab-session';
}

function validateOtaArgs() {
  if (otaRemoteArg !== undefined && otaRemoteArg.trim().length === 0) {
    throw new Error('`--ota-remote=` must include a non-empty URL.');
  }
  if (otaChannelArg !== undefined && otaChannelArg.trim().length === 0) {
    throw new Error('`--ota-channel=` must include a non-empty channel name.');
  }
  if (otaExpectedStatusArg !== undefined && otaExpectedStatusArg.trim().length === 0) {
    throw new Error(
      '`--ota-expected-status=` must be one of success, updated, up-to-date, failed.',
    );
  }
  if (
    otaExpectedStatusArg !== undefined &&
    !supportedOtaExpectedStatuses.has(otaExpectedStatusArg)
  ) {
    throw new Error(
      '`--ota-expected-status=` must be one of success, updated, up-to-date, failed.',
    );
  }
  if (
    !otaRemoteArg &&
    (otaChannelArg !== undefined || otaForceFlag || otaExpectedStatusArg !== undefined)
  ) {
    throw new Error(
      '`--ota-channel`, `--ota-force`, and `--ota-expected-status` require `--ota-remote=<url>`.',
    );
  }
}
function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function normalizeLogContents(logContents) {
  return logContents.replace(/\r/g, '');
}

async function startRegistryServer(registryRoot) {
  return await new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const requestPath = decodeURIComponent(url.pathname);
        const filePath = path.join(registryRoot, ...requestPath.split('/').filter(Boolean));
        const normalizedRoot = path.resolve(registryRoot);
        const normalizedFilePath = path.resolve(filePath);
        if (
          normalizedFilePath !== normalizedRoot &&
          !normalizedFilePath.startsWith(`${normalizedRoot}${path.sep}`)
        ) {
          res.writeHead(403);
          res.end('forbidden');
          return;
        }

        const body = await readFile(normalizedFilePath);
        const contentType = normalizedFilePath.endsWith('.json')
          ? 'application/json'
          : 'application/octet-stream';
        res.writeHead(200, {'Content-Type': contentType});
        res.end(body);
      } catch (error) {
        if (error?.code === 'ENOENT') {
          res.writeHead(404);
          res.end('not found');
          return;
        }

        res.writeHead(500);
        res.end(error instanceof Error ? error.message : String(error));
      }
    });

    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Registry server did not expose a numeric port.'));
        return;
      }

      resolve({
        server,
        baseUrl: `http://127.0.0.1:${address.port}`,
      });
    });
    server.on('error', reject);
  });
}

async function closeRegistryServer(server) {
  if (!server) {
    return;
  }

  await new Promise((resolve, reject) => {
    server.close(error => {
      if (error) {
        reject(error);
        return;
      }

      resolve(undefined);
    });
  });
}

async function createCompanionChatOtaFixture() {
  const registryRoot = path.join(tempRoot, `opapp-companion-chat-ota-${Date.now()}`);
  await mkdir(registryRoot, {recursive: true});
  await publishToLocalRegistry(frontendChatBundleRoot, registryRoot);

  const chatManifest = JSON.parse(
    await readFile(path.join(frontendChatBundleRoot, 'bundle-manifest.json'), 'utf8'),
  );
  const version = chatManifest?.version;
  if (typeof version !== 'string' || !version) {
    throw new Error('Windows release smoke failed: companion chat bundle manifest is missing version.');
  }

  await writeFile(
    path.join(registryRoot, 'index.json'),
    JSON.stringify(
      {
        bundles: {
          [companionChatBundleId]: {
            latestVersion: version,
            versions: [version],
            channels: {
              nightly: version,
            },
          },
        },
      },
      null,
      2,
    ),
    'utf8',
  );

  const serverHandle = await startRegistryServer(registryRoot);
  log(`companion chat ota fixture registryRoot=${registryRoot}`);
  log(`companion chat ota fixture remote=${serverHandle.baseUrl}`);
  return {
    registryRoot,
    server: serverHandle.server,
    otaRemoteBaseUrl: serverHandle.baseUrl,
    otaChannel: 'nightly',
  };
}

function assertLogDoesNotContain(logContents, marker, reason) {
  if (normalizeLogContents(logContents).includes(marker)) {
    throw new Error(`Windows release smoke failed: ${reason}`);
  }
}

function assertLogContainsRegex(logContents, regex, reason) {
  if (!regex.test(normalizeLogContents(logContents))) {
    throw new Error(`Windows release smoke failed: ${reason}`);
  }
}

function extractLoggedPath(logContents, regex, reason) {
  const match = normalizeLogContents(logContents).match(regex);
  if (!match?.[1]) {
    throw new Error(`Windows release smoke failed: ${reason}`);
  }

  return match[1].trim();
}

function extractRuntimeBundleRoot(logContents) {
  return extractLoggedPath(
    logContents,
    /Runtime=Bundle root=(.+?) file=/,
    'runtime bundle root was not logged.',
  );
}

function extractOtaTargetEvents(logContents) {
  return normalizeLogContents(logContents)
    .split('\n')
    .filter(
      line =>
        line.includes('OTA.SpawnUpdateProcess ') || line.includes('OTA.EnsureBundle.Start '),
    )
    .map(line => ({
      bundleId: line.match(/\bbundleId=([^\r\n ]+)/)?.[1] ?? null,
      hostBundleDir:
        line.match(/\bhostBundleDir=(.+?)(?= currentVersion=| channel=| force=|$)/)?.[1]?.trim() ??
        null,
      currentVersion: line.match(/\bcurrentVersion=([^\r\n ]+)/)?.[1] ?? null,
    }));
}

export function extractOtaSpawnHostBundleDir(logContents, bundleId = null) {
  const matches = extractOtaTargetEvents(logContents).filter(
    event => event.hostBundleDir && (bundleId === null || event.bundleId === bundleId),
  );

  return matches.at(-1)?.hostBundleDir ?? null;
}

function extractOtaLoggedCurrentVersion(logContents, bundleId = null) {
  const matches = extractOtaTargetEvents(logContents).filter(
    event => event.currentVersion && (bundleId === null || event.bundleId === bundleId),
  );

  return matches.at(-1)?.currentVersion ?? null;
}

async function snapshotOptionalTextFile(filePath) {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return missingOptionalFile;
    }

    throw error;
  }
}

async function restoreOptionalTextFile(filePath, snapshot) {
  if (snapshot === missingOptionalFile) {
    await rm(filePath, {force: true});
    return;
  }

  await mkdir(path.dirname(filePath), {recursive: true});
  await writeFile(filePath, snapshot, 'utf8');
}

function buildPersistedSessionFile(sessionEntries) {
  let content = '[session]\n';

  for (const [windowId, payload] of Object.entries(sessionEntries)) {
    content += `${windowId}=${JSON.stringify(payload)}\n`;
  }

  return content;
}

async function getWindowPolicyRegistry() {
  if (!windowPolicyRegistryCache) {
    windowPolicyRegistryCache = JSON.parse(await readFile(windowPolicyRegistryPath, 'utf8'));
  }

  return windowPolicyRegistryCache;
}

function parseWorkArea(logContents) {
  const match = normalizeLogContents(logContents).match(/WorkArea=(\d+)x(\d+)/);
  if (!match) {
    throw new Error('Windows release smoke failed: missing WorkArea log entry.');
  }

  return {width: Number(match[1]), height: Number(match[2])};
}

function parseRect(logContents, prefix) {
  const regex = new RegExp(`${prefix}=(-?\\d+),(-?\\d+) (\\d+)x(\\d+)(?: mode=([a-z-]+))?`);
  const match = normalizeLogContents(logContents).match(regex);
  if (!match) {
    throw new Error(`Windows release smoke failed: missing ${prefix} log entry.`);
  }

  return {
    x: Number(match[1]),
    y: Number(match[2]),
    width: Number(match[3]),
    height: Number(match[4]),
    mode: match[5] ?? null,
  };
}

function isHermesBytecodeBuffer(buffer) {
  return Buffer.isBuffer(buffer) &&
    buffer.length >= 8 &&
    buffer.readBigUInt64LE(0) === hermesBytecodeMagic;
}

async function assertStagedManifest() {
  // Reuse SiblingArtifactSource to validate manifest existence, platform, and
  // entryFile presence — the same checks that were duplicated here previously.
  const stagedSource = new SiblingArtifactSource(hostBundleRoot);
  let manifest, bundlePath;
  try {
    ({manifest, bundlePath} = await stagedSource.resolve({platform: 'windows'}));
  } catch (err) {
    throw new Error(`Windows release smoke failed: ${err.message}`);
  }

  const bundleFileContent = await readFile(bundlePath);
  if (!bundleFileContent || bundleFileContent.length === 0) {
    throw new Error(
      `Windows release smoke failed: staged bundle file '${manifest.entryFile}' is empty.`,
    );
  }

  if (manifest.bundleFormat !== 'hermes-bytecode') {
    throw new Error(
      `Windows release smoke failed: bundle-manifest.json bundleFormat is '${manifest.bundleFormat ?? 'unknown'}', expected 'hermes-bytecode'.`,
    );
  }

  if (!isHermesBytecodeBuffer(bundleFileContent)) {
    throw new Error(
      `Windows release smoke failed: staged bundle file '${manifest.entryFile}' is not Hermes bytecode.`,
    );
  }

  if (manifest.sourceKind !== 'sibling-staging') {
    throw new Error(
      `Windows release smoke failed: bundle-manifest.json sourceKind is '${manifest.sourceKind}', expected 'sibling-staging'. ` +
      'Staging step must overwrite sourceKind when copying manifest to the host Bundle directory.',
    );
  }

  log(`manifest OK: bundleId=${manifest.bundleId} version=${manifest.version} surfaces=${manifest.surfaces?.join(',')} bundleFormat=${manifest.bundleFormat} sourceKind=${manifest.sourceKind}`);
}

async function assertBundledPolicyRegistry(logContents) {
  const normalized = normalizeLogContents(logContents);
  if (normalized.includes('WindowPolicyRegistrySource=emergency-fallback')) {
    throw new Error('Windows release smoke failed: host fell back to emergency window policy defaults.');
  }

  if (!/WindowPolicyRegistrySource=.*window-policy-registry\.json/.test(normalized)) {
    throw new Error('Windows release smoke failed: host did not load the bundled window policy registry artifact.');
  }
}

function parseSecondaryWindowRect(logContents, policyId, mode) {
  const regex = new RegExp(
    `SecondaryWindowRect surface=.* policy=${policyId} mode=${mode} rect=(-?\\d+),(-?\\d+) (\\d+)x(\\d+)`,
  );
  const match = normalizeLogContents(logContents).match(regex);
  if (!match) {
    throw new Error(`Windows release smoke failed: missing SecondaryWindowRect log entry for ${policyId}/${mode}.`);
  }

  return {
    x: Number(match[1]),
    y: Number(match[2]),
    width: Number(match[3]),
    height: Number(match[4]),
    mode,
  };
}

async function assertRectMatchesPolicy(logContents, prefix, policyId, mode) {
  const registry = await getWindowPolicyRegistry();
  const policy = registry[policyId];
  if (!policy) {
    throw new Error(`Windows release smoke failed: unknown window policy '${policyId}'.`);
  }

  const geometry = policy.geometry?.[mode];
  if (!geometry) {
    throw new Error(`Windows release smoke failed: policy '${policyId}' is missing geometry for mode '${mode}'.`);
  }

  const workArea = parseWorkArea(logContents);
  const rect = prefix === 'SecondaryWindowRect'
    ? parseSecondaryWindowRect(logContents, policyId, mode)
    : parseRect(logContents, prefix);
  const maxWidth = Math.max(900, workArea.width - 48);
  const maxHeight = Math.max(720, workArea.height - 48);
  const minWidth = Math.min(geometry.minWidth, maxWidth);
  const expectedWidth = clamp(Math.trunc(workArea.width * geometry.widthFactor), minWidth, maxWidth);
  const minHeight = Math.min(geometry.minHeight, maxHeight);
  const expectedHeight = clamp(Math.trunc(expectedWidth * geometry.aspectRatio), minHeight, maxHeight);

  if (rect.width !== expectedWidth || rect.height !== expectedHeight) {
    throw new Error(
      `Windows release smoke failed: ${prefix} expected ${expectedWidth}x${expectedHeight} for ${policyId}/${mode}, got ${rect.width}x${rect.height}.`,
    );
  }
}

function getPersistedSessionPayload(sessionFile, windowId) {
  const normalized = normalizeLogContents(sessionFile);
  const sessionSectionMatch = normalized.match(/\[session\]\n([\s\S]*?)(?:\n\[|$)/);
  if (!sessionSectionMatch) {
    return null;
  }

  for (const line of sessionSectionMatch[1].split('\n')) {
    if (!line.trim()) {
      continue;
    }

    const separatorIndex = line.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex);
    if (key === windowId) {
      return line.slice(separatorIndex + 1);
    }
  }

  return null;
}

function parsePersistedSessionDescriptor(sessionFile, windowId) {
  const payload = getPersistedSessionPayload(sessionFile, windowId);
  if (!payload) {
    throw new Error(`Windows release smoke failed: missing persisted session for ${windowId}.`);
  }

  try {
    return JSON.parse(payload);
  } catch (error) {
    throw new Error(
      `Windows release smoke failed: persisted session for ${windowId} was not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function assertPersistedSessionContains(sessionFile, windowId, marker, reason) {
  const payload = getPersistedSessionPayload(sessionFile, windowId);
  if (!payload) {
    throw new Error(`Windows release smoke failed: missing persisted session for ${windowId}.`);
  }

  if (!payload.includes(marker)) {
    throw new Error(`Windows release smoke failed: ${reason}`);
  }
}

function assertPersistedSessionDoesNotContain(sessionFile, windowId, marker, reason) {
  const payload = getPersistedSessionPayload(sessionFile, windowId);
  if (!payload) {
    throw new Error(`Windows release smoke failed: missing persisted session for ${windowId}.`);
  }

  if (payload.includes(marker)) {
    throw new Error(`Windows release smoke failed: ${reason}`);
  }
}

function assertPersistedSessionHasSurfaceId(sessionFile, windowId, surfaceId, reason) {
  const descriptor = parsePersistedSessionDescriptor(sessionFile, windowId);
  const tabs = Array.isArray(descriptor?.tabs) ? descriptor.tabs : [];
  if (!tabs.some(tab => tab?.surfaceId === surfaceId)) {
    throw new Error(`Windows release smoke failed: ${reason}`);
  }
}

function assertPersistedSessionLacksSurfaceId(sessionFile, windowId, surfaceId, reason) {
  const descriptor = parsePersistedSessionDescriptor(sessionFile, windowId);
  const tabs = Array.isArray(descriptor?.tabs) ? descriptor.tabs : [];
  if (tabs.some(tab => tab?.surfaceId === surfaceId)) {
    throw new Error(`Windows release smoke failed: ${reason}`);
  }
}

function parseFrontendDiagnosticPayload(payloadText) {
  try {
    const payload = JSON.parse(payloadText);
    return payload && typeof payload === 'object' && !Array.isArray(payload)
      ? payload
      : null;
  } catch {
    return null;
  }
}

export function extractFrontendDiagnosticEvents(logContents, eventName) {
  const prefix = '[frontend-diagnostics] ';
  const payloads = [];

  for (const line of normalizeLogContents(logContents).split('\n')) {
    const prefixIndex = line.indexOf(prefix);
    if (prefixIndex < 0) {
      continue;
    }

    const payload = parseFrontendDiagnosticPayload(
      line.slice(prefixIndex + prefix.length).trim(),
    );
    if (!payload || payload.event !== eventName) {
      continue;
    }

    payloads.push(payload);
  }

  return payloads;
}

function formatExpectedValue(value) {
  return value === null ? 'null' : JSON.stringify(value);
}

export function assertLauncherRemoteCatalogDiagnostics(
  logContents,
  {
    summary: expectedSummary,
    entries: expectedEntries,
  },
) {
  const summaryPayloads = extractFrontendDiagnosticEvents(
    logContents,
    'bundle-launcher.remote-catalog.summary',
  );
  if (summaryPayloads.length === 0) {
    throw new Error(
      'Windows release smoke failed: launcher remote catalog summary diagnostics were not logged.',
    );
  }

  const actualSummary = summaryPayloads.at(-1);
  for (const [field, expectedValue] of Object.entries(expectedSummary)) {
    if (actualSummary[field] !== expectedValue) {
      throw new Error(
        `Windows release smoke failed: launcher remote catalog summary field '${field}' ` +
          `was ${formatExpectedValue(actualSummary[field] ?? null)}, expected ${formatExpectedValue(expectedValue)}.`,
      );
    }
  }

  const entryPayloads = extractFrontendDiagnosticEvents(
    logContents,
    'bundle-launcher.remote-catalog.entry',
  );
  for (const expectedEntry of expectedEntries) {
    const actualEntry = entryPayloads.find(
      payload => payload.bundleId === expectedEntry.bundleId,
    );
    if (!actualEntry) {
      throw new Error(
        `Windows release smoke failed: launcher diagnostics are missing entry '${expectedEntry.bundleId}'.`,
      );
    }

    for (const [field, expectedValue] of Object.entries(expectedEntry)) {
      if (actualEntry[field] !== expectedValue) {
        throw new Error(
          `Windows release smoke failed: launcher diagnostics entry '${expectedEntry.bundleId}' field '${field}' ` +
            `was ${formatExpectedValue(actualEntry[field] ?? null)}, expected ${formatExpectedValue(expectedValue)}.`,
        );
      }
    }
  }
}

async function writeJsonFile(filePath, data) {
  await mkdir(path.dirname(filePath), {recursive: true});
  await writeFile(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

async function createSyntheticStagedBundle({
  bundleRoot,
  bundleId,
  sourceKind,
  surfaces,
  version,
}) {
  const stagedBundleRoot = path.join(bundleRoot, 'bundles', bundleId);
  const entryFile = 'index.windows';
  await mkdir(stagedBundleRoot, {recursive: true});
  await writeFile(
    path.join(stagedBundleRoot, entryFile),
    `// synthetic launcher smoke bundle: ${bundleId}@${version}\n`,
    'utf8',
  );
  await writeJsonFile(path.join(stagedBundleRoot, 'bundle-manifest.json'), {
    bundleId,
    version,
    platform: 'windows',
    entryFile,
    surfaces,
    sourceKind,
  });
  return stagedBundleRoot;
}

function shouldStagePackagedBundleRelativePath(relativePath) {
  if (!relativePath) {
    return true;
  }

  const normalized = relativePath.replace(/\\/g, '/');
  return normalized !== 'bundles' && !normalized.startsWith('bundles/');
}

async function resolveCurrentMainBundleVersion() {
  const manifest = JSON.parse(
    await readFile(path.join(hostBundleRoot, 'bundle-manifest.json'), 'utf8'),
  );
  const version =
    manifest && typeof manifest.version === 'string' ? manifest.version.trim() : '';
  if (!version) {
    throw new Error(
      'Windows release smoke failed: could not resolve the staged main bundle version for launcher provenance.',
    );
  }

  return version;
}

async function writeSyntheticCachedRemoteBundleManifest({
  bundleId,
  version,
  surfaces,
  sourceKind = 'windows-release-smoke-fixture',
}) {
  const manifestPath = path.join(
    otaCacheRoot,
    bundleId,
    version,
    'windows',
    'bundle-manifest.json',
  );
  await writeJsonFile(manifestPath, {
    bundleId,
    version,
    platform: 'windows',
    entryFile: 'bundle.js',
    surfaces,
    sourceKind,
  });

  return path.join(otaCacheRoot, bundleId);
}

async function seedLauncherProvenanceCachedCatalog() {
  const mainVersion = await resolveCurrentMainBundleVersion();
  const createdPaths = [];

  createdPaths.push(
    await writeSyntheticCachedRemoteBundleManifest({
      bundleId: launcherProvenanceFixture.mainBundleId,
      version: mainVersion,
      surfaces: launcherProvenanceFixture.mainSurfaceIds,
    }),
  );
  createdPaths.push(
    await writeSyntheticCachedRemoteBundleManifest({
      bundleId: launcherProvenanceFixture.versionDrift.bundleId,
      version: launcherProvenanceFixture.versionDrift.latestVersion,
      surfaces: launcherProvenanceFixture.versionDrift.surfaceIds,
    }),
  );

  await writeJsonFile(otaIndexPath, {
    bundles: {
      [launcherProvenanceFixture.mainBundleId]: {
        latestVersion: mainVersion,
        versions: [mainVersion],
        channels: {
          stable: mainVersion,
        },
      },
      [launcherProvenanceFixture.nativeApplied.bundleId]: {
        latestVersion: launcherProvenanceFixture.nativeApplied.latestVersion,
        versions: [launcherProvenanceFixture.nativeApplied.latestVersion],
        channels: {
          stable: launcherProvenanceFixture.nativeApplied.latestVersion,
        },
      },
      [launcherProvenanceFixture.versionDrift.bundleId]: {
        latestVersion: launcherProvenanceFixture.versionDrift.latestVersion,
        versions: [
          launcherProvenanceFixture.versionDrift.localVersion,
          launcherProvenanceFixture.versionDrift.latestVersion,
        ],
        channels: {
          stable: launcherProvenanceFixture.versionDrift.latestVersion,
        },
      },
    },
  });

  return createdPaths;
}

function getInstalledPackageInstallLocation() {
  const installLocation = runCaptureOrThrow(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `(Get-AppxPackage -Name '${packageName}' | Select-Object -First 1 -ExpandProperty InstallLocation)`,
    ],
    {cwd: repoRoot},
  ).trim();

  if (!installLocation) {
    throw new Error(`Could not resolve InstallLocation for ${packageName}.`);
  }

  return installLocation;
}

function resolveRuntimeBundleRootForLaunchMode() {
  if (launchMode === 'portable') {
    return path.join(portableReleaseRoot, 'Bundle');
  }

  return path.join(getInstalledPackageInstallLocation(), packageName, 'Bundle');
}

function normalizePrivateSmokeScenarioEntries(privateSmokeScenarios, sourceLabel) {
  if (!privateSmokeScenarios || typeof privateSmokeScenarios !== 'object') {
    throw new Error(
      `Invalid private smoke scenarios from ${sourceLabel}. Expected an object keyed by scenario name.`,
    );
  }

  return Object.entries(privateSmokeScenarios).map(([scenarioName, scenario]) => {
    if (
      typeof scenarioName !== 'string' ||
      scenarioName.length === 0 ||
      !scenario ||
      typeof scenario !== 'object' ||
      typeof scenario.description !== 'string' ||
      scenario.description.length === 0 ||
      !Array.isArray(scenario.successMarkers)
    ) {
      throw new Error(
        `Invalid private smoke scenario '${scenarioName}' from ${sourceLabel}. Expected an object with description and successMarkers[].`,
      );
    }

    return [scenarioName, scenario];
  });
}

async function loadOptionalPrivateSmokeScenarios() {
  if (!existsSync(optionalPrivateScenarioModulePath)) {
    return {};
  }

  const privateScenarioModule = await import(
    pathToFileURL(optionalPrivateScenarioModulePath).href
  );
  if (typeof privateScenarioModule.createPrivateSmokeScenarios !== 'function') {
    return {};
  }

  const privateSmokeScenarios =
    await privateScenarioModule.createPrivateSmokeScenarios({
      assertPersistedSessionContains,
      assertPersistedSessionHasSurfaceId,
      assertPersistedSessionLacksSurfaceId,
      assertRectMatchesPolicy,
      buildPersistedSessionFile,
      commonSuccessMarkers,
      companionStartupTargetPath,
      defaultPreferences,
      fileExists,
      normalizeLogContents,
      preferencesPath,
      readFile,
      sessionsPath,
      writeFile,
    });

  return Object.fromEntries(
    normalizePrivateSmokeScenarioEntries(
      privateSmokeScenarios,
      optionalPrivateScenarioModulePath,
    ),
  );
}

const commonSuccessMarkers = [
  'LaunchSurface surface=companion.main policy=main mode=',
  'InstanceLoaded failed=false',
  'NativeLogger[1] Running "OpappWindowsHost"',
  '[frontend-companion] render window=window.main surface=companion.main policy=main',
  '[frontend-companion] mounted window=window.main surface=companion.main policy=main',
  'BundleManifestSource=manifest',
];

const defaultPreferences = {
  mainWindowMode: 'wide',
  settingsWindowMode: 'compact',
  settingsPresentation: 'current-window',
};

const bootstrapCompactPreferences = {
  mainWindowMode: 'compact',
  settingsWindowMode: 'compact',
  settingsPresentation: 'current-window',
};

const publicSmokeScenarios = {
  'main-window-bootstrap-compact': {
    description: 'saved main window mode is applied during startup bootstrap',
    preferences: bootstrapCompactPreferences,
    launchConfig: {},
    successMarkers: [
      ...commonSuccessMarkers,
      'LaunchSurface surface=companion.main policy=main mode=compact',
      'WindowRect=',
    ],
    async verifyLog(logContents) {
      if (!/WindowRect=.*mode=compact/.test(normalizeLogContents(logContents))) {
        throw new Error('Windows release smoke failed: startup did not apply compact mode to the main window.');
      }

      await assertRectMatchesPolicy(logContents, 'WindowRect', 'main', 'compact');
    },
    verifyPersistedSession(sessionFile) {
      if (!sessionFile.includes('[session]') || !sessionFile.includes('window.main=')) {
        throw new Error('Windows release smoke failed: main window session was not persisted during startup bootstrap.');
      }

      if (!sessionFile.includes('companion.main')) {
        throw new Error('Windows release smoke failed: main window session is missing the main surface after startup bootstrap.');
      }
    },
    verifyPersistedPreferences(preferencesFile) {
      if (!preferencesFile.includes('main-mode=compact')) {
        throw new Error('Windows release smoke failed: compact startup preference was not written to the preferences file.');
      }
    },
  },
  'tab-session': {
    description: 'main window launch plus explicit settings tab auto-open',
    preferences: defaultPreferences,
    launchConfig: {
      initialOpen: {
        surface: 'companion.settings',
        policy: 'settings',
        presentation: 'tab',
      },
    },
    successMarkers: [
      ...commonSuccessMarkers,
      'InitialOpenSurface surface=companion.settings policy=settings presentation=tab',
      '[frontend-companion] auto-open window=window.main surface=companion.settings presentation=tab',
      '[frontend-companion] render window=window.main surface=companion.settings policy=settings',
      '[frontend-companion] mounted window=window.main surface=companion.settings policy=settings',
      '[frontend-companion] session window=window.main tabs=2 active=tab:companion.settings:1 entries=tab:companion.main:1:companion.main,tab:companion.settings:1:companion.settings',
    ],
    async verifyLog(logContents) {
      await assertRectMatchesPolicy(logContents, 'WindowRect', 'main', 'wide');
    },
    verifyPersistedSession(sessionFile) {
      if (!sessionFile.includes('[session]') || !sessionFile.includes('window.main=')) {
        throw new Error('Windows release smoke failed: main window session was not persisted.');
      }

      if (!sessionFile.includes('companion.settings')) {
        throw new Error('Windows release smoke failed: main window session is missing the settings tab.');
      }
    },
  },
  'restore-tab-session': {
    description: 'main window restores the previously active settings tab on relaunch',
    preferences: defaultPreferences,
    launchConfig: {},
    successMarkers: [
      'LaunchSurface surface=companion.main policy=main mode=',
      'InstanceLoaded failed=false',
      'NativeLogger[1] Running "OpappWindowsHost"',
      '[frontend-companion] render window=window.main surface=companion.settings policy=settings',
      '[frontend-companion] mounted window=window.main surface=companion.settings policy=settings',
      '[frontend-companion] session window=window.main tabs=2 active=tab:companion.settings:1 entries=tab:companion.main:1:companion.main,tab:companion.settings:1:companion.settings',
    ],    async verifyLog(logContents) {
      const normalized = normalizeLogContents(logContents);
      if (normalized.includes('InitialOpenSurface surface=')) {
        throw new Error('Windows release smoke failed: restored tab session should not rely on an initial-open launch config.');
      }

      if (normalized.includes('[frontend-companion] auto-open bundle=opapp.companion.main window=window.main')) {
        throw new Error('Windows release smoke failed: restored tab session unexpectedly replayed the auto-open path.');
      }

      await assertRectMatchesPolicy(logContents, 'WindowRect', 'main', 'wide');
    },
    verifyPersistedSession(sessionFile) {
      if (!sessionFile.includes('[session]') || !sessionFile.includes('window.main=')) {
        throw new Error('Windows release smoke failed: restored main window session was not persisted.');
      }

      if (!sessionFile.includes('companion.settings')) {
        throw new Error('Windows release smoke failed: restored main window session is missing the settings tab.');
      }
    },
  },
  'launcher-provenance': {
    description:
      'launcher remote catalog exposes remote-only publish targets, local-only residue, and version drift through public diagnostics',
    preferences: defaultPreferences,
    startupTarget: {
      surfaceId: 'companion.main',
      bundleId: 'opapp.companion.main',
      policy: 'main',
      presentation: 'current-window',
    },
    launchConfig: {
      disableNativeOtaUpdate: true,
    },
    skipNativeOtaVerification: true,
    successMarkers: [
      ...commonSuccessMarkers,
      '[frontend-companion] startup-target-auto-open bundle=opapp.companion.main window=window.main surface=companion.main presentation=current-window targetBundle=opapp.companion.main',
      '[frontend-companion] session window=window.main tabs=1 active=',
      'bundle-launcher.remote-catalog.summary',
      '"bundleId":"opapp.hbr.workspace"',
    ],
    async prepareState() {
      await writeFile(
        sessionsPath,
        buildPersistedSessionFile({
          'window.main': {
            windowId: 'window.main',
            activeTabId: 'tab:companion.settings:1',
            tabs: [
              {
                tabId: 'tab:companion.settings:1',
                surfaceId: 'companion.settings',
                policy: 'settings',
              },
            ],
          },
        }),
        'utf8',
      );

      if (!otaRemoteArg) {
        return {createdPaths: []};
      }

      const runtimeBundleRoot = resolveRuntimeBundleRootForLaunchMode();
      const createdPaths = await seedLauncherProvenanceCachedCatalog();

      const versionDriftRoot = await createSyntheticStagedBundle({
        bundleRoot: runtimeBundleRoot,
        bundleId: launcherProvenanceFixture.versionDrift.bundleId,
        sourceKind: launcherProvenanceFixture.versionDrift.sourceKind,
        surfaces: launcherProvenanceFixture.versionDrift.surfaceIds,
        version: launcherProvenanceFixture.versionDrift.localVersion,
      });
      createdPaths.push(versionDriftRoot);

      const localOnlyRoot = await createSyntheticStagedBundle({
        bundleRoot: runtimeBundleRoot,
        bundleId: launcherProvenanceFixture.localOnly.bundleId,
        sourceKind: launcherProvenanceFixture.localOnly.sourceKind,
        surfaces: launcherProvenanceFixture.localOnly.surfaceIds,
        version: launcherProvenanceFixture.localOnly.localVersion,
      });
      createdPaths.push(localOnlyRoot);

      return {createdPaths};
    },
    async cleanupState(state) {
      const createdPaths = Array.isArray(state?.createdPaths)
        ? state.createdPaths
        : [];
      for (const createdPath of createdPaths) {
        await removeIfPresent(createdPath);
      }
      await removeIfPresent(otaIndexPath);
      await removeIfPresent(otaStatePath);
      await removeIfPresent(otaLastRunPath);
    },
    async verifyLog(logContents) {
      const normalized = normalizeLogContents(logContents);
      if (normalized.includes('InitialOpenSurface surface=')) {
        throw new Error(
          'Windows release smoke failed: launcher provenance should not rely on an initial-open launch config.',
        );
      }

      if (
        normalized.includes(
          '[frontend-companion] render bundle=opapp.companion.main window=window.main surface=companion.settings policy=settings',
        )
      ) {
        throw new Error(
          'Windows release smoke failed: launcher provenance still rendered the restored settings surface in the main window.',
        );
      }

      assertLogContainsRegex(
        logContents,
        /\[frontend-companion\] session bundle=opapp\.companion\.main window=window\.main tabs=1 active=\S+ entries=[^\r\n]*companion\.main/i,
        'launcher provenance did not settle the main window session on the launcher surface.',
      );

      if (otaRemoteArg) {
        if (!normalized.includes('OTA.Disabled reason=launch-config')) {
          throw new Error(
            'Windows release smoke failed: launcher provenance should disable native OTA updates while preserving the remote catalog URL.',
          );
        }

        assertLauncherRemoteCatalogDiagnostics(logContents, {
          summary: {
            status: 'ready',
            source: 'network',
            remoteUrl: otaRemoteArg.replace(/\/+$/, ''),
            remoteEntryCount: 3,
            entryCount: 4,
            stagedBundleCount: 2,
            stagedBundlesLoaded: true,
            startupTargetLoaded: true,
          },
          entries: [
            {
              bundleId: 'opapp.companion.main',
              discoverySource: 'remote-catalog',
              localState: 'bundled',
              localVersion: null,
              localProvenanceKind: null,
              versionMismatch: false,
            },
            {
              bundleId: launcherProvenanceFixture.nativeApplied.bundleId,
              discoverySource: 'remote-catalog',
              localState: 'remote-only',
              latestVersion: launcherProvenanceFixture.nativeApplied.latestVersion,
              localVersion: null,
              localSourceKind: null,
              localProvenanceKind: null,
              localProvenanceStatus: null,
              hasPublicLaunchTarget: true,
              versionMismatch: false,
            },
            {
              bundleId: launcherProvenanceFixture.versionDrift.bundleId,
              discoverySource: 'remote-catalog',
              localState: 'staged',
              latestVersion: launcherProvenanceFixture.versionDrift.latestVersion,
              localVersion: launcherProvenanceFixture.versionDrift.localVersion,
              localSourceKind: launcherProvenanceFixture.versionDrift.sourceKind,
              localProvenanceKind: 'host-staged-only',
              localProvenanceStatus: null,
              versionMismatch: true,
            },
            {
              bundleId: launcherProvenanceFixture.localOnly.bundleId,
              discoverySource: 'local-only',
              localState: 'staged',
              latestVersion: null,
              localVersion: launcherProvenanceFixture.localOnly.localVersion,
              localSourceKind: launcherProvenanceFixture.localOnly.sourceKind,
              localProvenanceKind: 'host-staged-only',
              localProvenanceStatus: null,
              versionMismatch: false,
            },
          ],
        });
      }

      await assertRectMatchesPolicy(logContents, 'WindowRect', 'main', 'wide');
    },
    verifyPersistedSession(sessionFile) {
      assertPersistedSessionHasSurfaceId(
        sessionFile,
        'window.main',
        'companion.main',
        'launcher provenance did not persist the launcher surface back into the main window session.',
      );
      assertPersistedSessionLacksSurfaceId(
        sessionFile,
        'window.main',
        'companion.settings',
        'launcher provenance left the restored settings surface in the main window session.',
      );
    },
  },
  'startup-target-main-launcher': {
    description: 'saved launcher startup target overrides a restored main-window settings session',
    preferences: defaultPreferences,
    startupTarget: {
      surfaceId: 'companion.main',
      bundleId: 'opapp.companion.main',
      policy: 'main',
      presentation: 'current-window',
    },
    launchConfig: {},
    successMarkers: [
      ...commonSuccessMarkers,
      '[frontend-companion] startup-target-auto-open bundle=opapp.companion.main window=window.main surface=companion.main presentation=current-window targetBundle=opapp.companion.main',
      '[frontend-companion] session window=window.main tabs=1 active=',
    ],
    async prepareState() {
      await writeFile(
        sessionsPath,
        buildPersistedSessionFile({
          'window.main': {
            windowId: 'window.main',
            activeTabId: 'tab:companion.settings:1',
            tabs: [
              {
                tabId: 'tab:companion.settings:1',
                surfaceId: 'companion.settings',
                policy: 'settings',
              },
            ],
          },
        }),
        'utf8',
      );
    },
    async verifyLog(logContents) {
      const normalized = normalizeLogContents(logContents);
      if (normalized.includes('InitialOpenSurface surface=')) {
        throw new Error(
          'Windows release smoke failed: startup target override should not rely on an initial-open launch config.',
        );
      }

      if (
        normalized.includes(
          '[frontend-companion] render bundle=opapp.companion.main window=window.main surface=companion.settings policy=settings',
        )
      ) {
        throw new Error(
          'Windows release smoke failed: startup target override still rendered the restored settings surface in the main window.',
        );
      }

      assertLogContainsRegex(
        logContents,
        /\[frontend-companion\] session bundle=opapp\.companion\.main window=window\.main tabs=1 active=\S+ entries=[^\r\n]*companion\.main/i,
        'startup target override did not settle the main window session on the launcher surface.',
      );

      await assertRectMatchesPolicy(logContents, 'WindowRect', 'main', 'wide');
    },
    verifyPersistedSession(sessionFile) {
      assertPersistedSessionHasSurfaceId(
        sessionFile,
        'window.main',
        'companion.main',
        'startup target override did not persist the launcher surface back into the main window session.',
      );
      assertPersistedSessionLacksSurfaceId(
        sessionFile,
        'window.main',
        'companion.settings',
        'startup target override left the restored settings surface in the main window session.',
      );
    },
  },
  'legacy-startup-target-main-launcher': {
    description:
      'legacy startup target file migrates into native preferences before overriding a restored main-window settings session',
    preferences: defaultPreferences,
    launchConfig: {},
    successMarkers: [
      ...commonSuccessMarkers,
      '[frontend-companion] startup-target-migration action=migrate bundle=opapp.companion.main surface=companion.main',
      '[frontend-companion] startup-target-auto-open bundle=opapp.companion.main window=window.main surface=companion.main presentation=current-window targetBundle=opapp.companion.main',
      '[frontend-companion] session window=window.main tabs=1 active=',
    ],
    async prepareState() {
      await writeFile(
        sessionsPath,
        buildPersistedSessionFile({
          'window.main': {
            windowId: 'window.main',
            activeTabId: 'tab:companion.settings:1',
            tabs: [
              {
                tabId: 'tab:companion.settings:1',
                surfaceId: 'companion.settings',
                policy: 'settings',
              },
            ],
          },
        }),
        'utf8',
      );
      await writeFile(
        companionStartupTargetPath,
        JSON.stringify({
          surfaceId: 'companion.main',
          bundleId: 'opapp.companion.main',
          policy: 'main',
          presentation: 'current-window',
        }),
        'utf8',
      );
    },
    async verifyLog(logContents) {
      const normalized = normalizeLogContents(logContents);
      if (normalized.includes('InitialOpenSurface surface=')) {
        throw new Error(
          'Windows release smoke failed: legacy launcher startup target migration should not rely on an initial-open launch config.',
        );
      }

      if (
        normalized.includes(
          '[frontend-companion] render bundle=opapp.companion.main window=window.main surface=companion.settings policy=settings',
        )
      ) {
        throw new Error(
          'Windows release smoke failed: legacy launcher startup target migration still rendered the restored settings surface in the main window.',
        );
      }

      if (await fileExists(companionStartupTargetPath)) {
        throw new Error(
          'Windows release smoke failed: legacy launcher startup target file was not deleted after migration.',
        );
      }

      const preferencesFile = await readFile(preferencesPath, 'utf8');
      if (!preferencesFile.includes('[startup-target]')) {
        throw new Error(
          'Windows release smoke failed: legacy launcher startup target migration did not persist a native startup-target section.',
        );
      }

      if (!preferencesFile.includes('surface=companion.main')) {
        throw new Error(
          'Windows release smoke failed: native startup-target preference is missing the migrated launcher surface id.',
        );
      }

      if (!preferencesFile.includes('bundle=opapp.companion.main')) {
        throw new Error(
          'Windows release smoke failed: native startup-target preference is missing the migrated launcher bundle id.',
        );
      }

      assertLogContainsRegex(
        logContents,
        /\[frontend-companion\] session bundle=opapp\.companion\.main window=window\.main tabs=1 active=\S+ entries=[^\r\n]*companion\.main/i,
        'legacy launcher startup target migration did not settle the main window session on the launcher surface.',
      );

      await assertRectMatchesPolicy(logContents, 'WindowRect', 'main', 'wide');
    },
    verifyPersistedSession(sessionFile) {
      assertPersistedSessionHasSurfaceId(
        sessionFile,
        'window.main',
        'companion.main',
        'legacy launcher startup target migration did not persist the launcher surface back into the main window session.',
      );
      assertPersistedSessionLacksSurfaceId(
        sessionFile,
        'window.main',
        'companion.settings',
        'legacy launcher startup target migration left the restored settings surface in the main window session.',
      );
    },
  },
  'startup-target-settings': {
    description: 'saved settings startup target overrides a restored main-window launcher session',
    preferences: defaultPreferences,
    startupTarget: {
      surfaceId: 'companion.settings',
      bundleId: 'opapp.companion.main',
      policy: 'settings',
      presentation: 'current-window',
    },
    launchConfig: {},
    successMarkers: [
      'LaunchSurface surface=companion.main policy=main mode=',
      'InstanceLoaded failed=false',
      'NativeLogger[1] Running "OpappWindowsHost"',
      'BundleManifestSource=manifest',
      '[frontend-companion] startup-target-auto-open bundle=opapp.companion.main window=window.main surface=companion.settings presentation=current-window targetBundle=opapp.companion.main',
      '[frontend-companion] render bundle=opapp.companion.main window=window.main surface=companion.settings policy=settings',
      '[frontend-companion] mounted bundle=opapp.companion.main window=window.main surface=companion.settings policy=settings',
      '[frontend-companion] session bundle=opapp.companion.main window=window.main tabs=1 active=',
    ],
    async prepareState() {
      await writeFile(
        sessionsPath,
        buildPersistedSessionFile({
          'window.main': {
            windowId: 'window.main',
            activeTabId: 'tab:companion.main:1',
            tabs: [
              {
                tabId: 'tab:companion.main:1',
                surfaceId: 'companion.main',
                policy: 'main',
              },
            ],
          },
        }),
        'utf8',
      );
    },
    async verifyLog(logContents) {
      const normalized = normalizeLogContents(logContents);
      if (normalized.includes('InitialOpenSurface surface=')) {
        throw new Error(
          'Windows release smoke failed: startup target settings override should not rely on an initial-open launch config.',
        );
      }

      if (
        normalized.includes(
          '[frontend-companion] render bundle=opapp.companion.main window=window.main surface=companion.main policy=main',
        )
      ) {
        throw new Error(
          'Windows release smoke failed: startup target settings override still rendered the restored launcher surface in the main window.',
        );
      }

      assertLogContainsRegex(
        logContents,
        /\[frontend-companion\] session bundle=opapp\.companion\.main window=window\.main tabs=1 active=\S+ entries=[^\r\n]*companion\.settings/i,
        'startup target settings override did not settle the main window session on the settings surface.',
      );

      await assertRectMatchesPolicy(logContents, 'WindowRect', 'main', 'wide');
    },
    verifyPersistedSession(sessionFile) {
      assertPersistedSessionHasSurfaceId(
        sessionFile,
        'window.main',
        'companion.settings',
        'startup target settings override did not persist the settings surface back into the main window session.',
      );
      assertPersistedSessionLacksSurfaceId(
        sessionFile,
        'window.main',
        'companion.main',
        'startup target settings override left the restored launcher surface in the main window session.',
      );
    },
  },
  'settings-default-current-window': {
    description: 'saved settings preference keeps default settings entry in the current window',
    preferences: {
      ...defaultPreferences,
      settingsPresentation: 'current-window',
    },
    launchConfig: {
      initialOpen: {
        surface: 'companion.settings',
        policy: 'settings',
        presentation: 'auto',
      },
    },
    successMarkers: [
      ...commonSuccessMarkers,
      'InitialOpenSurface surface=companion.settings policy=settings presentation=auto',
      '[frontend-companion] auto-open window=window.main surface=companion.settings presentation=auto',
      '[frontend-companion] render window=window.main surface=companion.settings policy=settings',
      '[frontend-companion] mounted window=window.main surface=companion.settings policy=settings',
      '[frontend-companion] session window=window.main tabs=1 active=tab:companion.main:1 entries=tab:companion.main:1:companion.settings',
    ],
    verifyPersistedSession(sessionFile) {
      if (!sessionFile.includes('[session]') || !sessionFile.includes('window.main=')) {
        throw new Error('Windows release smoke failed: main window session was not persisted.');
      }

      if (!sessionFile.includes('companion.settings')) {
        throw new Error('Windows release smoke failed: default current-window settings flow did not persist the settings surface.');
      }
    },
  },
  'settings-default-new-window': {
    description: 'saved settings preference opens the default settings entry in a detached window',
    preferences: {
      ...defaultPreferences,
      settingsPresentation: 'new-window',
    },
    launchConfig: {
      initialOpen: {
        surface: 'companion.settings',
        policy: 'settings',
        presentation: 'auto',
      },
    },
    successMarkers: [
      ...commonSuccessMarkers,
      'InitialOpenSurface surface=companion.settings policy=settings presentation=auto',
      '[frontend-companion] auto-open window=window.main surface=companion.settings presentation=auto',
      '[frontend-companion] session window=window.main tabs=1 active=tab:companion.main:1 entries=tab:companion.main:1:companion.main',
      'SecondaryWindowOpened surface=companion.settings policy=settings mode=',
      '[frontend-companion] render window=window.secondary.dynamic.1 surface=companion.settings policy=settings',
      '[frontend-companion] mounted window=window.secondary.dynamic.1 surface=companion.settings policy=settings',
      '[frontend-companion] session window=window.secondary.dynamic.1 tabs=1 active=tab:companion.settings:1 entries=tab:companion.settings:1:companion.settings',
    ],
    async verifyLog(logContents) {
      await assertRectMatchesPolicy(logContents, 'WindowRect', 'main', 'wide');
      await assertRectMatchesPolicy(logContents, 'SecondaryWindowRect', 'settings', 'compact');
      assertLogDoesNotContain(
        logContents,
        '[frontend-companion] render window=window.main surface=companion.settings policy=settings',
        'default new-window settings flow unexpectedly rendered the settings surface inside the main window.',
      );
      assertLogDoesNotContain(
        logContents,
        '[frontend-companion] mounted window=window.main surface=companion.settings policy=settings',
        'default new-window settings flow unexpectedly mounted the settings surface inside the main window.',
      );
    },
    verifyPersistedSession(sessionFile) {
      if (!sessionFile.includes('[session]') || !sessionFile.includes('window.main=')) {
        throw new Error('Windows release smoke failed: main window session was not persisted.');
      }

      if (!sessionFile.includes('window.secondary.dynamic.1=')) {
        throw new Error('Windows release smoke failed: detached settings window session was not persisted for default new-window preference.');
      }

      assertPersistedSessionHasSurfaceId(
        sessionFile,
        'window.main',
        'companion.main',
        'main window session is missing the main surface for default new-window settings flow.',
      );
      assertPersistedSessionLacksSurfaceId(
        sessionFile,
        'window.main',
        'companion.settings',
        'main window session unexpectedly persisted the settings surface for default new-window settings flow.',
      );
      assertPersistedSessionHasSurfaceId(
        sessionFile,
        'window.secondary.dynamic.1',
        'companion.settings',
        'detached settings window session is missing the settings surface.',
      );
    },
  },
  'restore-settings-window': {
    description: 'packaged relaunch restores the previously detached settings window session',
    preferences: {
      ...defaultPreferences,
      settingsPresentation: 'new-window',
    },
    launchConfig: {},
    successMarkers: [
      ...commonSuccessMarkers,
      '[frontend-companion] session window=window.main tabs=1 active=tab:companion.main:1 entries=tab:companion.main:1:companion.main',
      'RestoredSecondaryWindowScheduled window=window.secondary.dynamic.1 surface=companion.settings policy=settings mode=compact',
      'SecondaryWindowQueued surface=companion.settings policy=settings mode=compact',
      'SecondaryWindowOpened surface=companion.settings policy=settings mode=compact',
      '[frontend-companion] render window=window.secondary.dynamic.1 surface=companion.settings policy=settings',
      '[frontend-companion] mounted window=window.secondary.dynamic.1 surface=companion.settings policy=settings',
      '[frontend-companion] session window=window.secondary.dynamic.1 tabs=1 active=tab:companion.settings:1 entries=tab:companion.settings:1:companion.settings',
    ],
    async verifyLog(logContents) {
      const normalized = normalizeLogContents(logContents);
      if (normalized.includes('InitialOpenSurface surface=')) {
        throw new Error('Windows release smoke failed: restored detached settings window should not rely on an initial-open launch config.');
      }

      if (normalized.includes('[frontend-companion] auto-open bundle=opapp.companion.main window=window.main')) {
        throw new Error('Windows release smoke failed: restored detached settings window unexpectedly replayed the auto-open path.');
      }

      await assertRectMatchesPolicy(logContents, 'WindowRect', 'main', 'wide');
      await assertRectMatchesPolicy(logContents, 'SecondaryWindowRect', 'settings', 'compact');
      assertLogDoesNotContain(
        logContents,
        '[frontend-companion] render window=window.main surface=companion.settings policy=settings',
        'restored detached settings flow unexpectedly rendered the settings surface inside the main window.',
      );
      assertLogDoesNotContain(
        logContents,
        '[frontend-companion] mounted window=window.main surface=companion.settings policy=settings',
        'restored detached settings flow unexpectedly mounted the settings surface inside the main window.',
      );
    },
    verifyPersistedSession(sessionFile) {
      if (!sessionFile.includes('[session]') || !sessionFile.includes('window.main=')) {
        throw new Error('Windows release smoke failed: main window session was not persisted during detached settings restore.');
      }

      if (!sessionFile.includes('window.secondary.dynamic.1=')) {
        throw new Error('Windows release smoke failed: restored detached settings window session is missing from persisted session state.');
      }

      assertPersistedSessionHasSurfaceId(
        sessionFile,
        'window.main',
        'companion.main',
        'main window session is missing the main surface during detached settings restore.',
      );
      assertPersistedSessionLacksSurfaceId(
        sessionFile,
        'window.main',
        'companion.settings',
        'main window session unexpectedly persisted the settings surface during detached settings restore.',
      );
      assertPersistedSessionHasSurfaceId(
        sessionFile,
        'window.secondary.dynamic.1',
        'companion.settings',
        'restored detached settings window session is missing the settings surface.',
      );
    },
  },
  'save-main-window-preferences': {
    description: 'settings save applies the new main window mode immediately to the current window',
    preferences: {
      ...defaultPreferences,
      settingsPresentation: 'current-window',
    },
    launchConfig: {
      initialOpen: {
        surface: 'companion.settings',
        policy: 'settings',
        presentation: 'auto',
      },
      initialOpenProps: {
        'smoke-save-main-window-mode': 'compact',
      },
    },
    successMarkers: [
      ...commonSuccessMarkers,
      'InitialOpenSurface surface=companion.settings policy=settings presentation=auto',
      '[frontend-companion] auto-open window=window.main surface=companion.settings presentation=auto',
      '[frontend-companion] render window=window.main surface=companion.settings policy=settings',
      '[frontend-companion] mounted window=window.main surface=companion.settings policy=settings',
      '[frontend-settings] smoke-auto-save-start main=compact settings=compact presentation=current-window',
      '[frontend-settings] smoke-auto-save-complete main=compact settings=compact presentation=current-window',
      'WindowRectUpdated=',
      'WindowPreferencesApplied window=window.main mode=compact',
    ],
    async verifyLog(logContents) {
      if (!/WindowRectUpdated=.*mode=compact/.test(normalizeLogContents(logContents))) {
        throw new Error('Windows release smoke failed: saving preferences did not resize the current main window to compact mode.');
      }

      await assertRectMatchesPolicy(logContents, 'WindowRectUpdated', 'main', 'compact');
    },
    verifyPersistedSession(sessionFile) {
      if (!sessionFile.includes('[session]') || !sessionFile.includes('window.main=')) {
        throw new Error('Windows release smoke failed: main window session was not persisted during save-window-preferences smoke.');
      }

      if (!sessionFile.includes('companion.settings')) {
        throw new Error('Windows release smoke failed: save-window-preferences flow did not persist the settings surface in the main window session.');
      }
    },
    verifyPersistedPreferences(preferencesFile) {
      if (!preferencesFile.includes('main-mode=compact')) {
        throw new Error('Windows release smoke failed: saving preferences did not persist compact mode for the main window.');
      }
    },
  },
  'view-shot-current-window': {
    description: 'auto-open view-shot lab in the current window and run screenshot smoke',
    preferences: defaultPreferences,
    launchConfig: {
      initialOpen: {
        surface: 'companion.view-shot',
        policy: 'tool',
        presentation: 'current-window',
      },
      initialOpenProps: {
        'dev-smoke-scenario': 'view-shot-basics',
      },
    },
    successMarkers: [
      ...commonSuccessMarkers,
      'InitialOpenSurface surface=companion.view-shot policy=tool presentation=current-window',
      '[frontend-companion] auto-open window=window.main surface=companion.view-shot presentation=current-window',
      '[frontend-companion] render window=window.main surface=companion.view-shot policy=tool',
      '[frontend-companion] mounted window=window.main surface=companion.view-shot policy=tool',
      '[frontend-companion] session window=window.main tabs=1 active=tab:companion.main:1 entries=tab:companion.main:1:companion.view-shot',
      '[frontend-view-shot] dev-smoke-start',
      '[frontend-view-shot] dev-smoke-capture-ref uri=',
      '[frontend-view-shot] dev-smoke-inspection-ref uri=',
      '[frontend-view-shot] dev-smoke-component-data-uri prefix=data:image/png;base64, length=',
      '[frontend-view-shot] dev-smoke-jpg-quality low=',
      '[frontend-view-shot] dev-smoke-capture-screen uri=',
      '[frontend-view-shot] dev-smoke-release-complete',
      '[frontend-view-shot] dev-smoke-complete',
    ],
    async verifyLog(logContents) {
      assertLogContainsRegex(
        logContents,
        /\[frontend-view-shot\] dev-smoke-capture-ref uri=.*OPApp[\\/]+view-shot[\\/]+/i,
        'view-shot smoke did not produce a tmpfile captureRef artifact under the managed host directory.',
      );
      const inspectionCapturePath = extractLoggedPath(
        logContents,
        /\[frontend-view-shot\] dev-smoke-inspection-ref uri=([^\r\n]+)/i,
        'view-shot smoke did not produce an inspection tmpfile artifact under the managed host directory.',
      );
      try {
        const inspectionStats = assertPngCaptureLooksOpaque(
          inspectionCapturePath,
          'Windows release smoke view-shot inspection capture',
        );
        log(
          `view-shot inspection OK: path=${inspectionCapturePath} opaqueSamples=${inspectionStats.opaqueSamples}/${inspectionStats.sampleCount} distinctSamples=${inspectionStats.distinctSampleCount} averageAlpha=${inspectionStats.averageAlpha}`,
        );
      } finally {
        await rm(inspectionCapturePath, {force: true});
      }
      assertLogContainsRegex(
        logContents,
        /\[frontend-view-shot\] dev-smoke-component-data-uri prefix=data:image\/png;base64, length=\d+/i,
        'view-shot smoke did not produce a PNG data-uri from ViewShot.capture.',
      );
      const jpgQualityMatch = normalizeLogContents(logContents).match(
        /\[frontend-view-shot\] dev-smoke-jpg-quality low=(\d+) high=(\d+)/i,
      );
      if (!jpgQualityMatch) {
        throw new Error(
          'Windows release smoke failed: view-shot smoke did not emit the JPG quality summary marker.',
        );
      }
      const lowQualityLength = Number(jpgQualityMatch[1]);
      const highQualityLength = Number(jpgQualityMatch[2]);
      if (!Number.isFinite(lowQualityLength) || !Number.isFinite(highQualityLength)) {
        throw new Error(
          'Windows release smoke failed: view-shot smoke emitted an invalid JPG quality summary marker.',
        );
      }
      if (highQualityLength <= lowQualityLength) {
        throw new Error(
          'Windows release smoke failed: high-quality JPG capture was not larger than low-quality JPG capture.',
        );
      }
      assertLogContainsRegex(
        logContents,
        /\[frontend-view-shot\] dev-smoke-capture-screen uri=.*OPApp[\\/]+view-shot[\\/]+/i,
        'view-shot smoke did not produce a tmpfile captureScreen artifact under the managed host directory.',
      );
    },
    verifyPersistedSession(sessionFile) {
      if (!sessionFile.includes('[session]') || !sessionFile.includes('window.main=')) {
        throw new Error('Windows release smoke failed: main window session was not persisted during view-shot smoke.');
      }

      assertPersistedSessionHasSurfaceId(
        sessionFile,
        'window.main',
        'companion.view-shot',
        'view-shot smoke did not persist the view-shot lab surface in the main window session.',
      );
    },
  },
  'window-capture-current-window': {
    description: 'auto-open window-capture lab in the current window and run foreground WGC smoke',
    preferences: defaultPreferences,
    launchConfig: {
      initialOpen: {
        surface: 'companion.window-capture',
        policy: 'tool',
        presentation: 'current-window',
      },
      initialOpenProps: {
        'dev-smoke-scenario': 'window-capture-basics',
      },
    },
    successMarkers: [
      ...commonSuccessMarkers,
      'InitialOpenSurface surface=companion.window-capture policy=tool presentation=current-window',
      '[frontend-companion] auto-open window=window.main surface=companion.window-capture presentation=current-window',
      '[frontend-companion] render window=window.main surface=companion.window-capture policy=tool',
      '[frontend-companion] mounted window=window.main surface=companion.window-capture policy=tool',
      '[frontend-companion] session window=window.main tabs=1 active=tab:companion.main:1 entries=tab:companion.main:1:companion.window-capture',
      '[frontend-window-capture] dev-smoke-start',
      '[frontend-window-capture] dev-smoke-list count=',
      '[frontend-window-capture] dev-smoke-capture-window backend=wgc size=',
      '[frontend-window-capture] dev-smoke-capture-client backend=wgc crop=',
      '[frontend-window-capture] dev-smoke-complete',
    ],
    async verifyLog(logContents) {
      assertLogContainsRegex(
        logContents,
        /\[frontend-window-capture\] dev-smoke-list count=\d+ handle=0x[0-9a-f]+ process=/i,
        'window-capture smoke did not list a foreground window.',
      );
      assertLogContainsRegex(
        logContents,
        /\[frontend-window-capture\] dev-smoke-capture-window backend=wgc size=\d+x\d+ path=.*OPApp[\\/]+window-capture[\\/]+/i,
        'window-capture smoke did not produce a WGC window capture artifact under the managed host directory.',
      );
      const windowCapturePath = extractLoggedPath(
        logContents,
        /\[frontend-window-capture\] dev-smoke-capture-window backend=wgc size=\d+x\d+ path=([^\r\n]+)/i,
        'window-capture smoke did not emit the window capture path.',
      );
      try {
        const inspectionStats = assertPngCaptureLooksOpaque(
          windowCapturePath,
          'Windows release smoke window-capture window capture',
        );
        log(
          `window-capture window OK: path=${windowCapturePath} opaqueSamples=${inspectionStats.opaqueSamples}/${inspectionStats.sampleCount} distinctSamples=${inspectionStats.distinctSampleCount} averageAlpha=${inspectionStats.averageAlpha}`,
        );
      } finally {
        await rm(windowCapturePath, {force: true});
      }
      assertLogContainsRegex(
        logContents,
        /\[frontend-window-capture\] dev-smoke-capture-client backend=wgc crop=\d+x\d+ path=.*OPApp[\\/]+window-capture[\\/]+/i,
        'window-capture smoke did not produce a WGC client capture artifact under the managed host directory.',
      );
      const clientCapturePath = extractLoggedPath(
        logContents,
        /\[frontend-window-capture\] dev-smoke-capture-client backend=wgc crop=\d+x\d+ path=([^\r\n]+)/i,
        'window-capture smoke did not emit the client capture path.',
      );
      try {
        const inspectionStats = assertPngCaptureLooksOpaque(
          clientCapturePath,
          'Windows release smoke window-capture client capture',
        );
        log(
          `window-capture client OK: path=${clientCapturePath} opaqueSamples=${inspectionStats.opaqueSamples}/${inspectionStats.sampleCount} distinctSamples=${inspectionStats.distinctSampleCount} averageAlpha=${inspectionStats.averageAlpha}`,
        );
      } finally {
        await rm(clientCapturePath, {force: true});
      }
    },
    verifyPersistedSession(sessionFile) {
      if (!sessionFile.includes('[session]') || !sessionFile.includes('window.main=')) {
        throw new Error('Windows release smoke failed: main window session was not persisted during window-capture smoke.');
      }

      assertPersistedSessionHasSurfaceId(
        sessionFile,
        'window.main',
        'companion.window-capture',
        'window-capture smoke did not persist the window-capture lab surface in the main window session.',
      );
    },
  },
  'companion-chat-current-window': {
    description: 'auto-open companion chat in the current window and switch into the child chat bundle',
    preferences: defaultPreferences,
    usesLocalOtaRemoteFixture: true,
    launchConfig: {
      initialOpen: {
        surface: companionChatSurfaceId,
        bundle: companionChatBundleId,
        policy: 'main',
        presentation: 'current-window',
      },
    },
    async prepareState() {
      if (otaRemoteArg) {
        return null;
      }

      return await createCompanionChatOtaFixture();
    },
    successMarkers: [
      ...commonSuccessMarkers,
      `InitialOpenSurface surface=${companionChatSurfaceId} policy=main presentation=current-window`,
      `BundleSwitchPrepared window=window.main bundle=${companionChatBundleId} surface=${companionChatSurfaceId} policy=main`,
      `BundleSwitchReloadRequested window=window.main bundle=${companionChatBundleId}`,
      `[frontend-companion] render bundle=${companionChatBundleId} window=window.main surface=${companionChatSurfaceId} policy=main`,
      `[frontend-companion] mounted bundle=${companionChatBundleId} window=window.main surface=${companionChatSurfaceId} policy=main`,
    ],
    async cleanupState(state) {
      if (!state) {
        return;
      }

      await closeRegistryServer(state.server);
      await removeIfPresent(state.registryRoot);
    },
    async verifyLog(logContents) {
      const normalized = normalizeLogContents(logContents);

      if (!normalized.includes(companionChatBundleRootMarker)) {
        throw new Error(
          'Windows release smoke failed: companion chat current-window flow did not point the host at the staged chat child bundle root.',
        );
      }

      assertLogDoesNotContain(
        logContents,
        `[frontend-companion] surface-fallback bundle=opapp.companion.main requested=${companionChatSurfaceId} rendered=companion.main`,
        'companion chat current-window flow still fell back through the main companion surface.',
      );

      await assertRectMatchesPolicy(logContents, 'WindowRect', 'main', 'wide');
    },
    verifyPersistedSession(sessionFile) {
      if (!sessionFile.includes('[session]') || !sessionFile.includes('window.main=')) {
        throw new Error('Windows release smoke failed: main window session was not persisted during companion chat smoke.');
      }

      assertPersistedSessionHasSurfaceId(
        sessionFile,
        'window.main',
        companionChatSurfaceId,
        'companion chat current-window flow did not persist the chat surface in the main window session.',
      );
      assertPersistedSessionContains(
        sessionFile,
        'window.main',
        companionChatBundleId,
        'companion chat current-window flow did not persist the chat bundle id in the main window session.',
      );
    },
  },
  'secondary-window': {
    description: 'startup main window plus detached settings window',
    preferences: defaultPreferences,
    launchConfig: {
      secondary: {
        surface: 'companion.settings',
        policy: 'settings',
      },
    },
    successMarkers: [
      ...commonSuccessMarkers,
      '[frontend-companion] session window=window.main tabs=1 active=tab:companion.main:1 entries=tab:companion.main:1:companion.main',
      'SecondaryStartupSurface surface=companion.settings policy=settings mode=',
      'SecondaryWindowQueued surface=companion.settings policy=settings mode=',
      'SecondaryWindowOpened surface=companion.settings policy=settings mode=',
      '[frontend-companion] render window=window.secondary.startup surface=companion.settings policy=settings',
      '[frontend-companion] mounted window=window.secondary.startup surface=companion.settings policy=settings',
    ],
    verifyPersistedSession(sessionFile) {
      if (!sessionFile.includes('[session]') || !sessionFile.includes('window.main=')) {
        throw new Error('Windows release smoke failed: main window session was not persisted.');
      }

      if (!sessionFile.includes('window.secondary.startup=')) {
        throw new Error('Windows release smoke failed: detached settings window session was not persisted.');
      }

      if (!sessionFile.includes('companion.settings')) {
        throw new Error('Windows release smoke failed: detached settings window session is missing the settings surface.');
      }
    },
  },
};

function normalizeCompanionMarker(marker) {
  if (!marker.includes('[frontend-companion]')) {
    return marker;
  }

  let normalizedMarker = marker
    .replace(
      '[frontend-companion] render window=',
      '[frontend-companion] render bundle=opapp.companion.main window=',
    )
    .replace(
      '[frontend-companion] mounted window=',
      '[frontend-companion] mounted bundle=opapp.companion.main window=',
    )
    .replace(
      '[frontend-companion] session window=',
      '[frontend-companion] session bundle=opapp.companion.main window=',
    )
    .replace(
      '[frontend-companion] auto-open window=',
      '[frontend-companion] auto-open bundle=opapp.companion.main window=',
    );

  if (
    normalizedMarker.includes('[frontend-companion] auto-open bundle=opapp.companion.main') &&
    !normalizedMarker.includes('targetBundle=')
  ) {
    normalizedMarker += ' targetBundle=opapp.companion.main';
  }

  return normalizedMarker;
}

const privateSmokeScenarios = await loadOptionalPrivateSmokeScenarios();
const optionalPrivateScenarioCount = Object.keys(privateSmokeScenarios).length;
const smokeScenarios = {
  ...publicSmokeScenarios,
  ...privateSmokeScenarios,
};
const supportedScenarioNames = Object.keys(smokeScenarios);
const scenarioName = resolveScenarioNameOrThrow();

for (const smokeScenario of Object.values(smokeScenarios)) {
  smokeScenario.successMarkers = smokeScenario.successMarkers.map(
    normalizeCompanionMarker,
  );

  if (smokeScenario.startupMarkers) {
    smokeScenario.startupMarkers = smokeScenario.startupMarkers.map(
      normalizeCompanionMarker,
    );
  }
}

const scenario = smokeScenarios[scenarioName];

if (!scenario) {
  throw new Error(`Unsupported smoke scenario: ${scenarioName}`);
}

const successMarkers = [
  ...scenario.successMarkers,
  ...(launchMode === 'portable' ? ['WinMain.BootstrapInitialize', 'WinMain.BootstrapInitialize.Done'] : []),
];
const defaultStartupMarkers = [
  'InstanceLoaded failed=false',
  'NativeLogger[1] Running "OpappWindowsHost"',
];
const startupMarkers = [
  ...(scenario.startupMarkers ?? defaultStartupMarkers),
  ...(launchMode === 'portable' ? ['WinMain.BootstrapInitialize.Done'] : []),
];

const failureMarkers = [
  'InstanceLoaded failed=true',
  'RedBox.ShowNewError',
  'RedBox.Message=',
  'NativeLogger[3]',
  'SecondaryStartupSurfaceFailed',
  'SecondaryWindowOpenFailed',
  'BundleManifestSource=hardcoded-fallback',
];

function log(message) {
  console.log(`[smoke] ${message}`);
}

function runOrThrow(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    windowsHide: false,
    ...options,
  });

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status ?? 1}`);
  }
}

function runCaptureOrThrow(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    ...options,
  });

  if (result.status !== 0) {
    const stderr = (result.stderr ?? '').trim();
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status ?? 1}${stderr ? `: ${stderr}` : ''}`);
  }

  return (result.stdout ?? '').trim();
}

function runInherited(command, args, options = {}) {
  return spawnSync(command, args, {
    stdio: 'inherit',
    windowsHide: false,
    ...options,
  });
}

function runInheritedWithCaptureFallback(command, args, options = {}) {
  const captureResult = runDirectCapture(command, args, options);
  if (captureResult.error?.code === 'EPERM') {
    log(
      `output capture blocked for ${command}; retrying with inherited stdio.`,
    );
    const fallbackResult = runInherited(command, args, options);
    return {
      ...fallbackResult,
      captureBlocked: true,
      capturedOutput: '',
      stderr: '',
      stdout: '',
    };
  }

  flushCapturedResult(captureResult);
  return {
    ...captureResult,
    captureBlocked: false,
    capturedOutput: `${captureResult.stdout ?? ''}\n${captureResult.stderr ?? ''}`,
  };
}

function runCmdOrThrow(args, options = {}) {
  runOrThrow('cmd.exe', ['/d', '/s', '/c', ...args], options);
}

function runCmdCapture(args, options = {}) {
  return spawnSync('cmd.exe', ['/d', '/s', '/c', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false,
    ...options,
  });
}

function flushCapturedResult(result) {
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
}

function isRetriableBundleFailure(result) {
  if (result.error?.code === 'EPERM') {
    return true;
  }
  const mergedOutput = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  return (
    mergedOutput.includes('spawn EPERM') ||
    mergedOutput.includes('Failed to construct transformer') ||
    mergedOutput.includes("Cannot read properties of undefined (reading 'end')")
  );
}

function describeSpawnFailure(command, args, result) {
  const stderr = (result.stderr ?? '').trim();
  const errorMessage = result.error ? ` error=${result.error.message}` : '';
  return `${command} ${args.join(' ')} failed with exit code ${result.status ?? 1}${errorMessage}${
    stderr ? `: ${stderr}` : ''
  }`;
}

function runDirectCapture(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false,
    ...options,
  });
}

function isCmdWrapper(command, args) {
  return command.toLowerCase() === 'cmd.exe' && args.length >= 4 && args[0] === '/d' && args[1] === '/s' && args[2] === '/c';
}

function getDirectCommandFromCmdArgs(command, args) {
  if (!isCmdWrapper(command, args)) {
    return null;
  }
  const [directCommand, ...directArgs] = args.slice(3);
  if (!directCommand) {
    return null;
  }
  return {directCommand, directArgs};
}

function resolveCorepackScriptPath() {
  const execDir = path.dirname(process.execPath);
  const candidates = [
    path.join(execDir, 'node_modules', 'corepack', 'dist', 'corepack.js'),
    path.join(execDir, '..', 'node_modules', 'corepack', 'dist', 'corepack.js'),
  ];
  return candidates.find(candidate => existsSync(candidate)) ?? null;
}

function isCompanionBundleCommand(directArgs) {
  return directArgs[0] === 'pnpm' && directArgs[1] === 'bundle:companion:windows';
}

function companionBundleCommandRequestsResetCache(directArgs) {
  return directArgs.includes('--reset-cache');
}

async function runCompanionBundleInProcessOrThrow(directArgs) {
  if (!existsSync(frontendBundleScriptPath)) {
    throw new Error('companion bundle fallback script not found');
  }

  const bundleScriptUrl = pathToFileURL(frontendBundleScriptPath).href;
  const bundleModule = await import(bundleScriptUrl);
  if (typeof bundleModule.bundleCompanionWindows !== 'function') {
    throw new Error('companion bundle fallback script is missing bundleCompanionWindows export');
  }

  await bundleModule.bundleCompanionWindows({
    resetCache: companionBundleCommandRequestsResetCache(directArgs),
  });
}

async function runDirectFallbackOrThrow(command, args, options = {}) {
  const extracted = getDirectCommandFromCmdArgs(command, args);
  if (!extracted) {
    throw new Error(describeSpawnFailure(command, args, runDirectCapture(command, args, options)));
  }

  const {directCommand, directArgs} = extracted;
  const failures = [];
  const directResult = runDirectCapture(directCommand, directArgs, options);
  flushCapturedResult(directResult);
  if (directResult.status === 0) {
    return;
  }
  failures.push(describeSpawnFailure(directCommand, directArgs, directResult));

  if (process.platform === 'win32' && !directCommand.toLowerCase().endsWith('.cmd')) {
    const cmdCommand = `${directCommand}.cmd`;
    const cmdResult = runDirectCapture(cmdCommand, directArgs, options);
    flushCapturedResult(cmdResult);
    if (cmdResult.status === 0) {
      return;
    }
    failures.push(describeSpawnFailure(cmdCommand, directArgs, cmdResult));
  }

  const normalizedDirectCommand = directCommand.toLowerCase().replace(/\.cmd$/, '');
  if (normalizedDirectCommand === 'corepack') {
    const corepackScriptPath = resolveCorepackScriptPath();
    if (corepackScriptPath) {
      const nodeArgs = [corepackScriptPath, ...directArgs];
      const nodeResult = runDirectCapture(process.execPath, nodeArgs, options);
      flushCapturedResult(nodeResult);
      if (nodeResult.status === 0) {
        return;
      }
      failures.push(describeSpawnFailure(process.execPath, nodeArgs, nodeResult));
    } else {
      failures.push('corepack Node.js fallback script not found');
    }

    if (isCompanionBundleCommand(directArgs)) {
      if (existsSync(frontendBundleScriptPath)) {
        const bundleResult = runDirectCapture(process.execPath, [frontendBundleScriptPath], {
          ...options,
          cwd: frontendRoot,
        });
        flushCapturedResult(bundleResult);
        if (bundleResult.status === 0) {
          return;
        }
        failures.push(describeSpawnFailure(process.execPath, [frontendBundleScriptPath], bundleResult));
      } else {
        failures.push('companion bundle fallback script not found');
      }

      try {
        log('attempting in-process companion bundle fallback.');
        await runCompanionBundleInProcessOrThrow(directArgs);
        return;
      } catch (error) {
        failures.push(
          `in-process companion bundle fallback failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  throw new Error(failures.join('; fallback '));
}

function sleep(ms) {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

async function runBundleCommandWithRetry(args, options = {}) {
  const maxAttempts = 3;
  let finalRetriableFailure = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = runCmdCapture(args, options);
    flushCapturedResult(result);
    if (result.status === 0) {
      return;
    }
    const retriableFailure = isRetriableBundleFailure(result);
    if (!retriableFailure) {
      throw new Error(describeSpawnFailure('cmd.exe', ['/d', '/s', '/c', ...args], result));
    }
    if (attempt >= maxAttempts) {
      finalRetriableFailure = result;
      break;
    }

    log(
      `bundle attempt ${attempt}/${maxAttempts} hit transient spawn issue; retrying in 1500ms.`,
    );
    await sleep(1500);
  }

  if (finalRetriableFailure) {
    log('bundle retries exhausted; attempting direct command fallback outside cmd.exe wrapper.');
    await runDirectFallbackOrThrow('cmd.exe', ['/d', '/s', '/c', ...args], options);
    return;
  }

  throw new Error('bundle retries exhausted without a retriable failure snapshot.');
}

async function fileExists(targetPath) {
  try {
    await readFile(targetPath);
    return true;
  } catch {
    return false;
  }
}

function hostProcessExists() {
  const result = spawnSync('tasklist.exe', ['/FI', 'IMAGENAME eq OpappWindowsHost.exe', '/FO', 'CSV', '/NH'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  });

  return result.status === 0 && result.stdout.toLowerCase().includes('opappwindowshost.exe');
}

async function stopHostProcess() {
  spawnSync('taskkill.exe', ['/IM', 'OpappWindowsHost.exe', '/F', '/T'], {
    stdio: 'ignore',
    windowsHide: true,
  });
}

async function removeIfPresent(targetPath) {
  await rm(targetPath, {recursive: true, force: true});
}

async function bundleFrontend() {
  log('bundling frontend Windows artifact');

  const env = {
    ...process.env,
    COREPACK_HOME: path.join(workspaceRoot, '.corepack'),
    PNPM_HOME: path.join(workspaceRoot, '.pnpm'),
    TEMP: path.join(workspaceRoot, '.tmp'),
    TMP: path.join(workspaceRoot, '.tmp'),
    npm_config_cache: path.join(workspaceRoot, '.npm-cache'),
  };

  await runBundleCommandWithRetry(['corepack', 'pnpm', 'bundle:companion:windows'], {
    cwd: frontendRoot,
    env,
  });
}

function shouldTryPortableMsbuildFallback(classification) {
  return (
    launchMode === 'portable' &&
    classification.code === 'cmd-spawn-eperm' &&
    process.env.OPAPP_WINDOWS_RELEASE_ENABLE_MSBUILD_FALLBACK !== '0'
  );
}

function describeMsbuildFailure(profileId, msbuildPath, result) {
  const status = result.status ?? 'null';
  const code = result.error?.code;
  const message = result.error?.message;
  return `[${profileId}] ${msbuildPath} failed (status=${status}${code ? `, code=${code}` : ''}${message ? `, message=${message}` : ''})`;
}

async function runPortableMsbuildFallbackOrThrow(releaseBuildProbe) {
  if (!existsSync(windowsSolutionPath)) {
    throw new Error(`portable msbuild fallback unavailable: missing solution at ${windowsSolutionPath}`);
  }

  const msbuildCandidates = collectPortableMsbuildFallbackCandidates({
    probe: releaseBuildProbe,
  });
  if (msbuildCandidates.length === 0) {
    throw new Error(
      'portable msbuild fallback unavailable: no accessible msbuild.exe candidate discovered ' +
        '(set OPAPP_WINDOWS_MSBUILD_PATH to override)',
    );
  }

  const msbuildProfiles = collectPortableMsbuildFallbackProfiles();
  const failures = [];

  for (const profile of msbuildProfiles) {
    log(`portable-fallback strategy=${profile.id}: ${profile.description}`);
    const msbuildArgs = [windowsSolutionPath, ...profile.args];

    for (const msbuildPath of msbuildCandidates) {
      log(`portable-fallback trying strategy=${profile.id} msbuild candidate: ${msbuildPath}`);
      const result = runInherited(msbuildPath, msbuildArgs, {
        cwd: windowsSolutionRoot,
        env: process.env,
      });
      if (result.status === 0 && !result.error) {
        if (!(await fileExists(portableExePath))) {
          throw new Error(
            `portable msbuild fallback built successfully with ${msbuildPath} but did not produce ${portableExePath}`,
          );
        }
        log(`portable-fallback build succeeded via ${msbuildPath} strategy=${profile.id}`);
        return;
      }

      failures.push(describeMsbuildFailure(profile.id, msbuildPath, result));
    }
  }

  throw new Error(`portable msbuild fallback failed: ${failures.join('; ')}`);
}

function runReleasePreflightOrThrow() {
  const releaseBuildProbe = collectReleaseBuildProbe();
  for (const line of formatReleaseProbeForLogs(releaseBuildProbe)) {
    log(`release-preflight ${line}`);
  }

  const preflightBlockingFailure = getBlockingReleaseProbeFailure(releaseBuildProbe);
  const skipPreflightFailFast = process.env.OPAPP_WINDOWS_RELEASE_SKIP_PREFLIGHT_FAILFAST === '1';
  if (preflightBlockingFailure && !skipPreflightFailFast) {
    throw new Error(
      formatReleaseProbeReport({
        command: process.execPath,
        probe: releaseBuildProbe,
        blockingFailure: preflightBlockingFailure,
      }),
    );
  }

  if (preflightBlockingFailure) {
    log(
      `release-preflight blocking issue ignored via OPAPP_WINDOWS_RELEASE_SKIP_PREFLIGHT_FAILFAST=1: ${preflightBlockingFailure.reason}`,
    );
  }

  if (launchMode === 'portable') {
    const portableFallbackBlocker = getPortableMsbuildFallbackBlocker(releaseBuildProbe);
    if (portableFallbackBlocker) {
      log(`release-preflight portable-fallback blocker: ${portableFallbackBlocker}`);
    }
  }

  return releaseBuildProbe;
}

async function preparePackagedApp() {
  await bundleFrontend();

  log('resolving artifact from sibling frontend source');
  const artifactSource = new SiblingArtifactSource(frontendBundleRoot);
  const {manifest, manifestDir} = await artifactSource.resolve({platform: 'windows'});
  log(
    `artifact resolved: bundleId=${manifest.bundleId} version=${manifest.version} ` +
      `entryFile=${manifest.entryFile} surfaces=${manifest.surfaces?.join(',')}`,
  );

  log('staging frontend bundle into native host project');
  await removeIfPresent(hostBundleRoot);
  await mkdir(hostBundleRoot, {recursive: true});
  await cp(manifestDir, hostBundleRoot, {
    recursive: true,
    force: true,
    filter: sourcePath => {
      const relativePath = path.relative(manifestDir, sourcePath);
      return shouldStagePackagedBundleRelativePath(relativePath);
    },
  });

  const stagedManifestPath = path.join(hostBundleRoot, 'bundle-manifest.json');
  const stagedManifest = JSON.parse(await readFile(stagedManifestPath, 'utf8'));
  stagedManifest.sourceKind = 'sibling-staging';
  await writeFile(stagedManifestPath, JSON.stringify(stagedManifest, null, 2) + '\n', 'utf8');
  log('patched staged bundle-manifest.json: sourceKind=sibling-staging');

  await assertStagedManifest();

  log('building and deploying packaged release app');
  const releaseBuildProbe = runReleasePreflightOrThrow();

  const releaseArgs = [
    runWindowsCliWrapperPath,
    '--release',
    '--no-packager',
    '--no-launch',
    '--logging',
    '--no-telemetry',
  ];
  const releaseResult = runInheritedWithCaptureFallback(process.execPath, releaseArgs, {
    cwd: hostRoot,
    env: process.env,
  });
  if (releaseResult.status !== 0 || releaseResult.error) {
    const failureSummary = describeSpawnFailure(process.execPath, releaseArgs, releaseResult);
    const initialClassification = classifyRunWindowsFailure(
      [
        failureSummary,
        releaseResult.capturedOutput ?? '',
        releaseResult.error?.message ?? '',
        releaseBuildProbe.cmdProbe.errorMessage ?? '',
        releaseBuildProbe.vswhereProbe.errorMessage ?? '',
      ].join('\n'),
    );
    const classification = refineReleaseFailureClassification({
      classification: initialClassification,
      probe: releaseBuildProbe,
      result: releaseResult,
    });
    let fallbackFailureSummary = null;

    if (shouldTryPortableMsbuildFallback(classification)) {
      const portableFallbackBlocker = getPortableMsbuildFallbackBlocker(releaseBuildProbe);
      if (portableFallbackBlocker) {
        fallbackFailureSummary = `skipped: ${portableFallbackBlocker}`;
        log(`portable msbuild fallback skipped: ${portableFallbackBlocker}`);
      } else {
        log(
          'run-windows --release failed with cmd-spawn-eperm; attempting portable msbuild fallback.',
        );
        try {
          await runPortableMsbuildFallbackOrThrow(releaseBuildProbe);
          return;
        } catch (fallbackError) {
          fallbackFailureSummary =
            fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
          log(`portable msbuild fallback failed: ${fallbackFailureSummary}`);
        }
      }
    }

    const failureSummaryWithFallback = fallbackFailureSummary
      ? `${failureSummary}; portable msbuild fallback: ${fallbackFailureSummary}`
      : failureSummary;
    throw new Error(
      formatReleaseFailureDiagnostics({
        args: releaseArgs,
        classification,
        command: process.execPath,
        failureSummary: failureSummaryWithFallback,
        probe: releaseBuildProbe,
        result: releaseResult,
      }),
    );
  }

  const runtimeBundleResidueRoot = path.join(
    resolveRuntimeBundleRootForLaunchMode(),
    'bundles',
  );
  await removeIfPresent(runtimeBundleResidueRoot);
  log(`cleared runtime bundle residue: ${runtimeBundleResidueRoot}`);
}

function buildLaunchConfig() {
  let content = `[preferences]\npath=${preferencesPath}\n\n[sessions]\npath=${sessionsPath}\n`;

  if (scenario.launchConfig.initialOpen) {
    content += `\n[initial-open]\nsurface=${scenario.launchConfig.initialOpen.surface}\npolicy=${scenario.launchConfig.initialOpen.policy}\npresentation=${scenario.launchConfig.initialOpen.presentation}\n`;
    if (scenario.launchConfig.initialOpen.bundle) {
      content += `bundle=${scenario.launchConfig.initialOpen.bundle}\n`;
    }
  }

  if (scenario.launchConfig.initialOpenProps) {
    content += '\n[initial-open-props]\n';

    for (const [key, value] of Object.entries(scenario.launchConfig.initialOpenProps)) {
      content += `${key}=${value}\n`;
    }
  }

  if (scenario.launchConfig.mainProps) {
    content += '\n[main-props]\n';

    for (const [key, value] of Object.entries(scenario.launchConfig.mainProps)) {
      content += `${key}=${value}\n`;
    }
  }

  if (scenario.launchConfig.secondary) {
    content += `\n[secondary]\nsurface=${scenario.launchConfig.secondary.surface}\npolicy=${scenario.launchConfig.secondary.policy}\n`;
  }

  if (activeOtaRemoteArg || scenario.launchConfig.disableNativeOtaUpdate) {
    content += '\n[ota]\n';
    if (activeOtaRemoteArg) {
      content += `remote=${activeOtaRemoteArg}\n`;
    }
    if (activeOtaChannelArg) {
      content += `channel=${activeOtaChannelArg}\n`;
    }
    if (otaForceFlag) {
      content += 'force=true\n';
    }
    if (scenario.launchConfig.disableNativeOtaUpdate) {
      content += 'disable-native-update=true\n';
    }
  }

  return content;
}

function buildPreferencesFile() {
  let content = `[window]\nmain-mode=${scenario.preferences.mainWindowMode}\nsettings-mode=${scenario.preferences.settingsWindowMode}\n\n[surface]\nsettings-presentation=${scenario.preferences.settingsPresentation}\n`;

  if (scenario.startupTarget) {
    content += `\n[startup-target]\nsurface=${scenario.startupTarget.surfaceId}\nbundle=${scenario.startupTarget.bundleId}\npolicy=${scenario.startupTarget.policy}\npresentation=${scenario.startupTarget.presentation}\n`;
  }

  return content;
}

function getInstalledPackageFamilyName() {
  const packageFamilyName = runCaptureOrThrow(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `(Get-AppxPackage -Name '${packageName}' | Select-Object -First 1 -ExpandProperty PackageFamilyName)`,
    ],
    {cwd: repoRoot},
  ).trim();

  if (!packageFamilyName) {
    throw new Error(`Could not resolve PackageFamilyName for ${packageName}.`);
  }

  return packageFamilyName;
}

function launchInstalledApp() {
  const packageFamilyName = getInstalledPackageFamilyName();
  const appUserModelId = `${packageFamilyName}!${applicationId}`;
  const shellTarget = `shell:AppsFolder\\${appUserModelId}`;

  log(`launching installed app via ${appUserModelId}`);
  runOrThrow(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `Start-Process '${shellTarget}'`,
    ],
    {cwd: repoRoot},
  );
}

function launchPortableApp() {
  log(`launching portable exe via ${portableExePath}`);
  runOrThrow(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `Start-Process -FilePath '${portableExePath}' -WorkingDirectory '${portableReleaseRoot}'`,
    ],
    {cwd: repoRoot},
  );
}

function logTimingPhaseResult({phaseLabel, elapsedMs, budgetMs, timeoutFlag}) {
  const {message, hint} = buildTimingPhaseResult({
    phaseLabel,
    elapsedMs,
    budgetMs,
    timeoutFlag,
  });
  log(message);
  if (hint) {
    log(hint);
  }
}

async function waitForMarkers(markers, {timeoutMs, phaseLabel, timeoutFlag}) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 1000));

    if (!(await fileExists(logPath))) {
      continue;
    }

    const logContents = await readFile(logPath, 'utf8');

    for (const marker of failureMarkers) {
      if (logContents.includes(marker)) {
        const tail = logContents.split(/\r?\n/).slice(-160).join('\n');
        console.log('[smoke] failure log tail:');
        console.log(tail);
        throw new Error(`Windows release smoke failed: found '${marker}' while waiting for ${phaseLabel}.`);
      }
    }

    if (markers.every(marker => logContents.includes(marker))) {
      return logContents;
    }
  }

  if (await fileExists(logPath)) {
    const logContents = await readFile(logPath, 'utf8');
    const tail = logContents.split(/\r?\n/).slice(-180).join('\n');
    console.log(`[smoke] ${phaseLabel} timeout log tail:`);
    console.log(tail);
  }

  throw new Error(formatMarkerTimeoutMessage({
    phaseLabel,
    scenarioName,
    timeoutFlag,
    timeoutMs,
  }));
}

async function waitForOtaState({timeoutMs, timeoutFlag}) {
  const startMs = Date.now();
  while (Date.now() - startMs < timeoutMs) {
    if (await fileExists(otaStatePath)) {
      const otaState = JSON.parse(await readFile(otaStatePath, 'utf8'));
      if (typeof otaState?.version === 'string' && otaState.version && typeof otaState?.stagedAt === 'string') {
        return otaState;
      }
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }

  throw new Error(formatMarkerTimeoutMessage({
    phaseLabel: 'ota-state write',
    scenarioName,
    timeoutFlag,
    timeoutMs,
  }));
}

async function waitForOtaChannel({timeoutMs, timeoutFlag}) {
  const startMs = Date.now();
  while (Date.now() - startMs < timeoutMs) {
    if (await fileExists(otaChannelPath)) {
      const otaChannel = JSON.parse(await readFile(otaChannelPath, 'utf8'));
      if (typeof otaChannel?.channel === 'string' && otaChannel.channel) {
        return otaChannel;
      }
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }

  throw new Error(formatMarkerTimeoutMessage({
    phaseLabel: 'ota-channel write',
    scenarioName,
    timeoutFlag,
    timeoutMs,
  }));
}

async function waitForOtaDeviceId({timeoutMs, timeoutFlag}) {
  const startMs = Date.now();
  while (Date.now() - startMs < timeoutMs) {
    if (await fileExists(otaDeviceIdPath)) {
      const otaDevice = JSON.parse(await readFile(otaDeviceIdPath, 'utf8'));
      if (typeof otaDevice?.deviceId === 'string' && otaDevice.deviceId) {
        return otaDevice;
      }
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }

  throw new Error(formatMarkerTimeoutMessage({
    phaseLabel: 'ota-device-id write',
    scenarioName,
    timeoutFlag,
    timeoutMs,
  }));
}

async function waitForOtaLastRun({timeoutMs, timeoutFlag}) {
  const startMs = Date.now();
  while (Date.now() - startMs < timeoutMs) {
    if (await fileExists(otaLastRunPath)) {
      const lastRun = JSON.parse(await readFile(otaLastRunPath, 'utf8'));
      if (typeof lastRun?.mode === 'string' && typeof lastRun?.recordedAt === 'string') {
        return lastRun;
      }
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }

  throw new Error(formatMarkerTimeoutMessage({
    phaseLabel: 'ota last-run write',
    scenarioName,
    timeoutFlag,
    timeoutMs,
  }));
}

async function waitForOtaIndexBundleInfo({bundleId, timeoutMs, timeoutFlag, allowMissingBundleInfo = false}) {
  const startMs = Date.now();
  while (Date.now() - startMs < timeoutMs) {
    if (await fileExists(otaIndexPath)) {
      try {
        const otaIndex = JSON.parse(await readFile(otaIndexPath, 'utf8'));
        const bundleInfo = otaIndex?.bundles?.[bundleId];
        if (bundleInfo && typeof bundleInfo === 'object' && !Array.isArray(bundleInfo)) {
          return bundleInfo;
        }
        if (allowMissingBundleInfo && otaIndex?.bundles && typeof otaIndex.bundles === 'object') {
          return null;
        }
      } catch {
        // Retry until the file is fully written and parseable.
      }
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }

  throw new Error(formatMarkerTimeoutMessage({
    phaseLabel: `ota index bundle info (${bundleId})`,
    scenarioName,
    timeoutFlag,
    timeoutMs,
  }));
}

function normalizeOtaChannels(candidate) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return undefined;
  }

  const normalized = {};
  for (const [channelName, version] of Object.entries(candidate)) {
    if (typeof channelName !== 'string' || !channelName) {
      return undefined;
    }
    if (typeof version !== 'string' || !version) {
      return undefined;
    }
    normalized[channelName] = version;
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function formatOtaChannels(channels) {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(channels).sort(([left], [right]) => left.localeCompare(right)),
    ),
  );
}

function otaChannelsEqual(left, right) {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }

  for (let index = 0; index < leftKeys.length; index += 1) {
    const key = leftKeys[index];
    if (key !== rightKeys[index] || left[key] !== right[key]) {
      return false;
    }
  }

  return true;
}

export function resolveExpectedOtaLatestVersion({bundleInfo, channel}) {
  const hasVersionList = Array.isArray(bundleInfo?.versions);
  const versions = hasVersionList
    ? bundleInfo.versions.filter(version => typeof version === 'string' && version)
    : [];
  const overallLatest = [...versions].sort().at(-1);
  const legacyLatestVersion =
    !hasVersionList && typeof bundleInfo?.latestVersion === 'string' && bundleInfo.latestVersion
      ? bundleInfo.latestVersion
      : undefined;
  const channels = normalizeOtaChannels(bundleInfo?.channels);
  const pickVersion = candidate => {
    if (typeof candidate !== 'string' || !candidate) {
      return undefined;
    }
    if (hasVersionList && !versions.includes(candidate)) {
      return undefined;
    }
    return candidate;
  };

  let resolvedLatestVersion;
  if (typeof channel === 'string' && channel) {
    resolvedLatestVersion = pickVersion(channels?.[channel]);
    if (!resolvedLatestVersion && channel !== 'stable') {
      resolvedLatestVersion = pickVersion(channels?.stable);
    }
  }

  return resolvedLatestVersion ?? overallLatest ?? legacyLatestVersion;
}

export function validateOtaLastRunRecord({
  otaLastRun,
  otaRemoteBase,
  loggedCurrentVersion,
  expectedChannels,
  expectedLatestVersion,
  expectedStatus = 'success',
}) {
  if (otaLastRun.mode !== 'update') {
    throw new Error(
      `Windows release smoke failed: ota last-run mode was '${otaLastRun.mode ?? 'unknown'}', expected 'update'.`,
    );
  }
  if (otaLastRun.remoteBase !== otaRemoteBase) {
    throw new Error(
      `Windows release smoke failed: ota last-run remoteBase was '${otaLastRun.remoteBase ?? 'unknown'}', expected '${otaRemoteBase}'.`,
    );
  }
  const normalizedExpectedChannels = normalizeOtaChannels(expectedChannels);
  const otaStatus = otaLastRun.status ?? 'unknown';

  if (expectedStatus === 'failed') {
    if (otaLastRun.status !== 'failed') {
      throw new Error(
        `Windows release smoke failed: ota last-run status was '${otaStatus}', expected 'failed'.`,
      );
    }
    if (typeof otaLastRun.channel !== 'string' || !otaLastRun.channel) {
      throw new Error(
        'Windows release smoke failed: failed ota last-run is missing the resolved channel.',
      );
    }
    if (
      loggedCurrentVersion &&
      (typeof otaLastRun.currentVersion !== 'string' || !otaLastRun.currentVersion)
    ) {
      throw new Error(
        'Windows release smoke failed: failed ota last-run is missing currentVersion even though the host logged it.',
      );
    }
    if (
      (expectedLatestVersion !== undefined || normalizedExpectedChannels) &&
      (typeof otaLastRun.bundleId !== 'string' || !otaLastRun.bundleId)
    ) {
      throw new Error(
        'Windows release smoke failed: failed ota last-run is missing the resolved bundleId after remote resolution.',
      );
    }
    for (const field of ['bundleId', 'currentVersion', 'latestVersion', 'deviceId']) {
      if (
        otaLastRun[field] !== null &&
        otaLastRun[field] !== undefined &&
        (typeof otaLastRun[field] !== 'string' || !otaLastRun[field])
      ) {
        throw new Error(
          `Windows release smoke failed: ota last-run ${field} must be null or a non-empty string for failed runs.`,
        );
      }
    }
    if (
      otaLastRun.hasUpdate !== null &&
      otaLastRun.hasUpdate !== undefined &&
      typeof otaLastRun.hasUpdate !== 'boolean'
    ) {
      throw new Error(
        'Windows release smoke failed: failed ota last-run hasUpdate must be null/boolean.',
      );
    }
    if (
      otaLastRun.inRollout !== null &&
      otaLastRun.inRollout !== undefined &&
      typeof otaLastRun.inRollout !== 'boolean'
    ) {
      throw new Error(
        'Windows release smoke failed: failed ota last-run inRollout must be null/boolean.',
      );
    }
    if (
      otaLastRun.rolloutPercent !== null &&
      otaLastRun.rolloutPercent !== undefined &&
      typeof otaLastRun.rolloutPercent !== 'number'
    ) {
      throw new Error(
        'Windows release smoke failed: ota last-run rolloutPercent must be null/number.',
      );
    }
    for (const field of ['version', 'previousVersion', 'stagedAt']) {
      if (otaLastRun[field] !== null && otaLastRun[field] !== undefined) {
        throw new Error(
          `Windows release smoke failed: failed ota last-run must not report staged ${field}.`,
        );
      }
    }
    if (expectedLatestVersion !== undefined) {
      if (typeof otaLastRun.latestVersion !== 'string' || !otaLastRun.latestVersion) {
        throw new Error(
          'Windows release smoke failed: failed ota last-run is missing the resolved latestVersion after remote resolution.',
        );
      }
      if (otaLastRun.latestVersion !== expectedLatestVersion) {
        throw new Error(
          `Windows release smoke failed: ota last-run latestVersion '${otaLastRun.latestVersion}' ` +
            `did not match the remote index resolved version '${expectedLatestVersion}'.`,
        );
      }
    }
    if (normalizedExpectedChannels) {
      const normalizedLastRunChannels = normalizeOtaChannels(otaLastRun.channels);
      if (!normalizedLastRunChannels) {
        throw new Error(
          'Windows release smoke failed: failed ota last-run is missing the remote channels map persisted by the updater.',
        );
      }
      if (!otaChannelsEqual(normalizedLastRunChannels, normalizedExpectedChannels)) {
        throw new Error(
          `Windows release smoke failed: ota last-run channels ${formatOtaChannels(normalizedLastRunChannels)} ` +
            `did not match remote index channels ${formatOtaChannels(normalizedExpectedChannels)}.`,
        );
      }
    }
    if (
      otaLastRun.currentVersion &&
      loggedCurrentVersion &&
      otaLastRun.currentVersion !== loggedCurrentVersion
    ) {
      throw new Error(
        `Windows release smoke failed: ota last-run currentVersion '${otaLastRun.currentVersion}' did not match the host logged currentVersion '${loggedCurrentVersion}'.`,
      );
    }
    return {requiresOtaState: false, status: otaLastRun.status};
  }
  if (typeof otaLastRun.bundleId !== 'string' || !otaLastRun.bundleId) {
    throw new Error(
      'Windows release smoke failed: ota last-run is missing the resolved bundleId.',
    );
  }
  if (typeof otaLastRun.channel !== 'string' || !otaLastRun.channel) {
    throw new Error(
      'Windows release smoke failed: ota last-run is missing the resolved channel.',
    );
  }
  if (typeof otaLastRun.latestVersion !== 'string' || !otaLastRun.latestVersion) {
    throw new Error(
      'Windows release smoke failed: ota last-run is missing the resolved latestVersion.',
    );
  }
  if (expectedLatestVersion && otaLastRun.latestVersion !== expectedLatestVersion) {
    throw new Error(
      `Windows release smoke failed: ota last-run latestVersion '${otaLastRun.latestVersion}' ` +
        `did not match the remote index resolved version '${expectedLatestVersion}'.`,
    );
  }
  if (typeof otaLastRun.hasUpdate !== 'boolean') {
    throw new Error(
      'Windows release smoke failed: ota last-run is missing boolean hasUpdate.',
    );
  }
  if (typeof otaLastRun.deviceId !== 'string' || !otaLastRun.deviceId) {
    throw new Error(
      'Windows release smoke failed: ota last-run is missing a persisted deviceId.',
    );
  }
  if (typeof otaLastRun.inRollout !== 'boolean') {
    throw new Error(
      'Windows release smoke failed: ota last-run is missing boolean inRollout.',
    );
  }
  if (normalizedExpectedChannels) {
    const normalizedLastRunChannels = normalizeOtaChannels(otaLastRun.channels);
    if (!normalizedLastRunChannels) {
      throw new Error(
        'Windows release smoke failed: ota last-run is missing the remote channels map persisted by the updater.',
      );
    }
    if (!otaChannelsEqual(normalizedLastRunChannels, normalizedExpectedChannels)) {
      throw new Error(
        `Windows release smoke failed: ota last-run channels ${formatOtaChannels(normalizedLastRunChannels)} ` +
          `did not match remote index channels ${formatOtaChannels(normalizedExpectedChannels)}.`,
      );
    }
  }
  if (
    otaLastRun.rolloutPercent !== null &&
    otaLastRun.rolloutPercent !== undefined &&
    typeof otaLastRun.rolloutPercent !== 'number'
  ) {
    throw new Error(
      'Windows release smoke failed: ota last-run rolloutPercent must be null/number.',
    );
  }
  if (expectedStatus === 'success') {
    if (otaLastRun.status !== 'updated' && otaLastRun.status !== 'up-to-date') {
      throw new Error(
        `Windows release smoke failed: ota last-run status was '${otaStatus}', expected 'updated' or 'up-to-date'.`,
      );
    }
  } else if (otaLastRun.status !== expectedStatus) {
    throw new Error(
      `Windows release smoke failed: ota last-run status was '${otaStatus}', expected '${expectedStatus}'.`,
    );
  }
  if (
    otaLastRun.currentVersion &&
    loggedCurrentVersion &&
    otaLastRun.currentVersion !== loggedCurrentVersion
  ) {
    throw new Error(
      `Windows release smoke failed: ota last-run currentVersion '${otaLastRun.currentVersion}' did not match the host logged currentVersion '${loggedCurrentVersion}'.`,
    );
  }
  if (otaLastRun.status === 'up-to-date') {
    if (otaLastRun.hasUpdate) {
      throw new Error(
        'Windows release smoke failed: ota last-run reported hasUpdate=true even though no update was applied.',
      );
    }
    if (otaLastRun.version !== null && otaLastRun.version !== undefined) {
      throw new Error(
        `Windows release smoke failed: ota last-run reported version '${otaLastRun.version}' even though no update was applied.`,
      );
    }
    if (otaLastRun.previousVersion !== null && otaLastRun.previousVersion !== undefined) {
      throw new Error(
        `Windows release smoke failed: ota last-run reported previousVersion '${otaLastRun.previousVersion}' even though no update was applied.`,
      );
    }
    if (otaLastRun.stagedAt !== null && otaLastRun.stagedAt !== undefined) {
      throw new Error(
        `Windows release smoke failed: ota last-run reported stagedAt '${otaLastRun.stagedAt}' even though no update was applied.`,
      );
    }
    return {requiresOtaState: false, status: otaLastRun.status};
  }
  if (typeof otaLastRun.version !== 'string' || !otaLastRun.version) {
    throw new Error(
      'Windows release smoke failed: ota last-run is missing the staged version for an updated run.',
    );
  }
  if (!otaLastRun.hasUpdate) {
    throw new Error(
      'Windows release smoke failed: ota last-run reported hasUpdate=false even though an update was applied.',
    );
  }
  if (typeof otaLastRun.stagedAt !== 'string' || !otaLastRun.stagedAt) {
    throw new Error(
      'Windows release smoke failed: ota last-run is missing stagedAt for an updated run.',
    );
  }
  return {requiresOtaState: true, status: otaLastRun.status};
}

async function verifyOtaSideEffects(logContents) {
  if (!activeOtaRemoteArg || scenario.skipNativeOtaVerification) {
    return;
  }

  const normalizedLog = normalizeLogContents(logContents);
  const runtimeBundleRoot = extractRuntimeBundleRoot(logContents);

  if (!normalizedLog.includes('OTA.EnsureBundle.Start bundleId=')) {
    await waitForMarkers(['OTA.SpawnUpdateProcess.OK'], {
      timeoutMs: scenarioTimeoutMs,
      phaseLabel: 'ota spawn marker',
      timeoutFlag: '--scenario-ms',
    });
  }

  const otaLastRun = await waitForOtaLastRun({
    timeoutMs: scenarioTimeoutMs,
    timeoutFlag: '--scenario-ms',
  });

  const otaResolvedBundleMetadata =
    normalizedLog.includes('OTA.Native.BundleInfoMissing bundleId=') ||
    normalizedLog.includes('OTA.Native.LatestVersionMissing bundleId=') ||
    normalizedLog.includes('OTA.Native.LatestVersion source=');
  if (
    otaExpectedStatus === 'failed' &&
    otaResolvedBundleMetadata &&
    (typeof otaLastRun.bundleId !== 'string' || !otaLastRun.bundleId)
  ) {
    throw new Error(
      'Windows release smoke failed: failed ota last-run dropped bundleId even though native OTA already resolved bundle metadata.',
    );
  }
  if (activeOtaChannelArg) {
    const otaChannel = await waitForOtaChannel({
      timeoutMs: scenarioTimeoutMs,
      timeoutFlag: '--scenario-ms',
    });
    if (otaChannel?.channel !== activeOtaChannelArg) {
      throw new Error(
        `Windows release smoke failed: ota channel persisted as '${otaChannel?.channel ?? 'unknown'}', expected '${activeOtaChannelArg}'.`,
      );
    }
  }

  const resolvedLoggedBundleId =
    typeof otaLastRun.bundleId === 'string' && otaLastRun.bundleId ? otaLastRun.bundleId : null;
  const otaSpawnHostBundleDir = extractOtaSpawnHostBundleDir(logContents, resolvedLoggedBundleId);
  const expectedOtaHostBundleDir = otaSpawnHostBundleDir ?? runtimeBundleRoot;
  if (
    !otaSpawnHostBundleDir &&
    !normalizedLog.includes(`hostBundleDir=${runtimeBundleRoot}`)
  ) {
    throw new Error(
      `Windows release smoke failed: ota spawn log did not target the runtime bundle root '${runtimeBundleRoot}'.`,
    );
  }
  const loggedCurrentVersion = extractOtaLoggedCurrentVersion(logContents, resolvedLoggedBundleId);
  let expectedChannels;
  let expectedLatestVersion;
  if (typeof otaLastRun.bundleId === 'string' && otaLastRun.bundleId) {
    const otaIndexBundleInfo = await waitForOtaIndexBundleInfo({
      bundleId: otaLastRun.bundleId,
      timeoutMs: scenarioTimeoutMs,
      timeoutFlag: '--scenario-ms',
      allowMissingBundleInfo: otaExpectedStatus === 'failed',
    });
    if (otaIndexBundleInfo) {
      expectedChannels = normalizeOtaChannels(otaIndexBundleInfo.channels);
      expectedLatestVersion = resolveExpectedOtaLatestVersion({
        bundleInfo: otaIndexBundleInfo,
        channel: otaLastRun.channel,
      });
    }
  }
  const otaLastRunValidation = validateOtaLastRunRecord({
    otaLastRun,
    otaRemoteBase: activeOtaRemoteArg,
    loggedCurrentVersion,
    expectedChannels,
    expectedLatestVersion,
    expectedStatus: otaExpectedStatus,
  });
  if (
    otaExpectedStatus === 'failed' &&
    normalizedLog.includes('OTA.Native.DeviceId value=') &&
    (typeof otaLastRun.deviceId !== 'string' || !otaLastRun.deviceId)
  ) {
    throw new Error(
      'Windows release smoke failed: failed ota last-run dropped deviceId even though native OTA logged it.',
    );
  }
  if (
    otaExpectedStatus === 'failed' &&
    normalizedLog.includes('OTA.Native.Rollout percent=') &&
    typeof otaLastRun.inRollout !== 'boolean'
  ) {
    throw new Error(
      'Windows release smoke failed: failed ota last-run dropped inRollout even though native OTA logged a rollout decision.',
    );
  }
  if (typeof otaLastRun.deviceId === 'string' && otaLastRun.deviceId) {
    if (!normalizedLog.includes('OTA.Native.DeviceId value=')) {
      throw new Error(
        'Windows release smoke failed: native OTA log is missing the persisted device-id marker.',
      );
    }
    await waitForOtaDeviceId({
      timeoutMs: scenarioTimeoutMs,
      timeoutFlag: '--scenario-ms',
    });
  }
  if (
    typeof otaLastRun.inRollout === 'boolean' ||
    otaLastRun.rolloutPercent !== null && otaLastRun.rolloutPercent !== undefined
  ) {
    if (!normalizedLog.includes('OTA.Native.Rollout percent=')) {
      throw new Error(
        'Windows release smoke failed: native OTA log is missing rollout decision markers.',
      );
    }
  }
  if (!otaLastRunValidation.requiresOtaState) {
    return;
  }

  const otaState = await waitForOtaState({
    timeoutMs: scenarioTimeoutMs,
    timeoutFlag: '--scenario-ms',
  });
  if (otaState.hostBundleDir !== expectedOtaHostBundleDir) {
    throw new Error(
      `Windows release smoke failed: ota-state hostBundleDir was '${otaState.hostBundleDir ?? 'unknown'}', expected '${expectedOtaHostBundleDir}'.`,
    );
  }
  if (otaState.version !== otaLastRun.version) {
    throw new Error(
      `Windows release smoke failed: ota-state version '${otaState.version}' did not match ota last-run version '${otaLastRun.version ?? 'unknown'}'.`,
    );
  }
}

async function verifyPersistedSession() {
  const sessionFile = await readFile(sessionsPath, 'utf8');
  scenario.verifyPersistedSession?.(sessionFile);
}

async function verifyPersistedPreferences() {
  if (!scenario.verifyPersistedPreferences) {
    return;
  }

  const preferencesFile = await readFile(preferencesPath, 'utf8');
  scenario.verifyPersistedPreferences(preferencesFile);
}

async function main() {
  validateOtaArgs();
  log(`repoRoot=${repoRoot}`);
  log(`frontendRoot=${frontendRoot}`);
  log(`hostRoot=${hostRoot}`);
  log(`hostBundleRoot=${hostBundleRoot}`);
  log(`portableReleaseRoot=${portableReleaseRoot}`);
  log(`portableExePath=${portableExePath}`);
  log(`logPath=${logPath}`);
  log(`otaCacheRoot=${otaCacheRoot}`);
  log(`otaIndexPath=${otaIndexPath}`);
  log(`otaLastRunPath=${otaLastRunPath}`);
  log(`otaStatePath=${otaStatePath}`);
  log(`launchConfigPath=${launchConfigPath}`);
  log(`preferencesPath=${preferencesPath}`);
  log(`runWindowsCliWrapperPath=${runWindowsCliWrapperPath}`);
  log(`scenario=${scenarioName}`);
  log(`scenarioDescription=${scenario.description}`);
  log(`optionalPrivateScenarioModulePath=${optionalPrivateScenarioModulePath}`);
  log(`optionalPrivateScenarioCount=${optionalPrivateScenarioCount}`);
  log(`launchMode=${launchMode}`);
  if (timeoutDefaultsPath) {
    log(`timeoutDefaultsPath=${timeoutDefaultsPath}`);
    log(`timeoutDefaultsLaunch=${selectedTimeoutDefaults.launchMode}`);
    if (suggestedVerifyTotalTimeoutMs !== null) {
      log(`timeoutDefaultsVerifyTotalMs=${suggestedVerifyTotalTimeoutMs}`);
    }
  }
  log(`readinessTimeoutMs=${readinessTimeoutMs}`);
  log(`smokeTimeoutMs=${smokeTimeoutMs}`);
  log(`startupTimeoutMs=${startupTimeoutMs}`);
  log(`scenarioTimeoutMs=${scenarioTimeoutMs}`);
  log(`validateOnly=${validateOnly}`);
  log(`preflightOnly=${preflightOnly}`);
  log(`skipPrepare=${skipPrepare}`);
  log(`resetSessions=${resetSessions}`);
  if (activeOtaRemoteArg) {
    log(`otaRemote=${activeOtaRemoteArg}`);
  }
  if (activeOtaChannelArg) {
    log(`otaChannel=${activeOtaChannelArg}`);
  }
  log(`otaForce=${otaForceFlag}`);
  if (activeOtaRemoteArg || otaExpectedStatusArg !== undefined) {
    log(`otaExpectedStatus=${otaExpectedStatus}`);
  }
  if (validateOnly && preflightOnly) {
    throw new Error('`--validate-only` conflicts with `--preflight-only`; choose one execution mode.');
  }
  if (validateOnly) {
    log('validate-only enabled; skipping bundle/build/launch execution.');
    return;
  }
  if (preflightOnly) {
    log('preflight-only enabled; collecting release toolchain probe diagnostics only.');
    runReleasePreflightOrThrow();
    return;
  }
  let runError = null;
  let scenarioState = null;
  let startupTargetSnapshot = missingOptionalFile;

  await stopHostProcess();
  await removeIfPresent(logPath);
  await removeIfPresent(launchConfigPath);
  await removeIfPresent(preferencesPath);
  if (otaRemoteArg || scenario.usesLocalOtaRemoteFixture) {
    await removeIfPresent(otaIndexPath);
    await removeIfPresent(otaLastRunPath);
    await removeIfPresent(otaStatePath);
    if (otaChannelArg || scenario.usesLocalOtaRemoteFixture) {
      await removeIfPresent(otaChannelPath);
    }
  }
  if (resetSessions || !preserveState) {
    await removeIfPresent(sessionsPath);
  }

  try {
    activeOtaRemoteArg = otaRemoteArg ?? null;
    activeOtaChannelArg = otaChannelArg ?? null;
    await mkdir(tempRoot, {recursive: true});
    await writeFile(preferencesPath, buildPreferencesFile(), 'utf8');

    if (skipPrepare) {
      log('reusing prepared frontend bundle and packaged app');
    } else {
      await preparePackagedApp();
    }

    startupTargetSnapshot = await snapshotOptionalTextFile(
      companionStartupTargetPath,
    );
    await rm(companionStartupTargetPath, {force: true});

    if (scenario.prepareState) {
      scenarioState = await scenario.prepareState();
    }
    activeOtaRemoteArg = scenarioState?.otaRemoteBaseUrl ?? otaRemoteArg ?? null;
    activeOtaChannelArg = scenarioState?.otaChannel ?? otaChannelArg ?? null;
    if (activeOtaRemoteArg) {
      log(`resolved otaRemote=${activeOtaRemoteArg}`);
    }
    if (activeOtaChannelArg) {
      log(`resolved otaChannel=${activeOtaChannelArg}`);
    }

    log('writing launch config for release smoke');
    await writeFile(launchConfigPath, buildLaunchConfig(), 'utf8');

    if (launchMode === 'portable') {
      if (!(await fileExists(portableExePath))) {
        throw new Error(`Windows release smoke failed: portable exe not found at ${portableExePath}.`);
      }

      launchPortableApp();
    } else {
      launchInstalledApp();
    }

    const markersTimingStartMs = Date.now();
    const startupPhaseStartMs = Date.now();
    await waitForMarkers(startupMarkers, {
      timeoutMs: startupTimeoutMs,
      phaseLabel: 'startup markers',
      timeoutFlag: '--startup-ms',
    });
    const startupPhaseDurationMs = Date.now() - startupPhaseStartMs;
    logTimingPhaseResult({
      phaseLabel: 'startup markers',
      elapsedMs: startupPhaseDurationMs,
      budgetMs: startupTimeoutMs,
      timeoutFlag: '--startup-ms',
    });

    const scenarioPhaseStartMs = Date.now();
    const logContents = await waitForMarkers(successMarkers, {
      timeoutMs: scenarioTimeoutMs,
      phaseLabel: 'scenario success markers',
      timeoutFlag: '--scenario-ms',
    });
    const scenarioPhaseDurationMs = Date.now() - scenarioPhaseStartMs;
    logTimingPhaseResult({
      phaseLabel: 'scenario success markers',
      elapsedMs: scenarioPhaseDurationMs,
      budgetMs: scenarioTimeoutMs,
      timeoutFlag: '--scenario-ms',
    });

    const markerTotalDurationMs = Date.now() - markersTimingStartMs;
    log(formatMarkerTimingSummary({
      scenarioName,
      launchMode,
      startupPhaseDurationMs,
      scenarioPhaseDurationMs,
      markerTotalDurationMs,
    }));

    await assertBundledPolicyRegistry(logContents);
    await scenario.verifyLog?.(logContents);
    const tail = logContents.split(/\r?\n/).slice(-120).join('\n');
    console.log('[smoke] success log tail:');
    console.log(tail);
    await verifyOtaSideEffects(logContents);
    await verifyPersistedSession();
    await verifyPersistedPreferences();
  } catch (error) {
    runError = error;
  } finally {
    await stopHostProcess();
    await new Promise(resolve => setTimeout(resolve, 250));

    if (!runError && hostProcessExists()) {
      runError = new Error('OpappWindowsHost is still running after smoke cleanup.');
    }

    await removeIfPresent(launchConfigPath);
    await removeIfPresent(preferencesPath);
    if (!preserveState) {
      await removeIfPresent(sessionsPath);
    }

    if (scenario.cleanupState) {
      await scenario.cleanupState(scenarioState);
    }

    await restoreOptionalTextFile(
      companionStartupTargetPath,
      startupTargetSnapshot,
    );
  }

  if (runError) {
    throw runError;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}










