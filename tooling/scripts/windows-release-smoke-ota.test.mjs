import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertLauncherRemoteCatalogDiagnostics,
  extractFrontendDiagnosticEvents,
  resolveExpectedOtaLatestVersion,
  validateOtaLastRunRecord,
} from './windows-release-smoke.mjs';

async function loadOptionalCreatePrivateSmokeScenarios() {
  try {
    const privateScenarioModule = await import(
      './.private-companion/windows-private-scenarios.mjs'
    );
    return privateScenarioModule.createPrivateSmokeScenarios ?? null;
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ERR_MODULE_NOT_FOUND' &&
      String(error.message ?? '').includes('/.private-companion/windows-private-scenarios.mjs')
    ) {
      return null;
    }

    throw error;
  }
}

const createPrivateSmokeScenarios = await loadOptionalCreatePrivateSmokeScenarios();
const hasPrivateSmokeScenarios = typeof createPrivateSmokeScenarios === 'function';

function createBaseLastRun(overrides = {}) {
  return {
    mode: 'update',
    remoteBase: 'https://r2.opapp.dev',
    bundleId: 'opapp.companion.main',
    channel: 'stable',
    hasUpdate: true,
    deviceId: 'device-123',
    inRollout: true,
    rolloutPercent: 50,
    status: 'updated',
    currentVersion: '0.9.0',
    latestVersion: '1.0.0',
    version: '1.0.0',
    previousVersion: '0.9.0',
    stagedAt: '2026-03-29T01:23:45.000Z',
    ...overrides,
  };
}

function createFailedLastRun(overrides = {}) {
  return createBaseLastRun({
    status: 'failed',
    version: undefined,
    previousVersion: undefined,
    stagedAt: undefined,
    ...overrides,
  });
}

function createPrivateStartupTargetScenario() {
  const privateScenarios = createPrivateSmokeScenarios({
    assertPersistedSessionContains() {},
    assertPersistedSessionHasSurfaceId() {},
    assertPersistedSessionLacksSurfaceId() {},
    assertRectMatchesPolicy: async () => {},
    buildPersistedSessionFile: () => '',
    commonSuccessMarkers: [],
    companionStartupTargetPath: 'C:\\temp\\companion-startup-target.json',
    defaultPreferences: {},
    fileExists: async () => false,
    normalizeLogContents: value => value.replace(/\r/g, ''),
    preferencesPath: 'C:\\temp\\preferences.ini',
    readFile: async () => '',
    sessionsPath: 'C:\\temp\\sessions.ini',
    writeFile: async () => {},
  });

  return privateScenarios['startup-target-private-bundle'];
}

function createLauncherDiagnosticLog() {
  return [
    '[2026-03-30 08:00:00.000] NativeLogger[1] [frontend-diagnostics] {"ts":"2026-03-30T00:00:00.000Z","level":"info","category":"interaction","event":"bundle-launcher.remote-catalog.summary","platform":"windows","status":"ready","remoteUrl":"http://127.0.0.1:4100","remoteEntryCount":3,"entryCount":4,"stagedBundleCount":3,"stagedBundlesLoaded":true,"startupTargetLoaded":true}',
    '[2026-03-30 08:00:00.001] NativeLogger[1] [frontend-diagnostics] {"ts":"2026-03-30T00:00:00.001Z","level":"info","category":"interaction","event":"bundle-launcher.remote-catalog.entry","platform":"windows","bundleId":"opapp.companion.main","discoverySource":"remote-catalog","localState":"bundled","localVersion":null,"localProvenanceKind":null,"versionMismatch":false}',
    '[2026-03-30 08:00:00.002] NativeLogger[1] [frontend-diagnostics] {"ts":"2026-03-30T00:00:00.002Z","level":"info","category":"interaction","event":"bundle-launcher.remote-catalog.entry","platform":"windows","bundleId":"opapp.hbr.workspace","discoverySource":"remote-catalog","localState":"staged","latestVersion":"0.9.2","localVersion":"0.9.2","localSourceKind":"sibling-staging","localProvenanceKind":"native-ota-applied","localProvenanceStatus":"updated","versionMismatch":false}',
    '[2026-03-30 08:00:00.003] NativeLogger[1] [frontend-diagnostics] {"ts":"2026-03-30T00:00:00.003Z","level":"info","category":"interaction","event":"bundle-launcher.remote-catalog.entry","platform":"windows","bundleId":"opapp.hbr.archive","discoverySource":"remote-catalog","localState":"staged","latestVersion":"0.9.0","localVersion":"0.8.0","localSourceKind":"local-build","localProvenanceKind":"host-staged-only","localProvenanceStatus":null,"versionMismatch":true}',
    '[2026-03-30 08:00:00.004] NativeLogger[1] [frontend-diagnostics] {"ts":"2026-03-30T00:00:00.004Z","level":"info","category":"interaction","event":"bundle-launcher.remote-catalog.entry","platform":"windows","bundleId":"opapp.private.shadow","discoverySource":"local-only","localState":"staged","latestVersion":null,"localVersion":"0.1.0","localSourceKind":"local-build","localProvenanceKind":"host-staged-only","localProvenanceStatus":null,"versionMismatch":false}',
  ].join('\n');
}

