function createAgentWorkbenchSmokeMarkers({
  companionAgentWorkbenchSurfaceId,
  companionMainBundleId,
}) {
  return [
    `LaunchSurface surface=${companionAgentWorkbenchSurfaceId} policy=main mode=`,
    `[frontend-companion] render bundle=${companionMainBundleId} window=window.main surface=${companionAgentWorkbenchSurfaceId} policy=main`,
    `[frontend-companion] mounted bundle=${companionMainBundleId} window=window.main surface=${companionAgentWorkbenchSurfaceId} policy=main`,
    `[frontend-companion] session bundle=${companionMainBundleId} window=window.main tabs=1 active=tab:${companionAgentWorkbenchSurfaceId}:1 entries=tab:${companionAgentWorkbenchSurfaceId}:1:${companionAgentWorkbenchSurfaceId}`,
  ];
}

export function createAgentWorkbenchDevScenarios({
  assertAgentWorkbenchApprovalState,
  assertAgentWorkbenchRetryRestoreState,
  cleanupAgentWorkbenchSmokeState,
  companionAgentWorkbenchSurfaceId,
  companionMainBundleId,
  createAgentWorkbenchApprovalSpec,
  createAgentWorkbenchRetryRestoreSpec,
  createAgentWorkbenchSpec,
  prepareAgentWorkbenchSmokeState,
  verifyDevPreferencesPath,
}) {
  const baseSmokeMarkers = createAgentWorkbenchSmokeMarkers({
    companionAgentWorkbenchSurfaceId,
    companionMainBundleId,
  });
  const baseLaunchConfig = {
    preferences: {
      path: verifyDevPreferencesPath,
    },
    main: {
      surface: companionAgentWorkbenchSurfaceId,
      policy: 'main',
      mode: 'wide',
    },
  };

  return [
    {
      name: 'companion-agent-workbench-current-window',
      description:
        'Metro-backed Windows host launches the agent workbench surface directly into the main window and exercises the workspace/diff smoke path',
      smokeMarkers: [
        ...baseSmokeMarkers,
        '[frontend-agent-workbench] dev-smoke-start',
        '[frontend-agent-workbench] dev-smoke-workspace cwd=opapp-frontend entries=',
        '[frontend-agent-workbench] dev-smoke-diff-ready path=opapp-frontend/',
        '[frontend-agent-workbench] dev-smoke-window-list count=',
        '[frontend-agent-workbench] dev-smoke-ui-ready',
        '[frontend-agent-workbench] dev-smoke-capture-client backend=wgc crop=',
        '[frontend-agent-workbench] dev-smoke-complete',
      ],
      async prepareState() {
        return await prepareAgentWorkbenchSmokeState();
      },
      launchConfig: baseLaunchConfig,
      async cleanupState(state) {
        await cleanupAgentWorkbenchSmokeState(state);
      },
      async buildUiSpec() {
        return await createAgentWorkbenchSpec({});
      },
      successSummary:
        'Metro-backed Windows host completed direct agent-workbench startup smoke.',
    },
    {
      name: 'companion-agent-workbench-approval-approve-current-window',
      description:
        'Metro-backed Windows host launches the agent workbench surface directly into the main window and exercises the approval request/approve flow',
      smokeMarkers: baseSmokeMarkers,
      async prepareState() {
        return await prepareAgentWorkbenchSmokeState();
      },
      launchConfig: baseLaunchConfig,
      async cleanupState(state) {
        await cleanupAgentWorkbenchSmokeState(state);
      },
      async buildUiSpec() {
        return await createAgentWorkbenchApprovalSpec({
          decision: 'approve',
        });
      },
      async verifyUiResult() {
        await assertAgentWorkbenchApprovalState({
          decision: 'approve',
        });
      },
      successSummary:
        'Metro-backed Windows host completed direct agent-workbench approval approve smoke.',
    },
    {
      name: 'companion-agent-workbench-approval-reject-current-window',
      description:
        'Metro-backed Windows host launches the agent workbench surface directly into the main window and exercises the approval request/reject flow',
      smokeMarkers: baseSmokeMarkers,
      async prepareState() {
        return await prepareAgentWorkbenchSmokeState();
      },
      launchConfig: baseLaunchConfig,
      async cleanupState(state) {
        await cleanupAgentWorkbenchSmokeState(state);
      },
      async buildUiSpec() {
        return await createAgentWorkbenchApprovalSpec({
          decision: 'reject',
        });
      },
      async verifyUiResult() {
        await assertAgentWorkbenchApprovalState({
          decision: 'reject',
        });
      },
      successSummary:
        'Metro-backed Windows host completed direct agent-workbench approval reject smoke.',
    },
    {
      name: 'companion-agent-workbench-retry-restore-current-window',
      description:
        'Metro-backed Windows host launches the agent workbench surface directly into the main window and exercises retry/restore flow from thread history',
      smokeMarkers: baseSmokeMarkers,
      async prepareState() {
        return await prepareAgentWorkbenchSmokeState();
      },
      launchConfig: baseLaunchConfig,
      async cleanupState(state) {
        await cleanupAgentWorkbenchSmokeState(state);
      },
      async buildUiSpec() {
        return await createAgentWorkbenchRetryRestoreSpec({});
      },
      async verifyUiResult(uiResult) {
        await assertAgentWorkbenchRetryRestoreState({
          uiResult,
        });
      },
      successSummary:
        'Metro-backed Windows host completed direct agent-workbench retry/restore smoke.',
    },
  ];
}
