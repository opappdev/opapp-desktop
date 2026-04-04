import {existsSync} from 'node:fs';
import {mkdir, readFile, readdir, rm, unlink, writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import {
  clearDevSessions,
  clearHostLaunchConfig,
  clearHostLog,
  detectDeterministicCommandFailureFromHost,
  describeMetroOutcome,
  devSessionsPath,
  ensureMetroRunning,
  ensureWorkspaceTemp,
  frontendRoot,
  formatHostCommandTailDetails,
  getFatalFrontendDiagnostic,
  hostLogPath,
  hostRoot,
  killProcessTree,
  log,
  readFileTail,
  readHostLogTail,
  resolveHostCommandOutputPath,
  spawnCmdAsync,
  stopHostProcesses,
  tempRoot,
  waitForHostLogMarkers,
  workspaceRoot,
  writeHostLaunchConfig,
} from './windows-dev-common.mjs';
import {startCompanionChatSmokeServer} from './companion-chat-sse-smoke.mjs';
import {parsePositiveIntegerArg} from './windows-args-common.mjs';
import {assertPngCaptureLooksOpaque} from './windows-image-inspection.mjs';
import {
  createAgentWorkbenchDevScenarios,
  createCompanionChatDevScenarios,
  createViewShotDevScenarios,
  createWindowCaptureDevScenarios,
} from './windows-dev-scenarios/index.mjs';
import {runWindowsUiAutomation} from './windows-ui-automation-runner.mjs';
import {
  createAgentWorkbenchApprovalSpec,
  createAgentWorkbenchSpec,
  createLlmChatSpec,
  createViewShotCaptureRefSpec,
  createViewShotDataUriAndScreenSpec,
  createViewShotTmpfileReleaseSpec,
  createWindowCaptureLabSpec,
} from './windows-ui-scenarios.mjs';

const scenarioFilterToken = process.argv.find(argument => argument.startsWith('--scenario='));
const scenarioFilterArg = scenarioFilterToken?.split('=')[1];
const validateOnly = process.argv.includes('--validate-only');
const uiDebugScreenshots = process.argv.includes('--ui-debug-screenshots');
const companionMainBundleId = 'opapp.companion.main';
const companionChatBundleId = 'opapp.companion.chat';
const companionAgentWorkbenchSurfaceId = 'companion.agent-workbench';
const companionChatSurfaceId = 'companion.chat.main';
const llmChatDevSmokeUiStateRelativePath = path.join(
  'llm-chat',
  'dev-smoke-ui-state.json',
);
const verifyDevPreferencesPath = path.join(
  tempRoot,
  'opapp-windows-host.verify-dev.preferences.ini',
);
const opappUserDataRoot = path.join(
  process.env.LOCALAPPDATA || tempRoot,
  'OPApp',
);
const agentRuntimeRoot = path.join(opappUserDataRoot, 'agent-runtime');
const agentRunDocumentsRoot = path.join(agentRuntimeRoot, 'runs');
const agentThreadIndexPath = path.join(agentRuntimeRoot, 'thread-index.json');
const agentWorkbenchApprovalSmokePath = path.join(
  workspaceRoot,
  '.tmp',
  'agent-workbench',
  'approval-write-smoke.txt',
);
const workspaceTargetPath = path.join(
  agentRuntimeRoot,
  'workspace-target.json',
);
const companionStartupTargetPath = path.join(
  opappUserDataRoot,
  'startup',
  'companion-startup-target.json',
);

const readinessMarkers = [
  'Runtime=Metro',
  'InstanceLoaded failed=false',
];

const hostCommandOutputPath = path.join(tempRoot, 'opapp-windows-host.verify-dev.command.log');
const defaultReadinessTimeoutMs = 60_000;
const defaultSmokeTimeoutMs = 60_000;
const defaultStateVerificationTimeoutMs = 10_000;
const defaultStateVerificationPollMs = 200;
const agentRunDocumentFileNamePattern = /^run-[^\\/]+\.json$/i;
const readinessTimeoutMs = parsePositiveIntegerArg(
  process.argv,
  '--readiness-ms',
  defaultReadinessTimeoutMs,
);
const smokeTimeoutMs = parsePositiveIntegerArg(process.argv, '--smoke-ms', defaultSmokeTimeoutMs);

const foregroundWindowTitles = ['OpappWindowsHost', 'Opapp Tool', 'Opapp Settings'];
const devChatToken = 'opapp-dev-ui-automation';

function assertUiSavedPath(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Windows dev verify failed: missing ${label}.`);
  }

  return value.trim();
}

function assertUiSavedDataUri(value, label) {
  if (
    typeof value !== 'string' ||
    !value.startsWith('data:image/png;base64,') ||
    value.length <= 'data:image/png;base64,'.length
  ) {
    throw new Error(`Windows dev verify failed: invalid ${label}.`);
  }

  return value;
}

function hostProcessExists() {
  const result = spawnSync(
    'tasklist.exe',
    ['/FI', 'IMAGENAME eq OpappWindowsHost.exe', '/FO', 'CSV', '/NH'],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    },
  );

  return (
    result.status === 0 &&
    (result.stdout ?? '').toLowerCase().includes('opappwindowshost.exe')
  );
}

async function runUiScenarioWithDevFailFast({
  scenario,
  uiSpec,
  hostChild,
}) {
  return await runWindowsUiAutomation(uiSpec, {
    failFastMessage: `Windows dev verify aborted while running UI scenario '${scenario.name}'.`,
    failFastCheck: async () => {
      const deterministicFailure =
        await detectDeterministicCommandFailureFromHost(hostChild, {
          fallbackOutputPath: hostCommandOutputPath,
        });
      if (deterministicFailure) {
        return `${deterministicFailure.code}: ${deterministicFailure.summary}`;
      }

      if (!hostProcessExists()) {
        return 'OpappWindowsHost.exe exited unexpectedly.';
      }

      try {
        const logContents = await readFile(hostLogPath, 'utf8');
        const fatalDiagnostic = getFatalFrontendDiagnostic(logContents);
        if (fatalDiagnostic) {
          return `${fatalDiagnostic.event}: ${fatalDiagnostic.message}`;
        }
      } catch {
        // Ignore transient log-read failures while the UI runner is polling.
      }

      return null;
    },
  });
}

function applyUiDebugOptions(uiSpec) {
  if (!uiDebugScreenshots) {
    return uiSpec;
  }

  return {
    ...uiSpec,
    debug: {
      ...(uiSpec?.debug ?? {}),
      captureAfterActions: true,
    },
  };
}

const allScenarios = [
  ...createViewShotDevScenarios({
    assertPngCaptureLooksOpaque,
    assertUiSavedDataUri,
    assertUiSavedPath,
    clearOptionalFile,
    createViewShotCaptureRefSpec,
    createViewShotDataUriAndScreenSpec,
    createViewShotTmpfileReleaseSpec,
    log,
    runUiScenarioWithDevFailFast,
  }),
  ...createWindowCaptureDevScenarios({
    assertPngCaptureLooksOpaque,
    assertUiSavedPath,
    clearOptionalFile,
    createWindowCaptureLabSpec,
    log,
  }),
  ...createAgentWorkbenchDevScenarios({
    assertAgentWorkbenchApprovalState,
    cleanupAgentWorkbenchSmokeState,
    companionAgentWorkbenchSurfaceId,
    companionMainBundleId,
    createAgentWorkbenchApprovalSpec,
    createAgentWorkbenchSpec,
    prepareAgentWorkbenchSmokeState,
    verifyDevPreferencesPath,
  }),
  ...createCompanionChatDevScenarios({
    assertCompanionChatSmokeRequestCaptured,
    cleanupCompanionChatSmokeState,
    companionChatBundleId,
    companionChatSurfaceId,
    createLlmChatSpec,
    devChatToken,
    prepareCompanionChatSmokeState,
  }),
];
const scenarioByName = new Map(allScenarios.map(scenario => [scenario.name, scenario]));

function normalizeLogContents(logContents) {
  return logContents.replace(/\r/g, '');
}

function assertLogContainsRegex(logContents, regex, reason) {
  if (!regex.test(normalizeLogContents(logContents))) {
    throw new Error(`Windows dev verify failed: ${reason}`);
  }
}

function assertLogDoesNotContain(logContents, marker, reason) {
  if (normalizeLogContents(logContents).includes(marker)) {
    throw new Error(`Windows dev verify failed: ${reason}`);
  }
}

function extractLoggedPath(logContents, regex, reason) {
  const match = normalizeLogContents(logContents).match(regex);
  if (!match?.[1]) {
    throw new Error(`Windows dev verify failed: ${reason}`);
  }

  return match[1].trim();
}

function assertCompanionAgentWorkbenchCurrentWindowStayedOnSurface(
  logContents,
  failureLabel,
) {
  assertLogContainsRegex(
    logContents,
    /\[frontend-companion\] session bundle=opapp\.companion\.main window=window\.main tabs=1 active=tab:companion\.agent-workbench:1 entries=tab:companion\.agent-workbench:1:companion\.agent-workbench/i,
    `${failureLabel} did not keep the agent workbench session active in the main window.`,
  );
  if (
    normalizeLogContents(logContents).includes(
      '[frontend-companion] render bundle=opapp.companion.main window=window.main surface=companion.main policy=main',
    )
  ) {
    throw new Error(
      `Windows dev verify failed: ${failureLabel} still rendered the launcher surface instead of launching the agent workbench directly.`,
    );
  }
}

async function prepareAgentWorkbenchSmokeState() {
  const legacyStartupTargetContent = await readOptionalFile(
    companionStartupTargetPath,
  );
  const agentRuntimeSnapshot = await snapshotTextTree(agentRuntimeRoot);
  const approvalSmokeContent = await readOptionalFile(
    agentWorkbenchApprovalSmokePath,
  );

  await rm(agentRuntimeRoot, {recursive: true, force: true});
  await clearOptionalFile(agentWorkbenchApprovalSmokePath);
  await mkdir(path.dirname(workspaceTargetPath), {recursive: true});
  await writeFile(
    workspaceTargetPath,
    JSON.stringify({
      rootPath: workspaceRoot,
      displayName: path.basename(workspaceRoot),
      trusted: true,
    }),
    'utf8',
  );
  await clearOptionalFile(companionStartupTargetPath);

  return {
    agentRuntimeSnapshot,
    approvalSmokeContent,
    legacyStartupTargetContent,
  };
}

async function cleanupAgentWorkbenchSmokeState(state) {
  await restoreTextTree(agentRuntimeRoot, state?.agentRuntimeSnapshot);

  if (typeof state?.approvalSmokeContent === 'string') {
    await mkdir(path.dirname(agentWorkbenchApprovalSmokePath), {recursive: true});
    await writeFile(
      agentWorkbenchApprovalSmokePath,
      state.approvalSmokeContent,
      'utf8',
    );
  } else {
    await clearOptionalFile(agentWorkbenchApprovalSmokePath);
  }

  if (typeof state?.legacyStartupTargetContent === 'string') {
    await mkdir(path.dirname(companionStartupTargetPath), {recursive: true});
    await writeFile(
      companionStartupTargetPath,
      state.legacyStartupTargetContent,
      'utf8',
    );
    return;
  }

  await clearOptionalFile(companionStartupTargetPath);
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
      `Windows dev verify failed: could not read ${failureLabel} at ${targetPath}. ${error instanceof Error ? error.message : String(error)}`,
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
      `${failureMessage} Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
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
    if (
      !document?.run?.runId ||
      !Array.isArray(document?.timeline)
    ) {
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
      `Windows dev verify failed: expected exactly 1 approval entry in agent workbench run '${runDocument?.run?.runId ?? '<missing>'}', received ${approvalEntries.length}.`,
    );
  }

  return approvalEntries[0];
}

