export function createOverlayReleaseScenarios({
  assertLogContainsRegex,
  assertLogDoesNotContain,
  assertPersistedSessionHasSurfaceId,
  defaultPreferences,
}) {
  return {
    'main-window-overlay': {
      description:
        'launch companion.overlay-probe with the overlay main-window policy in the packaged Windows host',
      preferences: defaultPreferences,
      launchConfig: {
        main: {
          surface: 'companion.overlay-probe',
          policy: 'overlay',
        },
        initialOpen: {
          surface: 'companion.overlay-probe',
          policy: 'overlay',
          presentation: 'current-window',
        },
      },
      successMarkers: [
        'LaunchSurface surface=companion.overlay-probe policy=overlay mode=',
        'InstanceLoaded failed=false',
        'NativeLogger[1] Running "OpappWindowsHost"',
        '[frontend-companion] render window=window.main surface=companion.overlay-probe policy=overlay',
        '[frontend-companion] mounted window=window.main surface=companion.overlay-probe policy=overlay',
        'BundleManifestSource=manifest',
      ],
      verifyLog(logContents) {
        assertLogContainsRegex(
          logContents,
          /AppWindowTitleBarThemeApplied context=main-window-initial mode=overlay$/im,
          'overlay main-window smoke did not apply the overlay title-bar theme.',
        );
        assertLogDoesNotContain(
          logContents,
          'AppWindowTitleBarThemeApplied context=main-window-initial mode=overlay-fallback',
          'overlay main-window smoke fell back instead of applying the real overlay title-bar theme.',
        );
        assertLogDoesNotContain(
          logContents,
          'AppWindowTitleBarThemeApplied context=main-window-initial mode=custom',
          'overlay main-window smoke still applied the custom title-bar theme.',
        );
        assertLogDoesNotContain(
          logContents,
          'AppWindowTitleBarThemeApplied context=main-window-initial mode=native',
          'overlay main-window smoke still applied the native title-bar theme.',
        );
        assertLogDoesNotContain(
          logContents,
          '[frontend-companion] startup-target-auto-open',
          'overlay main-window smoke unexpectedly fell back to the saved startup target.',
        );
      },
      verifyPersistedSession(sessionFile) {
        assertPersistedSessionHasSurfaceId(
          sessionFile,
          'window.main',
          'companion.overlay-probe',
          'overlay main-window smoke did not persist the overlay probe surface in the main window session.',
        );
      },
    },
  };
}
