function buildSingleTabWindowSession({
  windowId,
  tabId,
  surfaceId,
  policy,
}) {
  return {
    windowId,
    activeTabId: tabId,
    tabs: [
      {
        tabId,
        surfaceId,
        policy,
      },
    ],
  };
}

function buildRestoredMainWindowSettingsSession() {
  return {
    'window.main': buildSingleTabWindowSession({
      windowId: 'window.main',
      tabId: 'tab:companion.settings:1',
      surfaceId: 'companion.settings',
      policy: 'settings',
    }),
  };
}

function buildRestoredMainWindowLauncherSession() {
  return {
    'window.main': buildSingleTabWindowSession({
      windowId: 'window.main',
      tabId: 'tab:companion.main:1',
      surfaceId: 'companion.main',
      policy: 'main',
    }),
  };
}

async function writePersistedSessions({
  buildPersistedSessionFile,
  sessions,
  sessionsPath,
  writeFile,
}) {
  await writeFile(sessionsPath, buildPersistedSessionFile(sessions), 'utf8');
}

export function createLauncherAndSettingsReleaseScenarios({
  assertBundleLibraryLoadDiagnostics,
  assertLogContainsRegex,
  assertPersistedSessionHasSurfaceId,
  assertPersistedSessionLacksSurfaceId,
  assertUiSavedPath,
  bootstrapCompactPreferences,
  buildPersistedSessionFile,
  commonSuccessMarkers,
  companionStartupTargetPath,
  createBundleLauncherAgentWorkbenchRoundTripSpec,
  createBundleLauncherPostSettingsPointerSwitchSpec,
  createBundleLauncherPostSettingsViewShotPointerOpenSpec,
  createBundleLauncherPostSettingsWindowCapturePointerOpenSpec,
  createBundleLauncherRootSpec,
  createBundleLauncherSettingsRoundTripSpec,
  createBundleLauncherStartupPreferenceOpenSpec,
  createMainAndDetachedSettingsSpec,
  createSaveMainWindowPreferencesSpec,
  createSettingsRootSpec,
  createSyntheticStagedBundle,
  defaultPreferences,
  fileExists,
  launcherProvenanceFixture,
  normalizeLogContents,
  otaIndexPath,
  otaLastRunPath,
  otaRemoteArg,
  otaStatePath,
  preferencesPath,
  readFile,
  removeIfPresent,
  resolveRuntimeBundleRootForLaunchMode,
  seedLauncherProvenanceCachedCatalog,
  sessionsPath,
  writeFile,
}) {
  const createLauncherCurrentWindowUiScenario = ({
    description,
    buildUiSpec,
    finalSurfaceId,
    persistedSurfaceReason,
  }) => ({
    description,
    preferences: defaultPreferences,
    launchConfig: {},
    successMarkers: [...commonSuccessMarkers],
    async buildUiSpec() {
      return await buildUiSpec();
    },
    verifyPersistedSession(sessionFile) {
      assertPersistedSessionHasSurfaceId(
        sessionFile,
        'window.main',
        finalSurfaceId,
        persistedSurfaceReason,
      );
    },
  });

  return {
    'main-window-bootstrap-compact': {
      description: 'saved main window mode is applied during startup bootstrap',
      preferences: bootstrapCompactPreferences,
      launchConfig: {},
      successMarkers: [
        ...commonSuccessMarkers,
        'LaunchSurface surface=companion.main policy=main mode=compact',
        'WindowRect=',
      ],
      async buildUiSpec() {
        return await createBundleLauncherRootSpec({mode: 'compact'});
      },
      verifyPersistedSession(sessionFile) {
        if (!sessionFile.includes('[session]') || !sessionFile.includes('window.main=')) {
          throw new Error(
            'Windows release smoke failed: main window session was not persisted during startup bootstrap.',
          );
        }

        if (!sessionFile.includes('companion.main')) {
          throw new Error(
            'Windows release smoke failed: main window session is missing the main surface after startup bootstrap.',
          );
        }
      },
      verifyPersistedPreferences(preferencesFile) {
        if (!preferencesFile.includes('main-mode=compact')) {
          throw new Error(
            'Windows release smoke failed: compact startup preference was not written to the preferences file.',
          );
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
      async buildUiSpec() {
        return await createSettingsRootSpec({mode: 'wide'});
      },
      verifyPersistedSession(sessionFile) {
        if (!sessionFile.includes('[session]') || !sessionFile.includes('window.main=')) {
          throw new Error('Windows release smoke failed: main window session was not persisted.');
        }

        if (!sessionFile.includes('companion.settings')) {
          throw new Error(
            'Windows release smoke failed: main window session is missing the settings tab.',
          );
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
      ],
      async buildUiSpec() {
        return await createSettingsRootSpec({mode: 'wide'});
      },
      verifyPersistedSession(sessionFile) {
        if (!sessionFile.includes('[session]') || !sessionFile.includes('window.main=')) {
          throw new Error(
            'Windows release smoke failed: restored main window session was not persisted.',
          );
        }

        if (!sessionFile.includes('companion.settings')) {
          throw new Error(
            'Windows release smoke failed: restored main window session is missing the settings tab.',
          );
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
        'bundle-library.load-finished',
        '"bundleId":"opapp.hbr.workspace"',
      ],
      async prepareState() {
        await writePersistedSessions({
          buildPersistedSessionFile,
          sessions: buildRestoredMainWindowSettingsSession(),
          sessionsPath,
          writeFile,
        });

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
      async buildUiSpec() {
        return await createBundleLauncherRootSpec({mode: 'wide'});
      },
      async verifyUiResult(uiResult) {
        const serviceDetail = assertUiSavedPath(
          uiResult?.savedValues?.serviceDetail,
          'bundle-launcher service detail',
        );
        const selectedBundleTitle = assertUiSavedPath(
          uiResult?.savedValues?.selectedBundleTitle,
          'bundle-launcher selected bundle title',
        );

        if (otaRemoteArg && !/^http:\/\/127\.0\.0\.1:\d+$/.test(serviceDetail)) {
          throw new Error(
            'Windows release smoke failed: launcher service detail did not render the synthetic OTA remote URL.',
          );
        }

        if (selectedBundleTitle.length < 2) {
          throw new Error(
            'Windows release smoke failed: launcher detail pane did not resolve a selected bundle title.',
          );
        }
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

          assertBundleLibraryLoadDiagnostics(logContents, {
            start: {
              supportsBundleUpdates: true,
            },
            finished: {
              remoteStatus: 'ready',
              remoteEntryCount: 3,
              stagedBundleCount: 2,
            },
          });
        }
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
      description:
        'saved launcher startup target overrides a restored main-window settings session',
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
        await writePersistedSessions({
          buildPersistedSessionFile,
          sessions: buildRestoredMainWindowSettingsSession(),
          sessionsPath,
          writeFile,
        });
      },
      async buildUiSpec() {
        return await createBundleLauncherRootSpec({mode: 'wide'});
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
        await writePersistedSessions({
          buildPersistedSessionFile,
          sessions: buildRestoredMainWindowSettingsSession(),
          sessionsPath,
          writeFile,
        });
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
      async buildUiSpec() {
        return await createBundleLauncherRootSpec({mode: 'wide'});
      },
      async verifyLog() {
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
      description:
        'saved settings startup target overrides a restored main-window launcher session',
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
        await writePersistedSessions({
          buildPersistedSessionFile,
          sessions: buildRestoredMainWindowLauncherSession(),
          sessionsPath,
          writeFile,
        });
      },
      async buildUiSpec() {
        return await createSettingsRootSpec({mode: 'wide'});
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
    'launcher-agent-workbench-current-window': createLauncherCurrentWindowUiScenario(
      {
        description:
          'packaged launcher opens Agent Workbench from the home action and returns to the launcher in the current window',
        buildUiSpec: async () =>
          await createBundleLauncherAgentWorkbenchRoundTripSpec({}),
        finalSurfaceId: 'companion.main',
        persistedSurfaceReason:
          'launcher Agent Workbench round-trip did not persist the launcher surface back into the main window session.',
      },
    ),
    'launcher-startup-preference-open-current-window':
      createLauncherCurrentWindowUiScenario({
        description:
          'packaged launcher opens the selected startup preference entry in the current window without requiring a second click',
        buildUiSpec: async () =>
          await createBundleLauncherStartupPreferenceOpenSpec({}),
        finalSurfaceId: 'companion.main',
        persistedSurfaceReason:
          'launcher startup-preference open flow did not persist the launcher surface back into the main window session after returning home.',
      }),
    'launcher-settings-round-trip-current-window':
      createLauncherCurrentWindowUiScenario({
        description:
          'packaged launcher reopens Settings from startup preferences after returning home without requiring a second click',
        buildUiSpec: async () =>
          await createBundleLauncherSettingsRoundTripSpec({}),
        finalSurfaceId: 'companion.settings',
        persistedSurfaceReason:
          'launcher settings round-trip did not persist the reopened settings surface into the main window session.',
      }),
    'launcher-post-settings-pointer-switch-current-window':
      createLauncherCurrentWindowUiScenario({
        description:
          'packaged launcher supports pointer-driven startup target switching after returning home from Settings',
        buildUiSpec: async () =>
          await createBundleLauncherPostSettingsPointerSwitchSpec({}),
        finalSurfaceId: 'companion.agent-workbench',
        persistedSurfaceReason:
          'launcher pointer-driven startup target switching did not persist the Agent Workbench surface into the main window session.',
      }),
    'launcher-post-settings-view-shot-pointer-open-current-window':
      createLauncherCurrentWindowUiScenario({
        description:
          'packaged launcher opens View Shot from startup preferences after returning home from Settings with pointer input',
        buildUiSpec: async () =>
          await createBundleLauncherPostSettingsViewShotPointerOpenSpec({}),
        finalSurfaceId: 'companion.view-shot',
        persistedSurfaceReason:
          'launcher post-settings View Shot open flow did not persist the View Shot surface into the main window session.',
      }),
    'launcher-post-settings-window-capture-pointer-open-current-window':
      createLauncherCurrentWindowUiScenario({
        description:
          'packaged launcher opens Window Capture from startup preferences after returning home from Settings with pointer input',
        buildUiSpec: async () =>
          await createBundleLauncherPostSettingsWindowCapturePointerOpenSpec(
            {},
          ),
        finalSurfaceId: 'companion.window-capture',
        persistedSurfaceReason:
          'launcher post-settings Window Capture open flow did not persist the Window Capture surface into the main window session.',
      }),
    'settings-default-current-window': {
      description:
        'saved settings preference keeps default settings entry in the current window',
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
      async buildUiSpec() {
        return await createSettingsRootSpec({mode: 'wide'});
      },
      verifyPersistedSession(sessionFile) {
        if (!sessionFile.includes('[session]') || !sessionFile.includes('window.main=')) {
          throw new Error('Windows release smoke failed: main window session was not persisted.');
        }

        if (!sessionFile.includes('companion.settings')) {
          throw new Error(
            'Windows release smoke failed: default current-window settings flow did not persist the settings surface.',
          );
        }
      },
    },
    'settings-default-new-window': {
      description:
        'saved settings preference opens the default settings entry in a detached window',
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
      async buildUiSpec() {
        return await createMainAndDetachedSettingsSpec({
          mainMode: 'wide',
          settingsMode: 'compact',
        });
      },
      verifyPersistedSession(sessionFile) {
        if (!sessionFile.includes('[session]') || !sessionFile.includes('window.main=')) {
          throw new Error('Windows release smoke failed: main window session was not persisted.');
        }

        if (!sessionFile.includes('window.secondary.dynamic.1=')) {
          throw new Error(
            'Windows release smoke failed: detached settings window session was not persisted for default new-window preference.',
          );
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
      description:
        'packaged relaunch restores the previously detached settings window session',
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
      async buildUiSpec() {
        return await createMainAndDetachedSettingsSpec({
          mainMode: 'wide',
          settingsMode: 'compact',
        });
      },
      verifyPersistedSession(sessionFile) {
        if (!sessionFile.includes('[session]') || !sessionFile.includes('window.main=')) {
          throw new Error(
            'Windows release smoke failed: main window session was not persisted during detached settings restore.',
          );
        }

        if (!sessionFile.includes('window.secondary.dynamic.1=')) {
          throw new Error(
            'Windows release smoke failed: restored detached settings window session is missing from persisted session state.',
          );
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
      description:
        'settings save applies the new main window mode immediately to the current window',
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
      async buildUiSpec() {
        return await createSaveMainWindowPreferencesSpec();
      },
      verifyPersistedSession(sessionFile) {
        if (!sessionFile.includes('[session]') || !sessionFile.includes('window.main=')) {
          throw new Error(
            'Windows release smoke failed: main window session was not persisted during save-window-preferences smoke.',
          );
        }

        if (!sessionFile.includes('companion.settings')) {
          throw new Error(
            'Windows release smoke failed: save-window-preferences flow did not persist the settings surface in the main window session.',
          );
        }
      },
      verifyPersistedPreferences(preferencesFile) {
        if (!preferencesFile.includes('main-mode=compact')) {
          throw new Error(
            'Windows release smoke failed: saving preferences did not persist compact mode for the main window.',
          );
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
      async buildUiSpec() {
        return await createMainAndDetachedSettingsSpec({
          mainMode: 'wide',
          settingsMode: 'compact',
        });
      },
      verifyPersistedSession(sessionFile) {
        if (!sessionFile.includes('[session]') || !sessionFile.includes('window.main=')) {
          throw new Error('Windows release smoke failed: main window session was not persisted.');
        }

        if (!sessionFile.includes('window.secondary.startup=')) {
          throw new Error(
            'Windows release smoke failed: detached settings window session was not persisted.',
          );
        }

        if (!sessionFile.includes('companion.settings')) {
          throw new Error(
            'Windows release smoke failed: detached settings window session is missing the settings surface.',
          );
        }
      },
    },
  };
}
