export const launcherCurrentWindowScenarioCatalog = [
  {
    name: 'launcher-agent-workbench-current-window',
    uiSpecFactoryName: 'createBundleLauncherAgentWorkbenchRoundTripSpec',
    devDescription:
      'Metro-backed launcher opens Agent Workbench from the home action button and returns to the launcher in the current window',
    packagedDescription:
      'packaged launcher opens Agent Workbench from the home action button and returns to the launcher in the current window',
    successSummary:
      'Metro-backed Windows host completed launcher -> Agent Workbench -> launcher current-window smoke.',
    finalSurfaceId: 'companion.main',
    persistedSurfaceReason:
      'launcher Agent Workbench round-trip did not persist the launcher surface back into the main window session.',
  },
  {
    name: 'launcher-startup-preference-open-current-window',
    uiSpecFactoryName: 'createBundleLauncherStartupPreferenceOpenSpec',
    devDescription:
      'Metro-backed launcher opens the selected startup preference entry in the current window without requiring a second click',
    packagedDescription:
      'packaged launcher opens the selected startup preference entry in the current window without requiring a second click',
    successSummary:
      'Metro-backed Windows host opened a selected launcher startup preference in the current window and returned home.',
    finalSurfaceId: 'companion.main',
    persistedSurfaceReason:
      'launcher startup-preference open flow did not persist the launcher surface back into the main window session after returning home.',
  },
  {
    name: 'launcher-settings-round-trip-current-window',
    uiSpecFactoryName: 'createBundleLauncherSettingsRoundTripSpec',
    devDescription:
      'Metro-backed launcher opens Settings from startup preferences, returns home, then reopens Settings from startup preferences without a second click',
    packagedDescription:
      'packaged launcher reopens Settings from startup preferences after returning home without requiring a second click',
    successSummary:
      'Metro-backed Windows host reopened Settings from launcher startup preferences after returning home.',
    finalSurfaceId: 'companion.settings',
    persistedSurfaceReason:
      'launcher settings round-trip did not persist the reopened settings surface into the main window session.',
  },
  {
    name: 'launcher-post-settings-pointer-switch-current-window',
    uiSpecFactoryName: 'createBundleLauncherPostSettingsPointerSwitchSpec',
    devDescription:
      'Metro-backed launcher supports pointer-driven startup target switching after returning home from Settings',
    packagedDescription:
      'packaged launcher supports pointer-driven startup target switching after returning home from Settings',
    successSummary:
      'Metro-backed Windows host switched launcher startup targets with pointer input after returning from Settings.',
    finalSurfaceId: 'companion.agent-workbench',
    persistedSurfaceReason:
      'launcher pointer-driven startup target switching did not persist the Agent Workbench surface into the main window session.',
  },
  {
    name: 'launcher-post-settings-view-shot-pointer-open-current-window',
    uiSpecFactoryName: 'createBundleLauncherPostSettingsViewShotPointerOpenSpec',
    devDescription:
      'Metro-backed launcher opens View Shot from startup preferences after returning home from Settings with pointer input',
    packagedDescription:
      'packaged launcher opens View Shot from startup preferences after returning home from Settings with pointer input',
    successSummary:
      'Metro-backed Windows host opened View Shot from launcher startup preferences after returning from Settings.',
    finalSurfaceId: 'companion.view-shot',
    persistedSurfaceReason:
      'launcher post-settings View Shot open flow did not persist the View Shot surface into the main window session.',
  },
  {
    name: 'launcher-post-settings-window-capture-pointer-open-current-window',
    uiSpecFactoryName:
      'createBundleLauncherPostSettingsWindowCapturePointerOpenSpec',
    devDescription:
      'Metro-backed launcher opens Window Capture from startup preferences after returning home from Settings with pointer input',
    packagedDescription:
      'packaged launcher opens Window Capture from startup preferences after returning home from Settings with pointer input',
    successSummary:
      'Metro-backed Windows host opened Window Capture from launcher startup preferences after returning from Settings.',
    finalSurfaceId: 'companion.window-capture',
    persistedSurfaceReason:
      'launcher post-settings Window Capture open flow did not persist the Window Capture surface into the main window session.',
  },
];
