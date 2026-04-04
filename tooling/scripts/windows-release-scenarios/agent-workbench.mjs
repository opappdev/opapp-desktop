import {existsSync} from 'node:fs';
import {mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';

const defaultStateVerificationTimeoutMs = 10_000;
const defaultStateVerificationPollMs = 200;
const agentRunDocumentFileNamePattern = /^run-[^\\/]+\.json$/i;

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

function createAgentWorkbenchRuntimePaths({workspaceRoot, userDataRoot}) {
  const agentRuntimeRoot = path.join(userDataRoot, 'agent-runtime');

  return {
    agentRuntimeRoot,
    agentRunDocumentsRoot: path.join(agentRuntimeRoot, 'runs'),
    agentThreadIndexPath: path.join(agentRuntimeRoot, 'thread-index.json'),
    agentWorkbenchApprovalSmokePath: path.join(
      workspaceRoot,
      '.tmp',
      'agent-workbench',
      'approval-write-smoke.txt',
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
  const approvalSmokeContent = await readOptionalFile(
    paths.agentWorkbenchApprovalSmokePath,
  );

  await rm(paths.agentRuntimeRoot, {recursive: true, force: true});
  await clearOptionalFile(paths.agentWorkbenchApprovalSmokePath);
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
    approvalSmokeContent,
    legacyStartupTargetContent,
  };
}

async function cleanupAgentWorkbenchSmokeState(paths, state) {
  await restoreTextTree(paths.agentRuntimeRoot, state?.agentRuntimeSnapshot);

  if (typeof state?.approvalSmokeContent === 'string') {
    await mkdir(path.dirname(paths.agentWorkbenchApprovalSmokePath), {
      recursive: true,
    });
    await writeFile(
      paths.agentWorkbenchApprovalSmokePath,
      state.approvalSmokeContent,
      'utf8',
    );
  } else {
    await clearOptionalFile(paths.agentWorkbenchApprovalSmokePath);
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

export function createAgentWorkbenchReleaseScenarios({
  assertPersistedSessionHasSurfaceId,
  commonSuccessMarkers,
  createAgentWorkbenchRetryRestoreSpec,
  defaultPreferences,
  userDataRoot,
  workspaceRoot,
}) {
  const runtimePaths = createAgentWorkbenchRuntimePaths({
    workspaceRoot,
    userDataRoot,
  });

  return {
    'companion-agent-workbench-retry-restore-current-window': {
      description:
        'auto-open agent workbench in the current window and exercise packaged retry/restore history flow',
      preferences: defaultPreferences,
      launchConfig: {
        initialOpen: {
          surface: 'companion.agent-workbench',
          policy: 'main',
          presentation: 'current-window',
        },
      },
      successMarkers: [
        ...commonSuccessMarkers,
        'InitialOpenSurface surface=companion.agent-workbench policy=main presentation=current-window',
        '[frontend-companion] auto-open window=window.main surface=companion.agent-workbench presentation=current-window',
        '[frontend-companion] render window=window.main surface=companion.agent-workbench policy=main',
        '[frontend-companion] mounted window=window.main surface=companion.agent-workbench policy=main',
        '[frontend-companion] session window=window.main tabs=1 active=tab:companion.main:1 entries=tab:companion.main:1:companion.agent-workbench',
      ],
      async prepareState() {
        return await prepareAgentWorkbenchSmokeState(runtimePaths, workspaceRoot);
      },
      async cleanupState(state) {
        await cleanupAgentWorkbenchSmokeState(runtimePaths, state);
      },
      async buildUiSpec() {
        return await createAgentWorkbenchRetryRestoreSpec({});
      },
      async verifyUiResult(uiResult) {
        await assertAgentWorkbenchRetryRestoreState(runtimePaths, {uiResult});
      },
      verifyPersistedSession(sessionFile) {
        if (!sessionFile.includes('[session]') || !sessionFile.includes('window.main=')) {
          throw new Error(
            'Windows release smoke failed: main window session was not persisted during agent workbench retry/restore smoke.',
          );
        }

        assertPersistedSessionHasSurfaceId(
          sessionFile,
          'window.main',
          'companion.agent-workbench',
          'agent workbench retry/restore smoke did not persist the agent workbench surface in the main window session.',
        );
      },
    },
  };
}
