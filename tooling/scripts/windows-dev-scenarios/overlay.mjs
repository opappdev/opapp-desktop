export function createOverlayDevScenarios({
  assertLogContainsRegex,
  assertLogDoesNotContain,
}) {
  return [
    {
      name: 'main-window-overlay',
      description:
        'Metro-backed Windows host launches companion.overlay-probe with the overlay main-window policy',
      smokeMarkers: [
        'Runtime=Metro',
        'LaunchSurface surface=companion.overlay-probe policy=overlay mode=',
        '[frontend-companion] render bundle=opapp.companion.main window=window.main surface=companion.overlay-probe policy=overlay',
        '[frontend-companion] mounted bundle=opapp.companion.main window=window.main surface=companion.overlay-probe policy=overlay',
      ],
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
      async verifyLog(logContents) {
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
      successSummary:
        'Metro-backed Windows host launched the overlay probe with the overlay window policy.',
    },
  ];
}
