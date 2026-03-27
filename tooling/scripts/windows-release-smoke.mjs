import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {cp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {SiblingArtifactSource} from './artifact-source.mjs';
import {
  classifyRunWindowsFailure,
  collectReleaseBuildProbe,
  getBlockingReleaseProbeFailure,
  formatReleaseFailureDiagnostics,
  formatReleaseProbeForLogs,
  refineReleaseFailureClassification,
} from './windows-release-diagnostics.mjs';

const scenarioArg = process.argv
  .find(argument => argument.startsWith('--scenario='))
  ?.split('=')[1];
const includeSecondaryWindow = process.argv.includes('--include-secondary-window');
const skipPrepare = process.argv.includes('--skip-prepare');
const preserveState = process.argv.includes('--preserve-state');
const resetSessions = process.argv.includes('--reset-sessions');
const launchModeArg = process.argv.find(argument => argument.startsWith('--launch='))?.split('=')[1];
const portableFlag = process.argv.includes('--portable');
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');
const workspaceRoot = path.resolve(repoRoot, '..');
const frontendRoot = path.join(workspaceRoot, 'opapp-frontend');
const frontendBundleScriptPath = path.join(frontendRoot, 'tooling', 'scripts', 'bundle-companion-windows.mjs');
const frontendBundleRoot = path.join(frontendRoot, '.dist', 'bundles', 'companion-app', 'windows');
const hostRoot = path.join(repoRoot, 'hosts', 'windows-host');
const hostBundleRoot = path.join(hostRoot, 'windows', 'OpappWindowsHost', 'Bundle');
const portableReleaseRoot = path.join(hostRoot, 'windows', 'x64', 'Release');
const portableExePath = path.join(portableReleaseRoot, 'OpappWindowsHost.exe');
const tempRoot = process.env.TEMP || process.env.TMP || path.join(workspaceRoot, '.tmp');
const logPath = path.join(tempRoot, 'opapp-windows-host.log');
const launchConfigPath = path.join(tempRoot, 'opapp-windows-host.launch.ini');
const preferencesPath = path.join(tempRoot, 'opapp-windows-host.preferences.ini');
const sessionsPath = path.join(tempRoot, 'opapp-windows-host.sessions.ini');
const cliPath = path.join(hostRoot, 'node_modules', '@react-native-community', 'cli', 'build', 'bin.js');
const packageName = 'OpappWindowsHost';
const applicationId = 'App';
const windowPolicyRegistryPath = path.join(frontendRoot, 'contracts', 'windowing', 'src', 'window-policy-registry.json');
const launchMode = portableFlag ? 'portable' : (launchModeArg === 'portable' ? 'portable' : 'packaged');

let windowPolicyRegistryCache = null;

function resolveScenarioName() {
  if (
    scenarioArg === 'main-window-bootstrap-compact' ||
    scenarioArg === 'tab-session' ||
    scenarioArg === 'restore-tab-session' ||
    scenarioArg === 'restore-settings-window' ||
    scenarioArg === 'settings-default-current-window' ||
    scenarioArg === 'settings-default-new-window' ||
    scenarioArg === 'save-main-window-preferences' ||
    scenarioArg === 'secondary-window'
  ) {
    return scenarioArg;
  }

  if (includeSecondaryWindow) {
    return 'secondary-window';
  }

  return 'tab-session';
}

const scenarioName = resolveScenarioName();

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function normalizeLogContents(logContents) {
  return logContents.replace(/\r/g, '');
}

function assertLogDoesNotContain(logContents, marker, reason) {
  if (normalizeLogContents(logContents).includes(marker)) {
    throw new Error(`Windows release smoke failed: ${reason}`);
  }
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

  if (manifest.sourceKind !== 'sibling-staging') {
    throw new Error(
      `Windows release smoke failed: bundle-manifest.json sourceKind is '${manifest.sourceKind}', expected 'sibling-staging'. ` +
      'Staging step must overwrite sourceKind when copying manifest to the host Bundle directory.',
    );
  }

  log(`manifest OK: bundleId=${manifest.bundleId} version=${manifest.version} surfaces=${manifest.surfaces?.join(',')} sourceKind=${manifest.sourceKind}`);
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

const smokeScenarios = {
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

      if (normalized.includes('[frontend-companion] auto-open window=window.main')) {
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

      assertPersistedSessionContains(
        sessionFile,
        'window.main',
        'companion.main',
        'main window session is missing the main surface for default new-window settings flow.',
      );
      assertPersistedSessionDoesNotContain(
        sessionFile,
        'window.main',
        'companion.settings',
        'main window session unexpectedly persisted the settings surface for default new-window settings flow.',
      );
      assertPersistedSessionContains(
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

      if (normalized.includes('[frontend-companion] auto-open window=window.main')) {
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

      assertPersistedSessionContains(
        sessionFile,
        'window.main',
        'companion.main',
        'main window session is missing the main surface during detached settings restore.',
      );
      assertPersistedSessionDoesNotContain(
        sessionFile,
        'window.main',
        'companion.settings',
        'main window session unexpectedly persisted the settings surface during detached settings restore.',
      );
      assertPersistedSessionContains(
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

const scenario = smokeScenarios[scenarioName];

if (!scenario) {
  throw new Error(`Unsupported smoke scenario: ${scenarioName}`);
}

const successMarkers = [
  ...scenario.successMarkers,
  ...(launchMode === 'portable' ? ['WinMain.BootstrapInitialize', 'WinMain.BootstrapInitialize.Done'] : []),
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
  await cp(manifestDir, hostBundleRoot, {recursive: true, force: true});

  const stagedManifestPath = path.join(hostBundleRoot, 'bundle-manifest.json');
  const stagedManifest = JSON.parse(await readFile(stagedManifestPath, 'utf8'));
  stagedManifest.sourceKind = 'sibling-staging';
  await writeFile(stagedManifestPath, JSON.stringify(stagedManifest, null, 2) + '\n', 'utf8');
  log('patched staged bundle-manifest.json: sourceKind=sibling-staging');

  await assertStagedManifest();

  log('building and deploying packaged release app');
  const releaseBuildProbe = collectReleaseBuildProbe();
  for (const line of formatReleaseProbeForLogs(releaseBuildProbe)) {
    log(`release-preflight ${line}`);
  }

  const preflightBlockingFailure = getBlockingReleaseProbeFailure(releaseBuildProbe);
  const skipPreflightFailFast = process.env.OPAPP_WINDOWS_RELEASE_SKIP_PREFLIGHT_FAILFAST === '1';
  if (preflightBlockingFailure && !skipPreflightFailFast) {
    const classification = classifyRunWindowsFailure(preflightBlockingFailure.classifierHint);
    throw new Error(
      formatReleaseFailureDiagnostics({
        args: [],
        classification,
        command: process.execPath,
        failureSummary: `release preflight blocked execution: ${preflightBlockingFailure.reason}`,
        probe: releaseBuildProbe,
        result: {status: null, error: {code: preflightBlockingFailure.code}},
      }),
    );
  }
  if (preflightBlockingFailure) {
    log(
      `release-preflight blocking issue ignored via OPAPP_WINDOWS_RELEASE_SKIP_PREFLIGHT_FAILFAST=1: ${preflightBlockingFailure.reason}`,
    );
  }

  const releaseArgs = [
    cliPath,
    'run-windows',
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
    throw new Error(
      formatReleaseFailureDiagnostics({
        args: releaseArgs,
        classification,
        command: process.execPath,
        failureSummary,
        probe: releaseBuildProbe,
        result: releaseResult,
      }),
    );
  }
}

function buildLaunchConfig() {
  let content = `[preferences]\npath=${preferencesPath}\n\n[sessions]\npath=${sessionsPath}\n`;

  if (scenario.launchConfig.initialOpen) {
    content += `\n[initial-open]\nsurface=${scenario.launchConfig.initialOpen.surface}\npolicy=${scenario.launchConfig.initialOpen.policy}\npresentation=${scenario.launchConfig.initialOpen.presentation}\n`;
  }

  if (scenario.launchConfig.initialOpenProps) {
    content += '\n[initial-open-props]\n';

    for (const [key, value] of Object.entries(scenario.launchConfig.initialOpenProps)) {
      content += `${key}=${value}\n`;
    }
  }

  if (scenario.launchConfig.secondary) {
    content += `\n[secondary]\nsurface=${scenario.launchConfig.secondary.surface}\npolicy=${scenario.launchConfig.secondary.policy}\n`;
  }

  return content;
}

function buildPreferencesFile() {
  return `[window]\nmain-mode=${scenario.preferences.mainWindowMode}\nsettings-mode=${scenario.preferences.settingsWindowMode}\n\n[surface]\nsettings-presentation=${scenario.preferences.settingsPresentation}\n`;
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

async function waitForMarkers() {
  const deadline = Date.now() + 25_000;

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
        throw new Error(`Windows release smoke failed: found '${marker}'`);
      }
    }

    if (successMarkers.every(marker => logContents.includes(marker))) {
      await assertBundledPolicyRegistry(logContents);
      await scenario.verifyLog?.(logContents);
      const tail = logContents.split(/\r?\n/).slice(-120).join('\n');
      console.log('[smoke] success log tail:');
      console.log(tail);
      return;
    }
  }

  if (await fileExists(logPath)) {
    const logContents = await readFile(logPath, 'utf8');
    const tail = logContents.split(/\r?\n/).slice(-180).join('\n');
    console.log('[smoke] timeout log tail:');
    console.log(tail);
  }

  throw new Error(`Windows release smoke timed out before all success markers appeared for scenario '${scenarioName}'.`);
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
  log(`repoRoot=${repoRoot}`);
  log(`frontendRoot=${frontendRoot}`);
  log(`hostRoot=${hostRoot}`);
  log(`hostBundleRoot=${hostBundleRoot}`);
  log(`portableReleaseRoot=${portableReleaseRoot}`);
  log(`portableExePath=${portableExePath}`);
  log(`logPath=${logPath}`);
  log(`launchConfigPath=${launchConfigPath}`);
  log(`preferencesPath=${preferencesPath}`);
  log(`cliPath=${cliPath}`);
  log(`scenario=${scenarioName}`);
  log(`scenarioDescription=${scenario.description}`);
  log(`launchMode=${launchMode}`);
  log(`skipPrepare=${skipPrepare}`);
  log(`resetSessions=${resetSessions}`);

  let runError = null;

  await stopHostProcess();
  await removeIfPresent(logPath);
  await removeIfPresent(launchConfigPath);
  await removeIfPresent(preferencesPath);
  if (resetSessions || !preserveState) {
    await removeIfPresent(sessionsPath);
  }

  try {
    await mkdir(tempRoot, {recursive: true});
    await writeFile(preferencesPath, buildPreferencesFile(), 'utf8');

    if (skipPrepare) {
      log('reusing prepared frontend bundle and packaged app');
    } else {
      await preparePackagedApp();
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

    await waitForMarkers();
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
  }

  if (runError) {
    throw runError;
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});










