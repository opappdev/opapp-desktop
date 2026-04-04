export function createWindowCaptureReleaseScenarios({
  assertPersistedSessionHasSurfaceId,
  assertPngCaptureLooksOpaque,
  assertUiSavedPath,
  commonSuccessMarkers,
  createWindowCaptureLabSpec,
  defaultPreferences,
  log,
  rm,
}) {
  return {
    'window-capture-current-window': {
      description:
        'auto-open window-capture lab in the current window and run foreground WGC smoke',
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
      async buildUiSpec() {
        return await createWindowCaptureLabSpec({});
      },
      async verifyUiResult(uiResult) {
        const captureWindowPath = assertUiSavedPath(
          uiResult?.savedValues?.captureWindowPath,
          'window-capture window path',
        );
        const captureClientPath = assertUiSavedPath(
          uiResult?.savedValues?.captureClientPath,
          'window-capture client path',
        );

        const windowStats = assertPngCaptureLooksOpaque(
          captureWindowPath,
          'Windows release smoke window-capture window capture',
        );
        log(
          `window-capture window OK: path=${captureWindowPath} opaqueSamples=${windowStats.opaqueSamples}/${windowStats.sampleCount} distinctSamples=${windowStats.distinctSampleCount} averageAlpha=${windowStats.averageAlpha}`,
        );
        const clientStats = assertPngCaptureLooksOpaque(
          captureClientPath,
          'Windows release smoke window-capture client capture',
        );
        log(
          `window-capture client OK: path=${captureClientPath} opaqueSamples=${clientStats.opaqueSamples}/${clientStats.sampleCount} distinctSamples=${clientStats.distinctSampleCount} averageAlpha=${clientStats.averageAlpha}`,
        );

        await rm(captureWindowPath, {force: true});
        await rm(captureClientPath, {force: true});
      },
      verifyPersistedSession(sessionFile) {
        if (!sessionFile.includes('[session]') || !sessionFile.includes('window.main=')) {
          throw new Error(
            'Windows release smoke failed: main window session was not persisted during window-capture smoke.',
          );
        }

        assertPersistedSessionHasSurfaceId(
          sessionFile,
          'window.main',
          'companion.window-capture',
          'window-capture smoke did not persist the window-capture lab surface in the main window session.',
        );
      },
    },
  };
}