test('validateOtaLastRunRecord accepts updated runs with a staged version', () => {
  const result = validateOtaLastRunRecord({
    otaLastRun: createBaseLastRun(),
    otaRemoteBase: 'https://r2.opapp.dev',
    loggedCurrentVersion: '0.9.0',
    expectedLatestVersion: '1.0.0',
  });

  assert.deepEqual(result, {requiresOtaState: true, status: 'updated'});
});

test('validateOtaLastRunRecord accepts remote channels when last-run preserves them verbatim', () => {
  const result = validateOtaLastRunRecord({
    otaLastRun: createBaseLastRun({
      channels: {
        stable: '0.9.0',
        beta: '1.0.0',
      },
    }),
    otaRemoteBase: 'https://r2.opapp.dev',
    loggedCurrentVersion: '0.9.0',
    expectedChannels: {
      beta: '1.0.0',
      stable: '0.9.0',
    },
  });

  assert.deepEqual(result, {requiresOtaState: true, status: 'updated'});
});

test('validateOtaLastRunRecord accepts up-to-date runs without a staged version', () => {
  const result = validateOtaLastRunRecord({
    otaLastRun: createBaseLastRun({
      status: 'up-to-date',
      hasUpdate: false,
      inRollout: false,
      version: undefined,
      previousVersion: undefined,
      stagedAt: undefined,
    }),
    otaRemoteBase: 'https://r2.opapp.dev',
    loggedCurrentVersion: '0.9.0',
  });

  assert.deepEqual(result, {requiresOtaState: false, status: 'up-to-date'});
});

test('validateOtaLastRunRecord accepts explicit updated status expectations', () => {
  const result = validateOtaLastRunRecord({
    otaLastRun: createBaseLastRun(),
    otaRemoteBase: 'https://r2.opapp.dev',
    loggedCurrentVersion: '0.9.0',
    expectedStatus: 'updated',
  });

  assert.deepEqual(result, {requiresOtaState: true, status: 'updated'});
});

test('validateOtaLastRunRecord accepts explicit up-to-date status expectations', () => {
  const result = validateOtaLastRunRecord({
    otaLastRun: createBaseLastRun({
      status: 'up-to-date',
      hasUpdate: false,
      inRollout: false,
      version: undefined,
      previousVersion: undefined,
      stagedAt: undefined,
    }),
    otaRemoteBase: 'https://r2.opapp.dev',
    loggedCurrentVersion: '0.9.0',
    expectedStatus: 'up-to-date',
  });

  assert.deepEqual(result, {requiresOtaState: false, status: 'up-to-date'});
});

test('validateOtaLastRunRecord accepts failed runs with preserved remote metadata', () => {
  const result = validateOtaLastRunRecord({
    otaLastRun: createFailedLastRun({
      channels: {
        stable: '0.9.0',
        beta: '1.0.0',
      },
    }),
    otaRemoteBase: 'https://r2.opapp.dev',
    loggedCurrentVersion: '0.9.0',
    expectedChannels: {
      beta: '1.0.0',
      stable: '0.9.0',
    },
    expectedLatestVersion: '1.0.0',
    expectedStatus: 'failed',
  });

  assert.deepEqual(result, {requiresOtaState: false, status: 'failed'});
});