async function assertAgentWorkbenchApprovalState({decision}) {
  if (decision !== 'approve' && decision !== 'reject') {
    throw new Error(
      `Windows dev verify failed: unsupported agent workbench approval decision '${decision}'.`,
    );
  }

  const expectedRunStatus = decision === 'approve' ? 'completed' : 'cancelled';
  const expectedApprovalStatus =
    decision === 'approve' ? 'approved' : 'rejected';
  const decisionLabel = decision === 'approve' ? 'approved' : 'rejected';

  await waitForAsyncCondition(
    async () => {
      const approvalSmokeContent = await readOptionalFile(
        agentWorkbenchApprovalSmokePath,
      );
      if (decision === 'approve') {
        if (!approvalSmokeContent) {
          return null;
        }

        for (const marker of [
          'approvedAt=',
          'requestedCwd=opapp-frontend',
          'executor=agent-workbench',
        ]) {
          if (!approvalSmokeContent.includes(marker)) {
            throw new Error(
              `Windows dev verify failed: agent workbench approval smoke file is missing '${marker}'.`,
            );
          }
        }
      } else if (approvalSmokeContent) {
        throw new Error(
          `Windows dev verify failed: rejected agent workbench approval smoke unexpectedly created ${agentWorkbenchApprovalSmokePath}.`,
        );
      }

      const threadIndex = await readJsonFileOrThrow(
        agentThreadIndexPath,
        'agent runtime thread index',
      );
      if (
        !Array.isArray(threadIndex?.threads) ||
        threadIndex.threads.length !== 1
      ) {
        throw new Error(
          `Windows dev verify failed: expected exactly 1 persisted agent thread after ${decisionLabel} approval smoke, received ${threadIndex?.threads?.length ?? 0}.`,
        );
      }
      if (threadIndex.threads[0]?.lastRunStatus !== expectedRunStatus) {
        throw new Error(
          `Windows dev verify failed: expected the latest ${decisionLabel} approval smoke thread state to be '${expectedRunStatus}', received '${threadIndex.threads[0]?.lastRunStatus ?? '<missing>'}'.`,
        );
      }

      const runDocuments = await loadAgentRunDocuments(agentRunDocumentsRoot);
      if (runDocuments.length !== 1) {
        throw new Error(
          `Windows dev verify failed: expected 1 persisted agent run after ${decisionLabel} approval smoke, received ${runDocuments.length}.`,
        );
      }

      const runDocument = runDocuments[0];
      if (runDocument.run?.status !== expectedRunStatus) {
        throw new Error(
          `Windows dev verify failed: expected the ${decisionLabel} approval run to settle as '${expectedRunStatus}', received '${runDocument.run?.status ?? '<missing>'}'.`,
        );
      }

      const approvalEntry = getSingleApprovalEntry(runDocument);
      if (approvalEntry.status !== expectedApprovalStatus) {
        throw new Error(
          `Windows dev verify failed: expected the ${decisionLabel} approval entry status to be '${expectedApprovalStatus}', received '${approvalEntry.status ?? '<missing>'}'.`,
        );
      }

      if (
        threadIndex.threads[0]?.lastRunId &&
        threadIndex.threads[0].lastRunId !== runDocument.run?.runId
      ) {
        throw new Error(
          `Windows dev verify failed: expected the latest ${decisionLabel} approval thread to reference run '${runDocument.run?.runId ?? '<missing>'}', received '${threadIndex.threads[0].lastRunId}'.`,
        );
      }

      if (
        !runDocument.run?.request?.command?.includes('approval-write-smoke.txt')
      ) {
        throw new Error(
          `Windows dev verify failed: the ${decisionLabel} agent workbench run request no longer targets approval-write-smoke.txt.`,
        );
      }

      const terminalEvents = runDocument.timeline.filter(
        entry => entry?.kind === 'terminal-event',
      );
      if (decision === 'approve') {
        const approvedStdout = terminalEvents
          .filter(
            entry =>
              entry?.event === 'stdout' && typeof entry?.text === 'string',
          )
          .map(entry => entry.text)
          .join('');
        if (!approvedStdout.includes('workspace write smoke saved to')) {
          throw new Error(
            'Windows dev verify failed: the approved agent workbench run did not print the approval smoke save marker.',
          );
        }
        if (!approvedStdout.includes('approvedAt=')) {
          throw new Error(
            'Windows dev verify failed: the approved agent workbench run did not echo the approval smoke contents.',
          );
        }

        const approvedExitEntry = terminalEvents.find(
          entry => entry?.event === 'exit',
        );
        if (approvedExitEntry?.exitCode !== 0) {
          throw new Error(
            `Windows dev verify failed: approved agent workbench run exit code was '${approvedExitEntry?.exitCode ?? '<missing>'}' instead of 0.`,
          );
        }
      } else if (terminalEvents.length > 0) {
        throw new Error(
          'Windows dev verify failed: rejected agent workbench approval run should not have started a terminal session.',
        );
      }

      return {
        approvalSmokeContent,
        threadIndex,
        runDocument,
      };
    },
    {
      failureMessage: `Windows dev verify failed: ${decisionLabel} agent workbench approval state did not settle in time.`,
    },
  );
}

