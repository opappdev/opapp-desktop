export function createWindowCaptureDevScenarios({
  assertPngCaptureLooksOpaque,
  assertUiSavedPath,
  clearOptionalFile,
  createWindowCaptureLabSpec,
  log,
}) {
  return [
    {
      name: 'window-capture-current-window',
      description:
        'Metro-backed auto-open window-capture lab runs foreground WGC smoke in the current window',
      smokeMarkers: [
        'InitialOpenSurface surface=companion.window-capture policy=tool presentation=current-window',
        '[frontend-companion] auto-open bundle=opapp.companion.main window=window.main surface=companion.window-capture presentation=current-window targetBundle=opapp.companion.main',
        '[frontend-companion] render bundle=opapp.companion.main window=window.main surface=companion.window-capture policy=tool',
        '[frontend-companion] mounted bundle=opapp.companion.main window=window.main surface=companion.window-capture policy=tool',
        '[frontend-companion] session bundle=opapp.companion.main window=window.main tabs=1 active=tab:companion.main:1 entries=tab:companion.main:1:companion.window-capture',
        '[frontend-window-capture] dev-smoke-start',
        '[frontend-window-capture] dev-smoke-list count=',
        '[frontend-window-capture] dev-smoke-capture-window backend=wgc size=',
        '[frontend-window-capture] dev-smoke-capture-client backend=wgc crop=',
        '[frontend-window-capture] dev-smoke-complete',
      ],
      launchConfig: {
        initialOpen: {
          surface: 'companion.window-capture',
          policy: 'tool',
          presentation: 'current-window',
        },
      },
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
          'Windows dev verify window-capture window capture',
        );
        log(
          'verify-dev',
          `window-capture window OK: path=${captureWindowPath} opaqueSamples=${windowStats.opaqueSamples}/${windowStats.sampleCount} distinctSamples=${windowStats.distinctSampleCount} averageAlpha=${windowStats.averageAlpha}`,
        );
        const clientStats = assertPngCaptureLooksOpaque(
          captureClientPath,
          'Windows dev verify window-capture client capture',
        );
        log(
          'verify-dev',
          `window-capture client OK: path=${captureClientPath} opaqueSamples=${clientStats.opaqueSamples}/${clientStats.sampleCount} distinctSamples=${clientStats.distinctSampleCount} averageAlpha=${clientStats.averageAlpha}`,
        );

        await clearOptionalFile(captureWindowPath);
        await clearOptionalFile(captureClientPath);
      },
      successSummary:
        'Metro-backed Windows host completed window-capture dev smoke.',
    },
  ];
}