test('validateOtaLastRunRecord accepts failed runs before bundle metadata is resolved', () => {
  const result = validateOtaLastRunRecord({
    otaLastRun: createFailedLastRun({
      bundleId: undefined,
      latestVersion: undefined,
      deviceId: undefined,
      hasUpdate: undefined,
      inRollout: undefined,
      rolloutPercent: undefined,
      channels: undefined,
    }),
    otaRemoteBase: 'https://r2.opapp.dev',
    loggedCurrentVersion: '0.9.0',
    expectedStatus: 'failed',
  });

  assert.deepEqual(result, {requiresOtaState: false, status: 'failed'});
});

test('resolveExpectedOtaLatestVersion prefers channel pins, then stable fallback, then versions[]', () => {
  assert.equal(
    resolveExpectedOtaLatestVersion({
      bundleInfo: {
        versions: ['0.9.0', '1.0.0'],
        latestVersion: '1.0.0',
        channels: {
          stable: '0.9.0',
          beta: '1.0.0',
        },
      },
      channel: 'beta',
    }),
    '1.0.0',
  );

  assert.equal(
    resolveExpectedOtaLatestVersion({
      bundleInfo: {
        versions: ['0.9.0', '1.0.0'],
        latestVersion: '1.0.0',
        channels: {
          stable: '0.9.0',
          nightly: '9.9.9',
        },
      },
      channel: 'nightly',
    }),
    '0.9.0',
  );

  assert.equal(
    resolveExpectedOtaLatestVersion({
      bundleInfo: {
        versions: ['0.9.0', '1.0.0'],
        latestVersion: '1.0.0',
      },
      channel: 'stable',
    }),
    '1.0.0',
  );
});

test('extractFrontendDiagnosticEvents collects launcher remote catalog diagnostics', () => {
  const events = extractFrontendDiagnosticEvents(
    createLauncherDiagnosticLog(),
    'bundle-launcher.remote-catalog.entry',
  );

  assert.equal(events.length, 4);
  assert.equal(events[1]?.bundleId, 'opapp.hbr.workspace');
});

test('assertLauncherRemoteCatalogDiagnostics accepts matching launcher provenance snapshots', () => {
  assert.doesNotThrow(() =>
    assertLauncherRemoteCatalogDiagnostics(createLauncherDiagnosticLog(), {
      summary: {
        status: 'ready',
        remoteUrl: 'http://127.0.0.1:4100',
        remoteEntryCount: 3,
        entryCount: 4,
        stagedBundleCount: 3,
        stagedBundlesLoaded: true,
        startupTargetLoaded: true,
      },
      entries: [
        {
          bundleId: 'opapp.hbr.workspace',
          discoverySource: 'remote-catalog',
          localState: 'staged',
          latestVersion: '0.9.2',
          localVersion: '0.9.2',
          localProvenanceKind: 'native-ota-applied',
          localProvenanceStatus: 'updated',
          versionMismatch: false,
        },
        {
          bundleId: 'opapp.private.shadow',
          discoverySource: 'local-only',
          localState: 'staged',
          latestVersion: null,
          localVersion: '0.1.0',
          localProvenanceKind: 'host-staged-only',
          localProvenanceStatus: null,
          versionMismatch: false,
        },
      ],
    }),
  );
});

test('assertLauncherRemoteCatalogDiagnostics rejects missing launcher entries', () => {
  assert.throws(
    () =>
      assertLauncherRemoteCatalogDiagnostics(createLauncherDiagnosticLog(), {
        summary: {
          status: 'ready',
          remoteUrl: 'http://127.0.0.1:4100',
          remoteEntryCount: 3,
          entryCount: 4,
          stagedBundleCount: 3,
          stagedBundlesLoaded: true,
          startupTargetLoaded: true,
        },
        entries: [
          {
            bundleId: 'opapp.unknown.bundle',
          },
        ],
      }),
    /missing entry 'opapp\.unknown\.bundle'/,
  );
});