function assertCompanionChatSmokeRequestCaptured(state, failureLabel) {
  if (!state || state.requests.length !== 1) {
    throw new Error(
      `Windows dev verify failed: ${failureLabel} expected exactly 1 SSE request, received ${state?.requests.length ?? 0}.`,
    );
  }

  const request = state.requests[0];
  if (request?.method !== 'POST') {
    throw new Error(
      `Windows dev verify failed: ${failureLabel} did not send a POST request to the local SSE server.`,
    );
  }

  if (request?.body?.model !== state.model) {
    throw new Error(
      `Windows dev verify failed: ${failureLabel} did not send the fixture model to the local SSE server.`,
    );
  }

  if (request?.body?.stream !== true) {
    throw new Error(
      `Windows dev verify failed: ${failureLabel} did not request stream=true from the local SSE server.`,
    );
  }

  const lastMessage = request?.body?.messages?.at?.(-1);
  if (
    !lastMessage ||
    lastMessage.role !== 'user' ||
    lastMessage.content !== state.requestPrompt
  ) {
    throw new Error(
      `Windows dev verify failed: ${failureLabel} did not send the expected user prompt to the local SSE server.`,
    );
  }
}

async function prepareCompanionChatSmokeState(options = {}) {
  await clearCompanionChatSmokeUiArtifacts();
  return await startCompanionChatSmokeServer(options);
}

