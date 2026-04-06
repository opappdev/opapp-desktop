import {
  byAutomationId,
  defaultChatResponseTimeoutMs,
  defaultLocatorTimeoutMs,
  defaultStepTimeoutMs,
  sendKeys,
  waitForElementState,
  waitForLocator,
  windows,
} from './shared.mjs';

function createLatestGroupedToolCardAssertionSteps({
  window,
  scrollLabel,
  expectedToolName = 'shell_command',
  expectedCallStatus,
  expectedResultStatus,
  expectedInputText,
  expectedOutputTexts,
}) {
  // The frontend reserves tool.0 for the latest grouped tool card.
  const outputAssertionSteps = expectedOutputTexts.map(expectedOutputText => ({
    type: 'waitText',
    window,
    locator: byAutomationId('agent-workbench.timeline.tool.0.output'),
    matcher: {
      includes: expectedOutputText,
    },
  }));

  return [
    sendKeys({
      window,
      keys: '{PGDN}',
      delayMs: 300,
      label: scrollLabel,
    }),
    {
      type: 'waitText',
      window,
      locator: byAutomationId('agent-workbench.timeline.tool.0.name'),
      matcher: {
        includes: expectedToolName,
      },
    },
    {
      type: 'waitText',
      window,
      locator: byAutomationId('agent-workbench.timeline.tool.0.call-status'),
      matcher: {
        includes: expectedCallStatus,
      },
    },
    {
      type: 'waitText',
      window,
      locator: byAutomationId('agent-workbench.timeline.tool.0.result-status'),
      matcher: {
        includes: expectedResultStatus,
      },
    },
    {
      type: 'waitText',
      window,
      locator: byAutomationId('agent-workbench.timeline.tool.0.input'),
      matcher: {
        includes: expectedInputText,
      },
    },
    ...outputAssertionSteps,
  ];
}

export async function createAgentWorkbenchSpec({
  window = windows.main,
}) {
  return {
    name: 'agent-workbench',
    defaultTimeoutMs: defaultStepTimeoutMs,
    steps: [
      ...waitForLocator(
        window,
        byAutomationId('agent-workbench.action.start-draft-task'),
      ),
      {
        type: 'click',
        window,
        locator: byAutomationId(
          'agent-workbench.action.toggle-workspace-selector',
        ),
      },
      {
        type: 'click',
        window,
        locator: byAutomationId('agent-workbench.workspace.opapp-frontend'),
      },
      {
        type: 'waitText',
        window,
        locator: byAutomationId('agent-workbench.detail.selected-cwd'),
        matcher: {
          includes: 'opapp-frontend',
        },
      },
      {
        type: 'setValue',
        window,
        locator: byAutomationId('agent-workbench.task.goal-input'),
        value: 'git status',
      },
      waitForElementState({
        window,
        locator: byAutomationId('agent-workbench.action.start-draft-task'),
        matcher: {
          enabled: true,
        },
      }),
      {
        type: 'click',
        window,
        locator: byAutomationId('agent-workbench.action.start-draft-task'),
      },
      {
        type: 'waitText',
        window,
        locator: byAutomationId('agent-workbench.run.command'),
        matcher: {
          includes: 'git status',
        },
      },
      {
        type: 'waitText',
        window,
        locator: byAutomationId('agent-workbench.terminal.transcript'),
        matcher: {
          includes: 'git status',
        },
      },
      ...createLatestGroupedToolCardAssertionSteps({
        window,
        scrollLabel: 'scroll-to-tool-timeline',
        expectedCallStatus: '已完成',
        expectedResultStatus: '成功',
        expectedInputText: 'git status',
        expectedOutputTexts: ['$ git status', '[exit 0]'],
      }),
    ],
  };
}

