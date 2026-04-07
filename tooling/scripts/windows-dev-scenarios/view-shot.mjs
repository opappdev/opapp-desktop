export function createViewShotDevScenarios({
  assertPngCaptureLooksOpaque,
  assertUiSavedDataUri,
  assertUiSavedPath,
  clearOptionalFile,
  createViewShotCaptureRefSpec,
  createViewShotDataUriAndScreenSpec,
  createViewShotTmpfileReleaseSpec,
  log,
  runUiScenarioWithDevFailFast,
}) {
  return [
    {
      name: 'view-shot-current-window',
      description:
        'Metro-backed auto-open view-shot lab runs captureRef/captureScreen smoke in the current window',
      allowInstalledDebugReuse: false,
      smokeMarkers: [
        'InitialOpenSurface surface=companion.view-shot policy=tool presentation=current-window',
        '[frontend-companion] auto-open bundle=opapp.companion.main window=window.main surface=companion.view-shot presentation=current-window targetBundle=opapp.companion.main',
        '[frontend-companion] render bundle=opapp.companion.main window=window.main surface=companion.view-shot policy=tool',
        '[frontend-companion] mounted bundle=opapp.companion.main window=window.main surface=companion.view-shot policy=tool',
        '[frontend-companion] session bundle=opapp.companion.main window=window.main tabs=1 active=tab:companion.main:1 entries=tab:companion.main:1:companion.view-shot',
        '[frontend-view-shot] dev-smoke-start',
        '[frontend-view-shot] dev-smoke-capture-ref uri=',
        '[frontend-view-shot] dev-smoke-inspection-ref uri=',
        '[frontend-view-shot] dev-smoke-component-data-uri prefix=data:image/png;base64, length=',
        '[frontend-view-shot] dev-smoke-jpg-quality low=',
        '[frontend-view-shot] dev-smoke-capture-screen uri=',
        '[frontend-view-shot] dev-smoke-release-complete',
        '[frontend-view-shot] dev-smoke-complete',
      ],
      launchConfig: {
        initialOpen: {
          surface: 'companion.view-shot',
          policy: 'tool',
          presentation: 'current-window',
        },
      },
      async buildUiSpec() {
        return await createViewShotCaptureRefSpec({});
      },
      async verifyUiResult(uiResult, _scenarioState, {hostChild} = {}) {
        const captureRefPath = assertUiSavedPath(
          uiResult?.savedValues?.captureRefPath,
          'view-shot capture-ref path',
        );

        const refStats = assertPngCaptureLooksOpaque(
          captureRefPath,
          'Windows dev verify view-shot capture-ref',
        );
        log(
          'verify-dev',
          `view-shot capture-ref OK: path=${captureRefPath} opaqueSamples=${refStats.opaqueSamples}/${refStats.sampleCount} distinctSamples=${refStats.distinctSampleCount} averageAlpha=${refStats.averageAlpha}`,
        );

        if (!hostChild) {
          throw new Error(
            'Windows dev verify failed: missing host child for view-shot tmpfile release.',
          );
        }

        const followupSpec = await createViewShotDataUriAndScreenSpec({});
        const followupResult = await runUiScenarioWithDevFailFast({
          scenario: {name: 'view-shot-current-window-followup'},
          uiSpec: followupSpec,
          hostChild,
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
          'Windows dev verify view-shot capture-screen',
        );
        log(
          'verify-dev',
          `view-shot capture-screen OK: path=${captureScreenPath} opaqueSamples=${screenStats.opaqueSamples}/${screenStats.sampleCount} distinctSamples=${screenStats.distinctSampleCount} averageAlpha=${screenStats.averageAlpha}`,
        );

        const releaseSpec = await createViewShotTmpfileReleaseSpec({});
        await runUiScenarioWithDevFailFast({
          scenario: {name: 'view-shot-current-window-release'},
          uiSpec: releaseSpec,
          hostChild,
        });

        await clearOptionalFile(captureRefPath);
        await clearOptionalFile(captureScreenPath);
      },
      successSummary:
        'Metro-backed Windows host completed view-shot dev smoke.',
    },
  ];
}
