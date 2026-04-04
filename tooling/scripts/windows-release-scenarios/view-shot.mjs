export function createViewShotReleaseScenarios({
  assertPersistedSessionHasSurfaceId,
  assertPngCaptureLooksOpaque,
  assertUiSavedDataUri,
  assertUiSavedPath,
  commonSuccessMarkers,
  createViewShotCaptureRefSpec,
  createViewShotDataUriAndScreenSpec,
  createViewShotTmpfileReleaseSpec,
  defaultPreferences,
  log,
  rm,
  runUiScenarioWithReleaseFailFast,
}) {
  return {
    'view-shot-current-window': {
      description:
        'auto-open view-shot lab in the current window and run screenshot smoke',
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
      async buildUiSpec() {
        return await createViewShotCaptureRefSpec({});
      },
      async verifyUiResult(uiResult) {
        const captureRefPath = assertUiSavedPath(
          uiResult?.savedValues?.captureRefPath,
          'view-shot capture-ref path',
        );

        const refStats = assertPngCaptureLooksOpaque(
          captureRefPath,
          'Windows release smoke view-shot capture-ref',
        );
        log(
          `view-shot capture-ref OK: path=${captureRefPath} opaqueSamples=${refStats.opaqueSamples}/${refStats.sampleCount} distinctSamples=${refStats.distinctSampleCount} averageAlpha=${refStats.averageAlpha}`,
        );

        const followupSpec = await createViewShotDataUriAndScreenSpec({});
        const followupResult = await runUiScenarioWithReleaseFailFast({
          uiSpec: followupSpec,
        });
        const captureScreenPath = assertUiSavedPath(
          followupResult?.savedValues?.captureScreenPath,
          'view-shot capture-screen path',
        );
        assertUiSavedDataUri(
          followupResult?.savedValues?.componentDataUri,
          'view-shot component data-uri',
        );
        const screenStats = assertPngCaptureLooksOpaque(
          captureScreenPath,
          'Windows release smoke view-shot capture-screen',
        );
        log(
          `view-shot capture-screen OK: path=${captureScreenPath} opaqueSamples=${screenStats.opaqueSamples}/${screenStats.sampleCount} distinctSamples=${screenStats.distinctSampleCount} averageAlpha=${screenStats.averageAlpha}`,
        );

        const releaseSpec = await createViewShotTmpfileReleaseSpec({});
        await runUiScenarioWithReleaseFailFast({uiSpec: releaseSpec});

        await rm(captureRefPath, {force: true});
        await rm(captureScreenPath, {force: true});
      },
      verifyPersistedSession(sessionFile) {
        if (!sessionFile.includes('[session]') || !sessionFile.includes('window.main=')) {
          throw new Error(
            'Windows release smoke failed: main window session was not persisted during view-shot smoke.',
          );
        }

        assertPersistedSessionHasSurfaceId(
          sessionFile,
          'window.main',
          'companion.view-shot',
          'view-shot smoke did not persist the view-shot lab surface in the main window session.',
        );
      },
    },
  };
}