export async function createAgentWorkbenchApprovalSpec({
  window = windows.main,
  decision = 'approve',
}) {
  if (decision !== 'approve' && decision !== 'reject') {
    throw new Error(
      `Agent workbench approval UI spec requires decision='approve' or 'reject', received '${decision}'.`,
    );
  }

  const decisionButtonAutomationId =
    decision === 'approve'
      ? 'agent-workbench.action.approve-request'
      : 'agent-workbench.action.reject-request';
  return {
    name: `agent-workbench-approval-${decision}`,
    defaultTimeoutMs: defaultStepTimeoutMs,
    steps: [
      ...waitForLocator(
        window,
        byAutomationId('agent-workbench.action.start-draft-task'),
      ),
      {
        type: 'click',
        window,
        locator: byAutomationId(
          'agent-workbench.action.toggle-workspace-selector',
        ),
      },
      {
        type: 'click',
        window,
        locator: byAutomationId('agent-workbench.workspace.opapp-frontend'),
      },
      {
        type: 'waitText',
        window,
        locator: byAutomationId('agent-workbench.detail.selected-cwd'),
        matcher: {
          includes: 'opapp-frontend',
        },
      },
      {
        type: 'click',
        window,
        locator: byAutomationId(
          'agent-workbench.action.populate-write-approval-draft',
        ),
      },
      waitForElementState({
        window,
        locator: byAutomationId('agent-workbench.action.start-draft-task'),
        matcher: {
          enabled: true,
        },
      }),
      {
        type: 'click',
        window,
        locator: byAutomationId('agent-workbench.action.start-draft-task'),
      },
      {
        type: 'waitText',
        window,
        locator: byAutomationId('agent-workbench.run.command'),
        matcher: {
          includes: 'agent-workbench-approval-smoke.txt',
        },
      },
      {
        type: 'waitText',
        window,
        locator: byAutomationId('agent-workbench.status.message'),
        matcher: {
          minLength: 4,
        },
      },
      sendKeys({
        window,
        keys: '{PGDN}',
        delayMs: 300,
        label: 'scroll-to-approval-panel',
      }),
      waitForElementState({
        window,
        locator: byAutomationId('agent-workbench.action.approve-request'),
        matcher: {
          enabled: true,
        },
      }),
      waitForElementState({
        window,
        locator: byAutomationId('agent-workbench.action.reject-request'),
        matcher: {
          enabled: true,
        },
      }),
      {
        type: 'click',
        window,
        locator: byAutomationId(decisionButtonAutomationId),
      },
      {
        type: 'assertElementMissing',
        window,
        locator: byAutomationId('agent-workbench.action.approve-request'),
        timeoutMs: defaultLocatorTimeoutMs,
      },
      {
        type: 'assertElementMissing',
        window,
        locator: byAutomationId('agent-workbench.action.reject-request'),
        timeoutMs: defaultLocatorTimeoutMs,
      },
      waitForElementState({
        window,
        locator: byAutomationId(
          'agent-workbench.action.populate-write-approval-draft',
        ),
        matcher: {
          enabled: true,
        },
        timeoutMs:
          decision === 'approve'
            ? defaultChatResponseTimeoutMs
            : defaultLocatorTimeoutMs,
      }),
      ...createLatestGroupedToolCardAssertionSteps({
        window,
        scrollLabel: `scroll-to-tool-timeline-${decision}`,
        expectedCallStatus: decision === 'approve' ? '已完成' : '已取消',
        expectedResultStatus: decision === 'approve' ? '成功' : '已取消',
        expectedInputText: 'agent-workbench-approval-smoke.txt',
        expectedOutputTexts:
          decision === 'approve'
            ? ['$ Set-Content', '[exit 0]']
            : ['无文本内容'],
      }),
    ],
  };
}