async function cleanupCompanionChatSmokeState(state) {
  await state?.close?.();
  await clearCompanionChatSmokeUiArtifacts();
}

async function resolveCompanionChatSmokeUiStatePaths() {
  const localAppDataRoot = process.env.LOCALAPPDATA || tempRoot;
  const candidates = [
    path.join(localAppDataRoot, 'OPApp', llmChatDevSmokeUiStateRelativePath),
  ];
  const packagesRoot = path.join(localAppDataRoot, 'Packages');

  try {
    const entries = await readdir(packagesRoot, {withFileTypes: true});
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith('OpappWindowsHost_')) {
        continue;
      }

      candidates.unshift(
        path.join(
          packagesRoot,
          entry.name,
          'LocalCache',
          'Local',
          'OPApp',
          llmChatDevSmokeUiStateRelativePath,
        ),
      );
    }
  } catch {
    // Fall back to the non-packaged local app-data root only.
  }

  return [...new Set(candidates)];
}

async function clearCompanionChatSmokeUiArtifacts() {
  const uiStatePaths = await resolveCompanionChatSmokeUiStatePaths();
  for (const candidatePath of uiStatePaths) {
    await clearOptionalFile(candidatePath);
  }
}

function escapePowerShellSingleQuotedString(value) {
  return String(value).replace(/'/g, "''");
}

function tryPromoteOpappWindowToForeground({
  windowTitles = foregroundWindowTitles,
  timeoutMs = 5000,
  retryDelayMs = 200,
} = {}) {
  const titleList = windowTitles
    .map(title => `'${escapePowerShellSingleQuotedString(title)}'`)
    .join(', ');
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class OpappVerifyForegroundNative {
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int command);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint gaFlags);
}
"@