test('validateOtaLastRunRecord rejects explicit updated status expectations when no update was applied', () => {
  assert.throws(
    () =>
      validateOtaLastRunRecord({
        otaLastRun: createBaseLastRun({
          status: 'up-to-date',
          hasUpdate: false,
          inRollout: false,
          version: undefined,
          previousVersion: undefined,
          stagedAt: undefined,
        }),
        otaRemoteBase: 'https://r2.opapp.dev',
        loggedCurrentVersion: '0.9.0',
        expectedStatus: 'updated',
      }),
    /expected 'updated'/,
  );
});

test('validateOtaLastRunRecord rejects runs that drop remote channels metadata', () => {
  assert.throws(
    () =>
      validateOtaLastRunRecord({
        otaLastRun: createBaseLastRun(),
        otaRemoteBase: 'https://r2.opapp.dev',
        loggedCurrentVersion: '0.9.0',
        expectedChannels: {
          stable: '0.9.0',
          beta: '1.0.0',
        },
      }),
    /missing the remote channels map/,
  );
});

test('validateOtaLastRunRecord rejects failed runs that keep staged metadata', () => {
  for (const field of ['version', 'previousVersion', 'stagedAt']) {
    assert.throws(
      () =>
        validateOtaLastRunRecord({
          otaLastRun: createFailedLastRun({
            [field]: 'unexpected',
          }),
          otaRemoteBase: 'https://r2.opapp.dev',
          loggedCurrentVersion: '0.9.0',
          expectedStatus: 'failed',
        }),
      /must not report staged/,
      `failed run should not keep ${field}`,
    );
  }
});

test('validateOtaLastRunRecord rejects failed runs that drop the resolved channel', () => {
  assert.throws(
    () =>
      validateOtaLastRunRecord({
        otaLastRun: createFailedLastRun({
          channel: undefined,
        }),
        otaRemoteBase: 'https://r2.opapp.dev',
        loggedCurrentVersion: '0.9.0',
        expectedStatus: 'failed',
      }),
    /missing the resolved channel/,
  );
});

test('validateOtaLastRunRecord rejects failed runs that drop currentVersion after the host logged it', () => {
  assert.throws(
    () =>
      validateOtaLastRunRecord({
        otaLastRun: createFailedLastRun({
          currentVersion: undefined,
        }),
        otaRemoteBase: 'https://r2.opapp.dev',
        loggedCurrentVersion: '0.9.0',
        expectedStatus: 'failed',
      }),
    /missing currentVersion even though the host logged it/,
  );
});

test('validateOtaLastRunRecord rejects failed runs that drop bundleId after remote resolution', () => {
  assert.throws(
    () =>
      validateOtaLastRunRecord({
        otaLastRun: createFailedLastRun({
          bundleId: undefined,
        }),
        otaRemoteBase: 'https://r2.opapp.dev',
        loggedCurrentVersion: '0.9.0',
        expectedLatestVersion: '1.0.0',
        expectedStatus: 'failed',
      }),
    /missing the resolved bundleId after remote resolution/,
  );
});

test('validateOtaLastRunRecord rejects failed runs that drop resolved latestVersion after remote resolution', () => {
  assert.throws(
    () =>
      validateOtaLastRunRecord({
        otaLastRun: createFailedLastRun({
          latestVersion: undefined,
        }),
        otaRemoteBase: 'https://r2.opapp.dev',
        loggedCurrentVersion: '0.9.0',
        expectedLatestVersion: '1.0.0',
        expectedStatus: 'failed',
      }),
    /missing the resolved latestVersion after remote resolution/,
  );
});

test('validateOtaLastRunRecord rejects failed runs that drop resolved remote channels metadata', () => {
  assert.throws(
    () =>
      validateOtaLastRunRecord({
        otaLastRun: createFailedLastRun(),
        otaRemoteBase: 'https://r2.opapp.dev',
        loggedCurrentVersion: '0.9.0',
        expectedChannels: {
          stable: '0.9.0',
          beta: '1.0.0',
        },
        expectedStatus: 'failed',
      }),
    /failed ota last-run is missing the remote channels map/,
  );
});