export async function createAgentWorkbenchRetryRestoreSpec({
  window = windows.main,
}) {
  return {
    name: 'agent-workbench-retry-restore',
    defaultTimeoutMs: defaultStepTimeoutMs,
    steps: [
      ...waitForLocator(
        window,
        byAutomationId('agent-workbench.action.run-git-status'),
      ),
      {
        type: 'click',
        window,
        locator: byAutomationId(
          'agent-workbench.action.toggle-workspace-selector',
        ),
      },
      {
        type: 'click',
        window,
        locator: byAutomationId('agent-workbench.workspace.opapp-frontend'),
      },
      {
        type: 'waitText',
        window,
        locator: byAutomationId('agent-workbench.detail.selected-cwd'),
        matcher: {
          includes: 'opapp-frontend',
        },
      },
      waitForElementState({
        window,
        locator: byAutomationId('agent-workbench.action.run-git-status'),
        matcher: {
          enabled: true,
        },
      }),
      {
        type: 'click',
        window,
        locator: byAutomationId('agent-workbench.action.run-git-status'),
      },
      {
        type: 'waitText',
        window,
        locator: byAutomationId('agent-workbench.run.command'),
        matcher: {
          includes: 'git status',
        },
      },
      {
        type: 'waitText',
        window,
        locator: byAutomationId('agent-workbench.terminal.transcript'),
        matcher: {
          includes: 'git status',
        },
      },
      {
        type: 'readText',
        window,
        locator: byAutomationId('agent-workbench.run.run-id'),
        saveAs: 'firstRunId',
      },
      waitForElementState({
        window,
        locator: byAutomationId('agent-workbench.action.run-git-status'),
        matcher: {
          enabled: true,
        },
      }),
      {
        type: 'click',
        window,
        locator: byAutomationId('agent-workbench.action.browse-workspace-root'),
      },
      {
        type: 'assertElementMissing',
        window,
        locator: byAutomationId('agent-workbench.action.browse-workspace-root'),
        timeoutMs: defaultLocatorTimeoutMs,
      },
      waitForElementState({
        window,
        locator: byAutomationId('agent-workbench.action.run-git-status'),
        matcher: {
          enabled: true,
        },
      }),
      {
        type: 'click',
        window,
        locator: byAutomationId('agent-workbench.action.run-git-status'),
      },
      ...waitForLocator(
        window,
        byAutomationId('agent-workbench.run-history.index-1'),
      ),
      {
        type: 'readText',
        window,
        locator: byAutomationId('agent-workbench.run.run-id'),
        saveAs: 'secondRunId',
      },
      sendKeys({
        window,
        keys: '{PGDN}',
        delayMs: 300,
        label: 'scroll-to-run-history',
      }),
      {
        type: 'click',
        window,
        locator: byAutomationId('agent-workbench.action.view-previous-run'),
      },
      {
        type: 'assertElementMissing',
        window,
        locator: byAutomationId('agent-workbench.action.view-previous-run'),
        timeoutMs: defaultLocatorTimeoutMs,
      },
      {
        type: 'readText',
        window,
        locator: byAutomationId('agent-workbench.run.run-id'),
        saveAs: 'selectedHistoricalRunId',
      },
      sendKeys({
        window,
        keys: '{PGDN}',
        delayMs: 300,
        label: 'scroll-to-retry-restore-actions',
      }),
      waitForElementState({
        window,
        locator: byAutomationId('agent-workbench.action.restore-run-workspace'),
        matcher: {
          enabled: true,
        },
      }),
      {
        type: 'click',
        window,
        locator: byAutomationId('agent-workbench.action.restore-run-workspace'),
      },
      ...waitForLocator(
        window,
        byAutomationId('agent-workbench.action.browse-workspace-root'),
      ),
      {
        type: 'waitText',
        window,
        locator: byAutomationId('agent-workbench.detail.selected-cwd'),
        matcher: {
          includes: 'opapp-frontend',
        },
        timeoutMs: defaultLocatorTimeoutMs,
        saveAs: 'restoredSelectedCwd',
      },
      waitForElementState({
        window,
        locator: byAutomationId('agent-workbench.action.retry-selected-run'),
        matcher: {
          enabled: true,
        },
      }),
      {
        type: 'click',
        window,
        locator: byAutomationId('agent-workbench.action.retry-selected-run'),
      },
      {
        type: 'waitText',
        window,
        locator: byAutomationId('agent-workbench.status.message'),
        matcher: {
          includes: '创建新的 run',
        },
      },
      ...waitForLocator(
        window,
        byAutomationId('agent-workbench.run-history.index-2'),
      ),
      ...waitForLocator(
        window,
        byAutomationId('agent-workbench.action.view-previous-run'),
      ),
      {
        type: 'waitText',
        window,
        locator: byAutomationId('agent-workbench.run.cwd'),
        matcher: {
          includes: 'opapp-frontend',
        },
      },
      {
        type: 'waitText',
        window,
        locator: byAutomationId('agent-workbench.run.resumed-from'),
        matcher: {
          regex: '^run-',
        },
      },
      {
        type: 'readText',
        window,
        locator: byAutomationId('agent-workbench.run.run-id'),
        saveAs: 'retriedRunId',
      },
      {
        type: 'readText',
        window,
        locator: byAutomationId('agent-workbench.run.resumed-from'),
        saveAs: 'retriedResumedFromRunId',
      },
      ...createLatestGroupedToolCardAssertionSteps({
        window,
        scrollLabel: 'scroll-to-retried-tool-timeline',
        expectedCallStatus: '已完成',
        expectedResultStatus: '成功',
        expectedInputText: 'git status',
        expectedOutputTexts: ['$ git status', '[exit 0]'],
      }),
    ],
  };
}
