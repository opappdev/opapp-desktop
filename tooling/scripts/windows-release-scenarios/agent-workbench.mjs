import {existsSync} from 'node:fs';
import {mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';

const defaultStateVerificationTimeoutMs = 10_000;
const defaultStateVerificationPollMs = 200;
const agentRunDocumentFileNamePattern = /^run-[^\\/]+\.json$/i;
const agentWorkbenchApprovalFixtureBaseline = [
  '# Agent Workbench Approval Smoke Fixture',
  'approvedAt=baseline',
  'requestedCwd=baseline',
  'executor=baseline',
  '',
].join('\n');

function assertUiSavedText(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Windows release smoke failed: missing ${label}.`);
  }

  return value.trim();
}

async function readOptionalFile(filePath) {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null;
    }

    throw error;
  }
}

async function clearOptionalFile(filePath) {
  await rm(filePath, {force: true});
}

async function snapshotTextTree(rootPath) {
  if (!existsSync(rootPath)) {
    return null;
  }

  const files = [];

  async function walkDirectory(currentPath) {
    const entries = await readdir(currentPath, {withFileTypes: true});
    for (const entry of entries) {
      const absolutePath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        await walkDirectory(absolutePath);
        continue;
      }

      files.push({
        relativePath: path.relative(rootPath, absolutePath),
        content: await readFile(absolutePath, 'utf8'),
      });
    }
  }

  await walkDirectory(rootPath);
  return files;
}

async function restoreTextTree(rootPath, snapshot) {
  await rm(rootPath, {recursive: true, force: true});
  if (!snapshot?.length) {
    return;
  }

  for (const entry of snapshot) {
    const absolutePath = path.join(rootPath, entry.relativePath);
    await mkdir(path.dirname(absolutePath), {recursive: true});
    await writeFile(absolutePath, entry.content, 'utf8');
  }
}

async function readJsonFileOrThrow(targetPath, failureLabel) {
  try {
    return JSON.parse(await readFile(targetPath, 'utf8'));
  } catch (error) {
    throw new Error(
      `Windows release smoke failed: could not read ${failureLabel} at ${targetPath}. ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function sleep(ms) {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForAsyncCondition(
  probe,
  {
    timeoutMs = defaultStateVerificationTimeoutMs,
    pollMs = defaultStateVerificationPollMs,
    failureMessage,
  },
) {
  const deadlineMs = Date.now() + timeoutMs;
  let lastError = null;

  while (Date.now() < deadlineMs) {
    try {
      const result = await probe();
      if (result !== null) {
        return result;
      }
    } catch (error) {
      lastError = error;
    }

    await sleep(pollMs);
  }

  if (lastError) {
    throw new Error(
      `${failureMessage} Last error: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
    );
  }

  throw new Error(failureMessage);
}

async function loadAgentRunDocuments(targetDir) {
  if (!existsSync(targetDir)) {
    return [];
  }

  const entries = await readdir(targetDir, {withFileTypes: true});
  const documents = [];
  for (const entry of entries) {
    if (
      !entry.isFile() ||
      !entry.name.endsWith('.json') ||
      !agentRunDocumentFileNamePattern.test(entry.name)
    ) {
      continue;
    }

    const documentPath = path.join(targetDir, entry.name);
    const document = await readJsonFileOrThrow(
      documentPath,
      `agent runtime document '${entry.name}'`,
    );
    if (!document?.run?.runId || !Array.isArray(document?.timeline)) {
      continue;
    }

    documents.push(document);
  }

  return documents;
}

function getSingleApprovalEntry(runDocument) {
  const approvalEntries = Array.isArray(runDocument?.timeline)
    ? runDocument.timeline.filter(entry => entry?.kind === 'approval')
    : [];
  if (approvalEntries.length !== 1) {
    throw new Error(
      `Windows release smoke failed: expected exactly 1 approval entry in agent workbench run '${runDocument?.run?.runId ?? '<missing>'}', received ${approvalEntries.length}.`,
    );
  }

  return approvalEntries[0];
}

function assertStructuredAgentTimeline(
  runDocument,
  {
    failureLabel,
    expectedToolCallStatus,
    expectedToolResultStatus,
    expectedExitCode,
    commandMarker,
    outputMarkers = [],
  },
) {
  const messageEntries = Array.isArray(runDocument?.timeline)
    ? runDocument.timeline.filter(entry => entry?.kind === 'message')
    : [];
  if (messageEntries.length !== 1) {
    throw new Error(
      `Windows release smoke failed: expected exactly 1 message entry in ${failureLabel}, received ${messageEntries.length}.`,
    );
  }
  if (messageEntries[0]?.role !== 'user') {
    throw new Error(
      `Windows release smoke failed: expected ${failureLabel} message role to be 'user', received '${messageEntries[0]?.role ?? '<missing>'}'.`,
    );
  }
  if (typeof messageEntries[0]?.content !== 'string' || !messageEntries[0].content.trim()) {
    throw new Error(
      `Windows release smoke failed: ${failureLabel} message content is empty.`,
    );
  }

  const planEntries = Array.isArray(runDocument?.timeline)
    ? runDocument.timeline.filter(entry => entry?.kind === 'plan')
    : [];
  if (planEntries.length !== 1) {
    throw new Error(
      `Windows release smoke failed: expected exactly 1 plan entry in ${failureLabel}, received ${planEntries.length}.`,
    );
  }
  if (!Array.isArray(planEntries[0]?.steps) || planEntries[0].steps.length !== 1) {
    throw new Error(
      `Windows release smoke failed: expected ${failureLabel} plan entry to contain exactly 1 step.`,
    );
  }
  if (planEntries[0].steps[0]?.status !== 'completed') {
    throw new Error(
      `Windows release smoke failed: expected ${failureLabel} plan step to settle as 'completed', received '${planEntries[0].steps[0]?.status ?? '<missing>'}'.`,
    );
  }
  if (
    typeof planEntries[0].steps[0]?.title !== 'string' ||
    !planEntries[0].steps[0].title.trim()
  ) {
    throw new Error(
      `Windows release smoke failed: ${failureLabel} plan step title is empty.`,
    );
  }

  const toolCallEntries = Array.isArray(runDocument?.timeline)
    ? runDocument.timeline.filter(entry => entry?.kind === 'tool-call')
    : [];
  if (toolCallEntries.length !== 1) {
    throw new Error(
      `Windows release smoke failed: expected exactly 1 tool-call entry in ${failureLabel}, received ${toolCallEntries.length}.`,
    );
  }
  if (toolCallEntries[0]?.toolName !== 'shell_command') {
    throw new Error(
      `Windows release smoke failed: expected ${failureLabel} tool-call name to be 'shell_command', received '${toolCallEntries[0]?.toolName ?? '<missing>'}'.`,
    );
  }
  if (toolCallEntries[0]?.status !== expectedToolCallStatus) {
    throw new Error(
      `Windows release smoke failed: expected ${failureLabel} tool-call status to be '${expectedToolCallStatus}', received '${toolCallEntries[0]?.status ?? '<missing>'}'.`,
    );
  }
  if (!toolCallEntries[0]?.inputText?.includes(commandMarker)) {
    throw new Error(
      `Windows release smoke failed: ${failureLabel} tool-call input no longer includes '${commandMarker}'.`,
    );
  }

  const toolResultEntries = Array.isArray(runDocument?.timeline)
    ? runDocument.timeline.filter(entry => entry?.kind === 'tool-result')
    : [];
  if (toolResultEntries.length !== 1) {
    throw new Error(
      `Windows release smoke failed: expected exactly 1 tool-result entry in ${failureLabel}, received ${toolResultEntries.length}.`,
    );
  }
  if (toolResultEntries[0]?.status !== expectedToolResultStatus) {
    throw new Error(
      `Windows release smoke failed: expected ${failureLabel} tool-result status to be '${expectedToolResultStatus}', received '${toolResultEntries[0]?.status ?? '<missing>'}'.`,
    );
  }
  if (toolResultEntries[0]?.exitCode !== expectedExitCode) {
    throw new Error(
      `Windows release smoke failed: expected ${failureLabel} tool-result exit code to be '${expectedExitCode ?? '<null>'}', received '${toolResultEntries[0]?.exitCode ?? '<null>'}'.`,
    );
  }
  for (const marker of outputMarkers) {
    if (!toolResultEntries[0]?.outputText?.includes(marker)) {
      throw new Error(
        `Windows release smoke failed: ${failureLabel} tool-result output is missing '${marker}'.`,
      );
    }
  }
}

function assertLoggedAgentWorkbenchRunStarted(logContents) {
  const normalizedLogContents = logContents.replace(/\r/g, '');
  if (
    !/\[frontend-diagnostics\] .*"event":"agent-workbench\.run\.started".*"cwd":"opapp-frontend"/.test(
      normalizedLogContents,
    )
  ) {
    throw new Error(
      'Windows release smoke failed: current-window agent workbench smoke did not log the packaged run-start interaction marker for opapp-frontend.',
    );
  }
}

function createAgentWorkbenchRuntimePaths({workspaceRoot, userDataRoot}) {
  const agentRuntimeRoot = path.join(userDataRoot, 'agent-runtime');

  return {
    agentRuntimeRoot,
    agentRunDocumentsRoot: path.join(agentRuntimeRoot, 'runs'),
    agentThreadIndexPath: path.join(agentRuntimeRoot, 'thread-index.json'),
    agentWorkbenchApprovalFixturePath: path.join(
      workspaceRoot,
      'opapp-frontend',
      'tooling',
      'tests',
      'fixtures',
      'agent-workbench-approval-smoke.txt',
    ),
    workspaceTargetPath: path.join(agentRuntimeRoot, 'workspace-target.json'),
    companionStartupTargetPath: path.join(
      userDataRoot,
      'startup',
      'companion-startup-target.json',
    ),
  };
}

async function prepareAgentWorkbenchSmokeState(paths, workspaceRoot) {
  const legacyStartupTargetContent = await readOptionalFile(
    paths.companionStartupTargetPath,
  );
  const agentRuntimeSnapshot = await snapshotTextTree(paths.agentRuntimeRoot);
  const approvalFixtureContent = await readOptionalFile(
    paths.agentWorkbenchApprovalFixturePath,
  );

  await rm(paths.agentRuntimeRoot, {recursive: true, force: true});
  await mkdir(path.dirname(paths.agentWorkbenchApprovalFixturePath), {
    recursive: true,
  });
  await writeFile(
    paths.agentWorkbenchApprovalFixturePath,
    agentWorkbenchApprovalFixtureBaseline,
    'utf8',
  );
  await mkdir(path.dirname(paths.workspaceTargetPath), {recursive: true});
  await writeFile(
    paths.workspaceTargetPath,
    JSON.stringify({
      rootPath: workspaceRoot,
      displayName: path.basename(workspaceRoot),
      trusted: true,
    }),
    'utf8',
  );
  await clearOptionalFile(paths.companionStartupTargetPath);

  return {
    agentRuntimeSnapshot,
    approvalFixtureContent,
    legacyStartupTargetContent,
  };
}

async function cleanupAgentWorkbenchSmokeState(paths, state) {
  await restoreTextTree(paths.agentRuntimeRoot, state?.agentRuntimeSnapshot);

  if (typeof state?.approvalFixtureContent === 'string') {
    await mkdir(path.dirname(paths.agentWorkbenchApprovalFixturePath), {
      recursive: true,
    });
    await writeFile(
      paths.agentWorkbenchApprovalFixturePath,
      state.approvalFixtureContent,
      'utf8',
    );
  } else {
    await clearOptionalFile(paths.agentWorkbenchApprovalFixturePath);
  }

  if (typeof state?.legacyStartupTargetContent === 'string') {
    await mkdir(path.dirname(paths.companionStartupTargetPath), {
      recursive: true,
    });
    await writeFile(
      paths.companionStartupTargetPath,
      state.legacyStartupTargetContent,
      'utf8',
    );
    return;
  }

  await clearOptionalFile(paths.companionStartupTargetPath);
}

async function assertAgentWorkbenchRetryRestoreState(paths, {uiResult}) {
  const savedValues = uiResult?.savedValues ?? {};
  const firstRunId = assertUiSavedText(
    savedValues.firstRunId,
    'agent workbench first run id',
  );
  const secondRunId = assertUiSavedText(
    savedValues.secondRunId,
    'agent workbench second run id',
  );
  const selectedHistoricalRunId = assertUiSavedText(
    savedValues.selectedHistoricalRunId,
    'agent workbench selected historical run id',
  );
  const restoredSelectedCwd = assertUiSavedText(
    savedValues.restoredSelectedCwd,
    'agent workbench restored selected cwd',
  );
  const retriedRunId = assertUiSavedText(
    savedValues.retriedRunId,
    'agent workbench retried run id',
  );
  const retriedResumedFromRunId = assertUiSavedText(
    savedValues.retriedResumedFromRunId,
    'agent workbench retried resumed-from run id',
  );

  if (selectedHistoricalRunId !== firstRunId) {
    throw new Error(
      `Windows release smoke failed: expected the selected historical run to stay on '${firstRunId}', received '${selectedHistoricalRunId}'.`,
    );
  }
  if (firstRunId === secondRunId) {
    throw new Error(
      'Windows release smoke failed: second agent workbench run reused the first run id.',
    );
  }
  if (retriedRunId === firstRunId || retriedRunId === secondRunId) {
    throw new Error(
      'Windows release smoke failed: retry action did not create a distinct latest run id.',
    );
  }
  if (retriedResumedFromRunId !== secondRunId) {
    throw new Error(
      `Windows release smoke failed: expected retry resumedFromRunId '${secondRunId}', received '${retriedResumedFromRunId}'.`,
    );
  }
  if (!restoredSelectedCwd.includes('opapp-frontend')) {
    throw new Error(
      `Windows release smoke failed: restore action did not switch selected cwd back to opapp-frontend. Received '${restoredSelectedCwd}'.`,
    );
  }

  await waitForAsyncCondition(
    async () => {
      const threadIndex = await readJsonFileOrThrow(
        paths.agentThreadIndexPath,
        'agent runtime thread index',
      );
      if (!Array.isArray(threadIndex?.threads) || threadIndex.threads.length === 0) {
        return null;
      }
      if (threadIndex.threads.length !== 1) {
        throw new Error(
          `Windows release smoke failed: expected exactly 1 persisted agent thread after retry/restore smoke, received ${threadIndex.threads.length}.`,
        );
      }

      const thread = threadIndex.threads[0];
      const runDocuments = await loadAgentRunDocuments(paths.agentRunDocumentsRoot);
      if (runDocuments.length < 3) {
        return null;
      }
      if (runDocuments.length !== 3) {
        throw new Error(
          `Windows release smoke failed: expected 3 persisted agent runs after retry/restore smoke, received ${runDocuments.length}.`,
        );
      }

      const runById = new Map(
        runDocuments.map(document => [document.run?.runId, document]),
      );
      const firstRun = runById.get(firstRunId);
      const secondRun = runById.get(secondRunId);
      const retriedRun = runById.get(retriedRunId);
      if (!firstRun || !secondRun || !retriedRun) {
        return null;
      }

      for (const [label, runDocument] of [
        ['first', firstRun],
        ['second', secondRun],
        ['retried', retriedRun],
      ]) {
        if (!runDocument?.run?.threadId) {
          throw new Error(
            `Windows release smoke failed: missing thread id on ${label} agent workbench run.`,
          );
        }
      }

      if (
        firstRun.run.threadId !== secondRun.run.threadId ||
        firstRun.run.threadId !== retriedRun.run.threadId
      ) {
        throw new Error(
          'Windows release smoke failed: retry/restore flow stopped writing runs into a single thread.',
        );
      }
      if (thread.lastRunId !== retriedRunId) {
        return null;
      }
      if (thread.lastRunStatus !== 'completed') {
        if (
          thread.lastRunStatus === 'queued' ||
          thread.lastRunStatus === 'running'
        ) {
          return null;
        }
        throw new Error(
          `Windows release smoke failed: expected retry/restore thread to settle as 'completed', received '${thread.lastRunStatus ?? '<missing>'}'.`,
        );
      }

      if (firstRun.run.status !== 'completed') {
        throw new Error(
          `Windows release smoke failed: expected first agent workbench run to settle as 'completed', received '${firstRun.run.status ?? '<missing>'}'.`,
        );
      }
      if (secondRun.run.status !== 'completed') {
        throw new Error(
          `Windows release smoke failed: expected second agent workbench run to settle as 'completed', received '${secondRun.run.status ?? '<missing>'}'.`,
        );
      }
      if (retriedRun.run.status !== 'completed') {
        if (
          retriedRun.run.status === 'queued' ||
          retriedRun.run.status === 'running'
        ) {
          return null;
        }
        throw new Error(
          `Windows release smoke failed: expected retried agent workbench run to settle as 'completed', received '${retriedRun.run.status ?? '<missing>'}'.`,
        );
      }

      if (firstRun.run.request?.command !== 'git status') {
        throw new Error(
          `Windows release smoke failed: first agent workbench run command changed to '${firstRun.run.request?.command ?? '<missing>'}'.`,
        );
      }
      if (secondRun.run.request?.command !== 'git status') {
        throw new Error(
          `Windows release smoke failed: second agent workbench run command changed to '${secondRun.run.request?.command ?? '<missing>'}'.`,
        );
      }
      if (retriedRun.run.request?.command !== 'git status') {
        throw new Error(
          `Windows release smoke failed: retried agent workbench run command changed to '${retriedRun.run.request?.command ?? '<missing>'}'.`,
        );
      }

      if (firstRun.run.request?.cwd !== 'opapp-frontend') {
        throw new Error(
          `Windows release smoke failed: first agent workbench run cwd changed to '${firstRun.run.request?.cwd ?? '<missing>'}'.`,
        );
      }
      if (secondRun.run.request?.cwd !== null) {
        throw new Error(
          `Windows release smoke failed: second agent workbench run should target workspace root cwd=null, received '${secondRun.run.request?.cwd ?? '<missing>'}'.`,
        );
      }
      if (retriedRun.run.request?.cwd !== 'opapp-frontend') {
        throw new Error(
          `Windows release smoke failed: retried agent workbench run cwd changed to '${retriedRun.run.request?.cwd ?? '<missing>'}'.`,
        );
      }
      if (retriedRun.run.resumedFromRunId !== secondRunId) {
        throw new Error(
          `Windows release smoke failed: retried agent workbench run resumedFromRunId is '${retriedRun.run.resumedFromRunId ?? '<missing>'}' instead of '${secondRunId}'.`,
        );
      }

      const retriedExitEntry = retriedRun.timeline.find(
        entry => entry?.kind === 'terminal-event' && entry?.event === 'exit',
      );
      if (!retriedExitEntry) {
        return null;
      }
      if (retriedExitEntry.exitCode !== 0) {
        throw new Error(
          `Windows release smoke failed: retried agent workbench run exit code was '${retriedExitEntry.exitCode ?? '<missing>'}' instead of 0.`,
        );
      }

      assertStructuredAgentTimeline(firstRun, {
        failureLabel: 'the first agent workbench run',
        expectedToolCallStatus: 'completed',
        expectedToolResultStatus: 'success',
        expectedExitCode: 0,
        commandMarker: 'git status',
        outputMarkers: ['$ git status', '[exit 0]'],
      });
      assertStructuredAgentTimeline(secondRun, {
        failureLabel: 'the second agent workbench run',
        expectedToolCallStatus: 'completed',
        expectedToolResultStatus: 'success',
        expectedExitCode: 0,
        commandMarker: 'git status',
        outputMarkers: ['$ git status', '[exit 0]'],
      });
      assertStructuredAgentTimeline(retriedRun, {
        failureLabel: 'the retried agent workbench run',
        expectedToolCallStatus: 'completed',
        expectedToolResultStatus: 'success',
        expectedExitCode: 0,
        commandMarker: 'git status',
        outputMarkers: ['$ git status', '[exit 0]'],
      });

      return {
        thread,
        runDocuments,
      };
    },
    {
      failureMessage:
        'Windows release smoke failed: agent workbench retry/restore state did not settle in time.',
    },
  );
}

async function assertAgentWorkbenchCurrentWindowState(paths) {
  await waitForAsyncCondition(
    async () => {
      const threadIndex = await readJsonFileOrThrow(
        paths.agentThreadIndexPath,
        'agent runtime thread index',
      );
      if (!Array.isArray(threadIndex?.threads) || threadIndex.threads.length === 0) {
        return null;
      }
      if (threadIndex.threads.length !== 1) {
        throw new Error(
          `Windows release smoke failed: expected exactly 1 persisted agent thread after current-window smoke, received ${threadIndex.threads.length}.`,
        );
      }

      const runDocuments = await loadAgentRunDocuments(paths.agentRunDocumentsRoot);
      if (runDocuments.length === 0) {
        return null;
      }
      if (runDocuments.length !== 1) {
        throw new Error(
          `Windows release smoke failed: expected 1 persisted agent run after current-window smoke, received ${runDocuments.length}.`,
        );
      }

      const thread = threadIndex.threads[0];
      const runDocument = runDocuments[0];
      if (!runDocument?.run?.threadId) {
        throw new Error(
          'Windows release smoke failed: missing thread id on current-window agent workbench run.',
        );
      }
      if (thread.lastRunId !== runDocument.run.runId) {
        return null;
      }
      if (thread.lastRunStatus !== 'completed') {
        if (
          thread.lastRunStatus === 'queued' ||
          thread.lastRunStatus === 'running'
        ) {
          return null;
        }
        throw new Error(
          `Windows release smoke failed: expected current-window agent workbench thread to settle as 'completed', received '${thread.lastRunStatus ?? '<missing>'}'.`,
        );
      }
      if (runDocument.run?.status !== 'completed') {
        if (
          runDocument.run?.status === 'queued' ||
          runDocument.run?.status === 'running'
        ) {
          return null;
        }
        throw new Error(
          `Windows release smoke failed: expected current-window agent workbench run to settle as 'completed', received '${runDocument.run?.status ?? '<missing>'}'.`,
        );
      }
      if (runDocument.run.request?.command !== 'git status') {
        throw new Error(
          `Windows release smoke failed: current-window agent workbench run command changed to '${runDocument.run.request?.command ?? '<missing>'}'.`,
        );
      }
      if (runDocument.run.request?.cwd !== 'opapp-frontend') {
        throw new Error(
          `Windows release smoke failed: current-window agent workbench run cwd changed to '${runDocument.run.request?.cwd ?? '<missing>'}'.`,
        );
      }
      if (runDocument.run.resumedFromRunId !== null) {
        throw new Error(
          `Windows release smoke failed: current-window agent workbench run unexpectedly resumed from '${runDocument.run.resumedFromRunId}'.`,
        );
      }

      const approvalEntries = runDocument.timeline.filter(
        entry => entry?.kind === 'approval',
      );
      if (approvalEntries.length > 0) {
        throw new Error(
          `Windows release smoke failed: current-window agent workbench run unexpectedly created ${approvalEntries.length} approval entries.`,
        );
      }

      const terminalEvents = runDocument.timeline.filter(
        entry => entry?.kind === 'terminal-event',
      );
      const startedEntry = terminalEvents.find(entry => entry?.event === 'started');
      if (!startedEntry) {
        return null;
      }
      if (startedEntry.command !== 'git status') {
        throw new Error(
          `Windows release smoke failed: current-window terminal start command changed to '${startedEntry.command ?? '<missing>'}'.`,
        );
      }
      const exitEntry = terminalEvents.find(entry => entry?.event === 'exit');
      if (!exitEntry) {
        return null;
      }
      if (exitEntry.exitCode !== 0) {
        throw new Error(
          `Windows release smoke failed: current-window agent workbench run exit code was '${exitEntry.exitCode ?? '<missing>'}' instead of 0.`,
        );
      }

      assertStructuredAgentTimeline(runDocument, {
        failureLabel: 'the current-window agent workbench run',
        expectedToolCallStatus: 'completed',
        expectedToolResultStatus: 'success',
        expectedExitCode: 0,
        commandMarker: 'git status',
        outputMarkers: ['$ git status', '[exit 0]'],
      });

      return {
        thread,
        runDocument,
      };
    },
    {
      failureMessage:
        'Windows release smoke failed: agent workbench current-window state did not settle in time.',
    },
  );
}

async function assertAgentWorkbenchApprovalState(paths, {decision}) {
  if (decision !== 'approve' && decision !== 'reject') {
    throw new Error(
      `Windows release smoke failed: unsupported agent workbench approval decision '${decision}'.`,
    );
  }

  const expectedRunStatus = decision === 'approve' ? 'completed' : 'cancelled';
  const expectedApprovalStatus =
    decision === 'approve' ? 'approved' : 'rejected';
  const decisionLabel = decision === 'approve' ? 'approved' : 'rejected';

  await waitForAsyncCondition(
    async () => {
      const approvalFixtureContent = await readOptionalFile(
        paths.agentWorkbenchApprovalFixturePath,
      );
      const normalizedApprovalFixtureContent =
        typeof approvalFixtureContent === 'string'
          ? approvalFixtureContent.replace(/\r/g, '')
          : null;
      if (decision === 'approve') {
        if (
          !normalizedApprovalFixtureContent ||
          normalizedApprovalFixtureContent ===
            agentWorkbenchApprovalFixtureBaseline
        ) {
          return null;
        }

        for (const marker of [
          'approvedAt=',
          'requestedCwd=opapp-frontend',
          'executor=agent-workbench',
        ]) {
          if (!normalizedApprovalFixtureContent.includes(marker)) {
            throw new Error(
              `Windows release smoke failed: agent workbench approval fixture is missing '${marker}'.`,
            );
          }
        }
      } else if (
        normalizedApprovalFixtureContent !==
        agentWorkbenchApprovalFixtureBaseline
      ) {
        throw new Error(
          `Windows release smoke failed: rejected agent workbench approval unexpectedly changed ${paths.agentWorkbenchApprovalFixturePath}.`,
        );
      }

      const threadIndex = await readJsonFileOrThrow(
        paths.agentThreadIndexPath,
        'agent runtime thread index',
      );
      if (
        !Array.isArray(threadIndex?.threads) ||
        threadIndex.threads.length !== 1
      ) {
        throw new Error(
          `Windows release smoke failed: expected exactly 1 persisted agent thread after ${decisionLabel} approval smoke, received ${threadIndex?.threads?.length ?? 0}.`,
        );
      }
      if (threadIndex.threads[0]?.lastRunStatus !== expectedRunStatus) {
        throw new Error(
          `Windows release smoke failed: expected the latest ${decisionLabel} approval smoke thread state to be '${expectedRunStatus}', received '${threadIndex.threads[0]?.lastRunStatus ?? '<missing>'}'.`,
        );
      }

      const runDocuments = await loadAgentRunDocuments(paths.agentRunDocumentsRoot);
      if (runDocuments.length !== 1) {
        throw new Error(
          `Windows release smoke failed: expected 1 persisted agent run after ${decisionLabel} approval smoke, received ${runDocuments.length}.`,
        );
      }

      const runDocument = runDocuments[0];
      if (runDocument.run?.status !== expectedRunStatus) {
        throw new Error(
          `Windows release smoke failed: expected the ${decisionLabel} approval run to settle as '${expectedRunStatus}', received '${runDocument.run?.status ?? '<missing>'}'.`,
        );
      }

      const approvalEntry = getSingleApprovalEntry(runDocument);
      if (approvalEntry.status !== expectedApprovalStatus) {
        throw new Error(
          `Windows release smoke failed: expected the ${decisionLabel} approval entry status to be '${expectedApprovalStatus}', received '${approvalEntry.status ?? '<missing>'}'.`,
        );
      }

      if (
        threadIndex.threads[0]?.lastRunId &&
        threadIndex.threads[0].lastRunId !== runDocument.run?.runId
      ) {
        throw new Error(
          `Windows release smoke failed: expected the latest ${decisionLabel} approval thread to reference run '${runDocument.run?.runId ?? '<missing>'}', received '${threadIndex.threads[0].lastRunId}'.`,
        );
      }

      if (
        !runDocument.run?.request?.command?.includes(
          'agent-workbench-approval-smoke.txt',
        )
      ) {
        throw new Error(
          `Windows release smoke failed: the ${decisionLabel} agent workbench run request no longer targets agent-workbench-approval-smoke.txt.`,
        );
      }

      const terminalEvents = runDocument.timeline.filter(
        entry => entry?.kind === 'terminal-event',
      );
      const artifactEntries = runDocument.timeline.filter(
        entry => entry?.kind === 'artifact',
      );
      if (decision === 'approve') {
        assertStructuredAgentTimeline(runDocument, {
          failureLabel: 'the approved agent workbench run',
          expectedToolCallStatus: 'completed',
          expectedToolResultStatus: 'success',
          expectedExitCode: 0,
          commandMarker: 'agent-workbench-approval-smoke.txt',
          outputMarkers: ['$ Set-Content', '[exit 0]'],
        });
        if (artifactEntries.length !== 1) {
          throw new Error(
            `Windows release smoke failed: expected exactly 1 artifact entry after approved agent workbench run, received ${artifactEntries.length}.`,
          );
        }
        if (artifactEntries[0]?.artifactKind !== 'diff') {
          throw new Error(
            `Windows release smoke failed: approved agent workbench artifact kind was '${artifactEntries[0]?.artifactKind ?? '<missing>'}' instead of 'diff'.`,
          );
        }
        if (
          !artifactEntries[0]?.path?.includes(
            'agent-workbench-approval-smoke.txt',
          )
        ) {
          throw new Error(
            'Windows release smoke failed: approved agent workbench artifact path no longer targets agent-workbench-approval-smoke.txt.',
          );
        }

        const approvedStdout = terminalEvents
          .filter(
            entry =>
            entry?.event === 'stdout' && typeof entry?.text === 'string',
          )
          .map(entry => entry.text)
          .join('');
        if (!approvedStdout.includes('approval smoke fixture saved to')) {
          throw new Error(
            'Windows release smoke failed: the approved agent workbench run did not print the approval fixture save marker.',
          );
        }
        if (
          !approvedStdout.includes('approvedAt=') ||
          !approvedStdout.includes('diff --git')
        ) {
          throw new Error(
            'Windows release smoke failed: the approved agent workbench run did not echo both the fixture contents and git diff.',
          );
        }

        const approvedExitEntry = terminalEvents.find(
          entry => entry?.event === 'exit',
        );
        if (approvedExitEntry?.exitCode !== 0) {
          throw new Error(
            `Windows release smoke failed: approved agent workbench run exit code was '${approvedExitEntry?.exitCode ?? '<missing>'}' instead of 0.`,
          );
        }
      } else {
        assertStructuredAgentTimeline(runDocument, {
          failureLabel: 'the rejected agent workbench run',
          expectedToolCallStatus: 'cancelled',
          expectedToolResultStatus: 'cancelled',
          expectedExitCode: null,
          commandMarker: 'agent-workbench-approval-smoke.txt',
        });
        if (terminalEvents.length > 0) {
          throw new Error(
            'Windows release smoke failed: rejected agent workbench approval run should not have started a terminal session.',
          );
        }
        if (artifactEntries.length > 0) {
          throw new Error(
            'Windows release smoke failed: rejected agent workbench approval run should not persist artifact entries.',
          );
        }
      }

      return {
        approvalFixtureContent,
        threadIndex,
        runDocument,
      };
    },
    {
      failureMessage: `Windows release smoke failed: ${decisionLabel} agent workbench approval state did not settle in time.`,
    },
  );
}

export function createAgentWorkbenchReleaseScenarios({
  assertPersistedSessionHasSurfaceId,
  commonSuccessMarkers,
  createAgentWorkbenchApprovalSpec,
  createAgentWorkbenchRetryRestoreSpec,
  createAgentWorkbenchSpec,
  defaultPreferences,
  userDataRoot,
  workspaceRoot,
}) {
  const runtimePaths = createAgentWorkbenchRuntimePaths({
    workspaceRoot,
    userDataRoot,
  });
  const baseLaunchConfig = {
    initialOpen: {
      surface: 'companion.agent-workbench',
      policy: 'main',
      presentation: 'current-window',
    },
  };
  const baseSuccessMarkers = [
    ...commonSuccessMarkers,
    'InitialOpenSurface surface=companion.agent-workbench policy=main presentation=current-window',
    '[frontend-companion] auto-open window=window.main surface=companion.agent-workbench presentation=current-window',
    '[frontend-companion] render window=window.main surface=companion.agent-workbench policy=main',
    '[frontend-companion] mounted window=window.main surface=companion.agent-workbench policy=main',
    '[frontend-companion] session window=window.main tabs=1 active=tab:companion.main:1 entries=tab:companion.main:1:companion.agent-workbench',
  ];

  function verifyPersistedAgentWorkbenchSession(sessionFile, flowLabel) {
    if (!sessionFile.includes('[session]') || !sessionFile.includes('window.main=')) {
      throw new Error(
        `Windows release smoke failed: main window session was not persisted during ${flowLabel}.`,
      );
    }

    assertPersistedSessionHasSurfaceId(
      sessionFile,
      'window.main',
      'companion.agent-workbench',
      `${flowLabel} did not persist the agent workbench surface in the main window session.`,
    );
  }

  const baseScenario = {
    preferences: defaultPreferences,
    launchConfig: baseLaunchConfig,
    successMarkers: baseSuccessMarkers,
    async prepareState() {
      return await prepareAgentWorkbenchSmokeState(runtimePaths, workspaceRoot);
    },
    async cleanupState(state) {
      await cleanupAgentWorkbenchSmokeState(runtimePaths, state);
    },
  };

  return {
    'companion-agent-workbench-current-window': {
      ...baseScenario,
      description:
        'auto-open agent workbench in the current window and exercise packaged workspace/run smoke path',
      async buildUiSpec() {
        return await createAgentWorkbenchSpec({});
      },
      verifyLog(logContents) {
        assertLoggedAgentWorkbenchRunStarted(logContents);
      },
      async verifyUiResult() {
        await assertAgentWorkbenchCurrentWindowState(runtimePaths);
      },
      verifyPersistedSession(sessionFile) {
        verifyPersistedAgentWorkbenchSession(
          sessionFile,
          'agent workbench current-window smoke',
        );
      },
    },
    'companion-agent-workbench-approval-approve-current-window': {
      ...baseScenario,
      description:
        'auto-open agent workbench in the current window and exercise packaged approval request/approve flow',
      async buildUiSpec() {
        return await createAgentWorkbenchApprovalSpec({
          decision: 'approve',
        });
      },
      async verifyUiResult(uiResult) {
        await assertAgentWorkbenchApprovalState(runtimePaths, {
          decision: 'approve',
          uiResult,
        });
      },
      verifyPersistedSession(sessionFile) {
        verifyPersistedAgentWorkbenchSession(
          sessionFile,
          'agent workbench approval approve smoke',
        );
      },
    },
    'companion-agent-workbench-approval-reject-current-window': {
      ...baseScenario,
      description:
        'auto-open agent workbench in the current window and exercise packaged approval request/reject flow',
      async buildUiSpec() {
        return await createAgentWorkbenchApprovalSpec({
          decision: 'reject',
        });
      },
      async verifyUiResult(uiResult) {
        await assertAgentWorkbenchApprovalState(runtimePaths, {
          decision: 'reject',
          uiResult,
        });
      },
      verifyPersistedSession(sessionFile) {
        verifyPersistedAgentWorkbenchSession(
          sessionFile,
          'agent workbench approval reject smoke',
        );
      },
    },
    'companion-agent-workbench-retry-restore-current-window': {
      ...baseScenario,
      description:
        'auto-open agent workbench in the current window and exercise packaged retry/restore history flow',
      async buildUiSpec() {
        return await createAgentWorkbenchRetryRestoreSpec({});
      },
      async verifyUiResult(uiResult) {
        await assertAgentWorkbenchRetryRestoreState(runtimePaths, {uiResult});
      },
      verifyPersistedSession(sessionFile) {
        verifyPersistedAgentWorkbenchSession(
          sessionFile,
          'agent workbench retry/restore smoke',
        );
      },
    },
  };
}