test('validateOtaLastRunRecord rejects runs with mismatched remote channels metadata', () => {
  assert.throws(
    () =>
      validateOtaLastRunRecord({
        otaLastRun: createBaseLastRun({
          channels: {
            stable: '0.9.0',
            beta: '1.1.0',
          },
        }),
        otaRemoteBase: 'https://r2.opapp.dev',
        loggedCurrentVersion: '0.9.0',
        expectedChannels: {
          stable: '0.9.0',
          beta: '1.0.0',
        },
      }),
    /did not match remote index channels/,
  );
});

test('validateOtaLastRunRecord rejects runs with mismatched resolved latestVersion', () => {
  assert.throws(
    () =>
      validateOtaLastRunRecord({
        otaLastRun: createBaseLastRun({
          latestVersion: '1.1.0',
        }),
        otaRemoteBase: 'https://r2.opapp.dev',
        loggedCurrentVersion: '0.9.0',
        expectedLatestVersion: '1.0.0',
      }),
    /did not match the remote index resolved version/,
  );
});

test('validateOtaLastRunRecord rejects up-to-date runs that claim a staged version', () => {
  assert.throws(
    () =>
      validateOtaLastRunRecord({
        otaLastRun: createBaseLastRun({
          status: 'up-to-date',
          version: '1.0.0',
        }),
        otaRemoteBase: 'https://r2.opapp.dev',
        loggedCurrentVersion: '0.9.0',
      }),
    /no update was applied/,
  );
});

test('validateOtaLastRunRecord rejects up-to-date runs that claim staging metadata', () => {
  for (const field of ['previousVersion', 'stagedAt']) {
    assert.throws(
      () =>
        validateOtaLastRunRecord({
          otaLastRun: createBaseLastRun({
            status: 'up-to-date',
            version: undefined,
            [field]: 'unexpected',
          }),
          otaRemoteBase: 'https://r2.opapp.dev',
          loggedCurrentVersion: '0.9.0',
        }),
      /no update was applied/,
      `up-to-date run should not keep ${field}`,
    );
  }
});

test('validateOtaLastRunRecord rejects updated runs without a staged version', () => {
  assert.throws(
    () =>
      validateOtaLastRunRecord({
        otaLastRun: createBaseLastRun({
          version: null,
        }),
        otaRemoteBase: 'https://r2.opapp.dev',
        loggedCurrentVersion: '0.9.0',
      }),
    /missing the staged version/,
  );
});

test('validateOtaLastRunRecord rejects updated runs without stagedAt', () => {
  assert.throws(
    () =>
      validateOtaLastRunRecord({
        otaLastRun: createBaseLastRun({
          stagedAt: null,
        }),
        otaRemoteBase: 'https://r2.opapp.dev',
        loggedCurrentVersion: '0.9.0',
      }),
    /missing stagedAt/,
  );
});

test('validateOtaLastRunRecord rejects runs with inconsistent hasUpdate flags', () => {
  assert.throws(
    () =>
      validateOtaLastRunRecord({
        otaLastRun: createBaseLastRun({
          status: 'up-to-date',
          hasUpdate: true,
          version: undefined,
          previousVersion: undefined,
          stagedAt: undefined,
        }),
        otaRemoteBase: 'https://r2.opapp.dev',
        loggedCurrentVersion: '0.9.0',
      }),
    /hasUpdate=true even though no update was applied/,
  );

  assert.throws(
    () =>
      validateOtaLastRunRecord({
        otaLastRun: createBaseLastRun({
          hasUpdate: false,
        }),
        otaRemoteBase: 'https://r2.opapp.dev',
        loggedCurrentVersion: '0.9.0',
      }),
    /hasUpdate=false even though an update was applied/,
  );
});

test('validateOtaLastRunRecord rejects successful runs with missing resolved OTA metadata', () => {
  for (const [field, message] of [
    ['mode', /expected 'update'/],
    ['bundleId', /resolved bundleId/],
    ['channel', /resolved channel/],
    ['latestVersion', /resolved latestVersion/],
    ['hasUpdate', /boolean hasUpdate/],
  ]) {
    assert.throws(
      () =>
        validateOtaLastRunRecord({
          otaLastRun: createBaseLastRun({
            [field]: undefined,
          }),
          otaRemoteBase: 'https://r2.opapp.dev',
          loggedCurrentVersion: '0.9.0',
        }),
      message,
      `missing ${field} should fail validation`,
    );
  }
});