$titles = @(${titleList})
$deadline = [DateTime]::UtcNow.AddMilliseconds(${timeoutMs})

while ([DateTime]::UtcNow -lt $deadline) {
  $candidate = Get-Process -Name 'OpappWindowsHost' -ErrorAction SilentlyContinue |
    Where-Object {
      $_.MainWindowHandle -ne 0 -and
      -not [string]::IsNullOrWhiteSpace($_.MainWindowTitle) -and
      $titles -contains $_.MainWindowTitle
    } |
    Select-Object -First 1

  if ($candidate) {
    $handle = [IntPtr]$candidate.MainWindowHandle
    [void][OpappVerifyForegroundNative]::ShowWindowAsync($handle, 9)
    [void][OpappVerifyForegroundNative]::BringWindowToTop($handle)
    [void][OpappVerifyForegroundNative]::SetForegroundWindow($handle)
    Start-Sleep -Milliseconds 120

    $foregroundHandle = [OpappVerifyForegroundNative]::GetAncestor([OpappVerifyForegroundNative]::GetForegroundWindow(), 2)
    $targetHandle = [OpappVerifyForegroundNative]::GetAncestor($handle, 2)
    if ([int64]$foregroundHandle -eq [int64]$targetHandle) {
      Write-Output ("focused:" + $candidate.MainWindowTitle)
      exit 0
    }
  }

  Start-Sleep -Milliseconds ${retryDelayMs}
}