test(
  'private startup target smoke rejects OTA runs that still stage the main bundle',
  {skip: !hasPrivateSmokeScenarios},
  async () => {
  const scenario = createPrivateStartupTargetScenario();
  const logContents = [
    '[2026-03-29 16:15:29.795] NativeLogger[1] [frontend-companion] startup-target-auto-open bundle=opapp.companion.main window=window.main surface=hbr.challenge-advisor presentation=current-window targetBundle=opapp.hbr.workspace',
    '[2026-03-29 16:15:29.798] BundleSwitchPrepared window=window.main bundle=opapp.hbr.workspace surface=hbr.challenge-advisor policy=main root=D:\\code\\opappdev\\opapp-desktop\\hosts\\windows-host\\windows\\OpappWindowsHost.Package\\bin\\x64\\Release\\AppX\\OpappWindowsHost\\Bundle\\bundles\\opapp.hbr.workspace file=index.private.windows',
    '[2026-03-29 16:15:29.656] OTA.SpawnUpdateProcess remoteUrl=https://r2.opapp.dev hostBundleDir=D:\\code\\opappdev\\opapp-desktop\\hosts\\windows-host\\windows\\OpappWindowsHost.Package\\bin\\x64\\Release\\AppX\\OpappWindowsHost\\Bundle currentVersion=0.1.2 channel=nightly force=true',
    '[2026-03-29 16:15:30.220] OTA.Native.DownloadManifest.OK url=https://r2.opapp.dev/opapp.companion.main/0.1.2/windows/bundle-manifest.json target=D:\\code\\opappdev\\opapp-desktop\\.ota-cache\\opapp.companion.main\\0.1.2\\windows\\bundle-manifest.json',
  ].join('\n');

  await assert.rejects(
    scenario.verifyLog(logContents),
    /did not target OTA staging at the private bundle root/,
  );
});

test(
  'private startup target smoke accepts OTA runs that stage the private bundle',
  {skip: !hasPrivateSmokeScenarios},
  async () => {
  const scenario = createPrivateStartupTargetScenario();
  const logContents = [
    '[2026-03-29 16:15:29.795] NativeLogger[1] [frontend-companion] startup-target-auto-open bundle=opapp.companion.main window=window.main surface=hbr.challenge-advisor presentation=current-window targetBundle=opapp.hbr.workspace',
    '[2026-03-29 16:15:29.798] BundleSwitchPrepared window=window.main bundle=opapp.hbr.workspace surface=hbr.challenge-advisor policy=main root=D:\\code\\opappdev\\opapp-desktop\\hosts\\windows-host\\windows\\OpappWindowsHost.Package\\bin\\x64\\Release\\AppX\\OpappWindowsHost\\Bundle\\bundles\\opapp.hbr.workspace file=index.private.windows',
    '[2026-03-29 16:15:29.656] OTA.SpawnUpdateProcess remoteUrl=https://r2.opapp.dev hostBundleDir=D:\\code\\opappdev\\opapp-desktop\\hosts\\windows-host\\windows\\OpappWindowsHost.Package\\bin\\x64\\Release\\AppX\\OpappWindowsHost\\Bundle\\bundles\\opapp.hbr.workspace currentVersion=0.1.2 channel=nightly force=true',
    '[2026-03-29 16:15:30.220] OTA.Native.DownloadManifest.OK url=https://r2.opapp.dev/opapp.hbr.workspace/0.1.2/windows/bundle-manifest.json target=D:\\code\\opappdev\\opapp-desktop\\.ota-cache\\opapp.hbr.workspace\\0.1.2\\windows\\bundle-manifest.json',
    '[2026-03-29 16:15:30.520] OTA.Native.Updated bundleId=opapp.hbr.workspace version=0.1.2',
  ].join('\n');

  await assert.doesNotReject(scenario.verifyLog(logContents));
});