exit 1
`;

  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
    {
      encoding: 'utf8',
      windowsHide: true,
    },
  );
  const stdout = (result.stdout ?? '').trim();
  const stderr = (result.stderr ?? '').trim();
  return {
    ok: result.status === 0,
    stdout,
    stderr,
  };
}

function parseScenarioFilterNames(rawValue) {
  if (!rawValue) {
    return [];
  }

  return rawValue
    .split(',')
    .map(name => name.trim())
    .filter(Boolean);
}

function resolveScenariosOrThrow() {
  const scenarioFilterNames = parseScenarioFilterNames(scenarioFilterArg);
  if (scenarioFilterToken && scenarioFilterNames.length === 0) {
    throw new Error('`--scenario=` must include at least one scenario name.');
  }

  if (scenarioFilterNames.length === 0) {
    return defaultScenarios;
  }

  const knownScenarioNames = [...scenarioByName.keys()].join(', ');
  const selectedScenarios = [];
  const seen = new Set();
  for (const scenarioName of scenarioFilterNames) {
    const scenario = scenarioByName.get(scenarioName);
    if (!scenario) {
      throw new Error(
        `Unknown --scenario=${scenarioName}. Supported scenarios: ${knownScenarioNames}`,
      );
    }
    if (seen.has(scenarioName)) {
      continue;
    }
    seen.add(scenarioName);
    selectedScenarios.push(scenario);
  }

  return selectedScenarios;
}

function appendConfigSection(content, name, values) {
  if (!values || Object.keys(values).length === 0) {
    return content;
  }

  let nextContent = `${content}\n[${name}]\n`;
  for (const [key, value] of Object.entries(values)) {
    nextContent += `${key}=${value}\n`;
  }
  return nextContent;
}

function buildLaunchConfigForScenario(launchConfig) {
  let content = `[sessions]\npath=${devSessionsPath}\n`;
  content = appendConfigSection(content, 'preferences', launchConfig.preferences);
  content = appendConfigSection(content, 'main', launchConfig.main);
  content = appendConfigSection(content, 'main-props', launchConfig.mainProps);
  content = appendConfigSection(content, 'initial-open', launchConfig.initialOpen);
  content = appendConfigSection(
    content,
    'initial-open-props',
    launchConfig.initialOpenProps,
  );
  return content;
}

function resolveScenarioLaunchConfig(scenario, scenarioState) {
  if (typeof scenario.buildLaunchConfig === 'function') {
    return scenario.buildLaunchConfig(scenarioState);
  }

  return scenario.launchConfig;
}

function describeHostWaitFailure(result, phase, hostChild, timeoutMs = defaultReadinessTimeoutMs) {
  const spawnModeDetail = hostChild?.opappSpawnMode
    ? ` Host spawn mode: ${hostChild.opappSpawnMode}.`
    : '';
  if (result.status === 'external-failure') {
    const code = result.externalFailure?.code ?? 'unknown';
    const summary = result.externalFailure?.summary ?? 'external fail-fast trigger';
    const commandOutputPath = result.externalFailure?.commandOutputPath
      ? ` command log=${result.externalFailure.commandOutputPath}.`
      : '';
    return (
      `Windows dev verify detected deterministic command failure while waiting for ${phase}: ` +
      `${code} (${summary}). Aborting early instead of waiting ${timeoutMs}ms.` +
      `${spawnModeDetail}${commandOutputPath}`
    );
  }

  if (result.status === 'fatal-frontend-error') {
    const detail = `${result.fatalDiagnostic.event}: ${result.fatalDiagnostic.message}`;
    return `Windows dev verify hit a frontend exception while waiting for ${phase}. ${detail}${spawnModeDetail}`;
  }

  return `Windows dev verify timed out waiting for ${phase} within ${timeoutMs}ms.${spawnModeDetail}`;
}

async function clearOptionalFile(targetPath) {
  try {
    await unlink(targetPath);
  } catch {
    // ignore
  }
}

async function readOptionalFile(targetPath) {
  try {
    return await readFile(targetPath, 'utf8');
  } catch {
    return null;
  }
}

async function buildHostWaitFailureMessage(
  result,
  phase,
  hostChild,
  {hostTailLines = 80, commandTailLines = 80, timeoutMs = defaultReadinessTimeoutMs} = {},
) {
  const hostTail = await readHostLogTail(hostTailLines);
  const activeCommandOutputPath = resolveHostCommandOutputPath(hostChild, hostCommandOutputPath);
  const commandTail = await readFileTail(activeCommandOutputPath, commandTailLines);
  let detail = describeHostWaitFailure(result, phase, hostChild, timeoutMs);
  if (hostTail) {
    detail += `\n${hostTail}`;
  }
  detail += formatHostCommandTailDetails(hostChild, {activeCommandOutputPath, commandTail});

  return detail;
}

async function prepareScenarioRun(scenario, scenarioState) {
  log('verify-dev', `preparing scenario '${scenario.name}'`);
  stopHostProcesses();
  clearDevSessions();
  clearHostLaunchConfig();
  clearHostLog();
  await clearOptionalFile(hostCommandOutputPath);
  await clearOptionalFile(verifyDevPreferencesPath);
  await writeHostLaunchConfig(
    buildLaunchConfigForScenario(
      resolveScenarioLaunchConfig(scenario, scenarioState),
    ),
  );
}

async function runDevScenario(scenario) {
  let scenarioState = null;
  let hostChild = null;
  const scenarioStartMs = Date.now();

  try {
    if (scenario.prepareState) {
      scenarioState = await scenario.prepareState();
    }

    await prepareScenarioRun(scenario, scenarioState);

    log(
      'verify-dev',
      `launching Windows host against Metro-backed bundle for scenario '${scenario.name}'`,
    );
    hostChild = await spawnCmdAsync('npm run windows', {
      cwd: hostRoot,
      env: process.env,
      label: 'host',
      outputCapturePath: hostCommandOutputPath,
    });
    if (hostChild?.opappSpawnMode) {
      log('verify-dev', `Host spawn mode: ${hostChild.opappSpawnMode}`);
    }

    const ready = await waitForHostLogMarkers(readinessMarkers, readinessTimeoutMs, {
      failFastOnFatalFrontendError: true,
      failFastCheck: () =>
        detectDeterministicCommandFailureFromHost(hostChild, {
          fallbackOutputPath: hostCommandOutputPath,
        }),
    });
    if (ready.status !== 'matched') {
      throw new Error(
        await buildHostWaitFailureMessage(
          ready,
          `Metro-backed host readiness for scenario '${scenario.name}'`,
          hostChild,
          {
            hostTailLines: 80,
            commandTailLines: 120,
            timeoutMs: readinessTimeoutMs,
          },
        ),
      );
    }

    const foregroundResult = tryPromoteOpappWindowToForeground();
    if (foregroundResult.ok) {
      log(
        'verify-dev',
        `Foreground assist confirmed for scenario '${scenario.name}': ${foregroundResult.stdout || 'focused'}`,
      );
    } else {
      log(
        'verify-dev',
        `Foreground assist could not confirm focus for scenario '${scenario.name}'. stdout=${foregroundResult.stdout || '<empty>'} stderr=${foregroundResult.stderr || '<empty>'}`,
      );
    }

    let uiResult = null;
    if (typeof scenario.buildUiSpec === 'function') {
      const uiSpec = applyUiDebugOptions(await scenario.buildUiSpec(scenarioState));
      uiResult = await runUiScenarioWithDevFailFast({
        scenario,
        uiSpec,
        hostChild,
      });
      await scenario.verifyUiResult?.(uiResult, scenarioState, {hostChild});
    } else {
      const smokeReady = await waitForHostLogMarkers(
        scenario.smokeMarkers,
        smokeTimeoutMs,
        {
          failFastOnFatalFrontendError: true,
          failFastCheck: () =>
            detectDeterministicCommandFailureFromHost(hostChild, {
              fallbackOutputPath: hostCommandOutputPath,
            }),
        },
      );
      if (smokeReady.status !== 'matched') {
        throw new Error(
          await buildHostWaitFailureMessage(
            smokeReady,
            `scenario '${scenario.name}' completion`,
            hostChild,
            {
              hostTailLines: 120,
              commandTailLines: 160,
              timeoutMs: smokeTimeoutMs,
            },
          ),
        );
      }
    }

    const logContents = await readFile(hostLogPath, 'utf8');
    await scenario.verifyLog?.(logContents, scenarioState, uiResult);
    const durationMs = Date.now() - scenarioStartMs;
    log(
      'verify-dev',
      `Scenario '${scenario.name}' completed successfully in ${durationMs}ms.`,
    );
    const tail = normalizeLogContents(logContents)
      .split('\n')
      .filter(Boolean)
      .slice(-60)
      .join('\n');
    if (tail) {
      log('verify-dev', 'Recent host log tail:');
      console.log(tail);
    }
    log('verify-dev', scenario.successSummary);

    return durationMs;
  } finally {
    clearDevSessions();
    clearHostLaunchConfig();
    stopHostProcesses();
    if (hostChild?.pid) {
      killProcessTree(hostChild.pid);
    }
    await scenario.cleanupState?.(scenarioState);
  }
}

async function main() {
  const scenarios = resolveScenariosOrThrow();

  ensureWorkspaceTemp();
  clearDevSessions();
  clearHostLaunchConfig();
  clearHostLog();
  await clearOptionalFile(hostCommandOutputPath);
  await clearOptionalFile(verifyDevPreferencesPath);
  stopHostProcesses();

  log('verify-dev', `hostRoot=${hostRoot}`);
  log('verify-dev', `scenarioFilterName=${scenarioFilterArg ?? '<all>'}`);
  log('verify-dev', `scenarioCount=${scenarios.length}`);
  log('verify-dev', `validateOnly=${validateOnly}`);
  log('verify-dev', `readinessTimeoutMs=${readinessTimeoutMs}`);
  log('verify-dev', `smokeTimeoutMs=${smokeTimeoutMs}`);

  if (validateOnly) {
    log('verify-dev', 'validate-only enabled; skipping Metro and host execution.');
    return;
  }

  let metroChild = null;

  try {
    const metro = await ensureMetroRunning({reuseIfReady: true, label: 'metro'});
    metroChild = metro.child;
    log('verify-dev', `Metro startup outcome: ${describeMetroOutcome(metro)}`);
    if (metroChild?.opappSpawnMode) {
      log('verify-dev', `Metro spawn mode: ${metroChild.opappSpawnMode}`);
    }

    const scenarioTimings = [];
    for (const scenario of scenarios) {
      const durationMs = await runDevScenario(scenario);
      scenarioTimings.push({name: scenario.name, durationMs});
    }

    const totalDurationMs = scenarioTimings.reduce(
      (sum, item) => sum + item.durationMs,
      0,
    );
    log(
      'verify-dev',
      `scenario timing summary totalMs=${totalDurationMs} scenarioCount=${scenarioTimings.length}`,
    );
  } finally {
    clearDevSessions();
    clearHostLaunchConfig();
    stopHostProcesses();
    if (metroChild?.pid) {
      killProcessTree(metroChild.pid);
    }
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
