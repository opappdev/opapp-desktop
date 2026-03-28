import {unlink} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {
  clearDevSessions,
  clearHostLaunchConfig,
  devSessionsPath,
  clearHostLog,
  detectDeterministicCommandFailureFromHost,
  describeMetroOutcome,
  ensureMetroRunning,
  ensureWorkspaceTemp,
  hostRoot,
  killProcessTree,
  log,
  readFileTail,
  readHostLogTail,
  resolveHostCommandOutputPath,
  spawnCmdAsync,
  writeHostLaunchConfig,
  stopHostProcesses,
  tempRoot,
  waitForHostLogMarkers,
} from './windows-dev-common.mjs';
import {parsePositiveIntegerArg} from './windows-args-common.mjs';

const readinessMarkers = [
  'Runtime=Metro',
  'InstanceLoaded failed=false',
  '[frontend-companion] mounted',
];

const smokeMarkers = [
  '[frontend-challenge-advisor] dev-smoke-start',
  '[frontend-challenge-advisor] dev-smoke-track-switched track=score-challenge',
  '[frontend-challenge-advisor] dev-smoke-track-switched track=stellar-wars',
  '[frontend-challenge-advisor] dev-smoke-scrolled-end',
  '[frontend-challenge-advisor] dev-smoke-toggled',
  '[frontend-challenge-advisor] dev-smoke-settings-opened',
  '[frontend-challenge-advisor] dev-smoke-settings-focused',
  '[frontend-challenge-advisor] dev-smoke-settings-closed',
  '[frontend-challenge-advisor] dev-smoke-scrolled-top',
  '[frontend-challenge-advisor] dev-smoke-complete',
];
const hostCommandOutputPath = path.join(tempRoot, 'opapp-windows-host.verify-dev.command.log');
const defaultReadinessTimeoutMs = 120000;
const defaultSmokeTimeoutMs = 120000;
const readinessTimeoutMs = parsePositiveIntegerArg(
  process.argv,
  '--readiness-ms',
  defaultReadinessTimeoutMs,
);
const smokeTimeoutMs = parsePositiveIntegerArg(process.argv, '--smoke-ms', defaultSmokeTimeoutMs);

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
  if (hostChild?.opappOutputCaptureRequestedPath && hostChild.opappOutputCaptureRequestedPath !== activeCommandOutputPath) {
    detail += `\n[host-command-tail remapped ${hostChild.opappOutputCaptureRequestedPath} -> ${activeCommandOutputPath}]`;
  }
  if (commandTail) {
    detail += `\n[host-command-tail ${activeCommandOutputPath}]\n${commandTail}`;
  } else if (hostChild?.opappOutputCaptureFailure) {
    detail += `\n[host-command-tail unavailable ${activeCommandOutputPath}] ${hostChild.opappOutputCaptureFailure}`;
  } else if (hostChild?.opappOutputCaptureMode === 'ignore' && hostChild?.opappOutputCapturePath) {
    detail += `\n[host-command-tail unavailable ${activeCommandOutputPath}] direct fallback used stdio=ignore`;
  }

  return detail;
}

async function main() {
  ensureWorkspaceTemp();
  clearDevSessions();
  clearHostLaunchConfig();
  clearHostLog();
  await clearOptionalFile(hostCommandOutputPath);
  stopHostProcesses();
  await writeHostLaunchConfig(`[sessions]\npath=${devSessionsPath}\n\n[main-props]\ndev-smoke-scenario=challenge-advisor-basics\n`);

  let metroChild = null;
  let hostChild = null;

  try {
    const metro = await ensureMetroRunning({reuseIfReady: true, label: 'metro'});
    metroChild = metro.child;
    log('verify-dev', `Metro startup outcome: ${describeMetroOutcome(metro)}`);
    if (metroChild?.opappSpawnMode) {
      log('verify-dev', `Metro spawn mode: ${metroChild.opappSpawnMode}`);
    }

    log('verify-dev', 'launching Windows host against Metro-backed bundle');
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
        await buildHostWaitFailureMessage(ready, 'Metro-backed host readiness', hostChild, {
          hostTailLines: 80,
          commandTailLines: 120,
          timeoutMs: readinessTimeoutMs,
        }),
      );
    }

    const smokeReady = await waitForHostLogMarkers(smokeMarkers, smokeTimeoutMs, {
      failFastOnFatalFrontendError: true,
      failFastCheck: () =>
        detectDeterministicCommandFailureFromHost(hostChild, {
          fallbackOutputPath: hostCommandOutputPath,
        }),
    });
    if (smokeReady.status !== 'matched') {
      throw new Error(
        await buildHostWaitFailureMessage(smokeReady, 'challenge-advisor dev smoke completion', hostChild, {
          hostTailLines: 120,
          commandTailLines: 160,
          timeoutMs: smokeTimeoutMs,
        }),
      );
    }

    log('verify-dev', 'Metro-backed Windows host launched successfully and completed challenge-advisor dev smoke.');
    const tail = await readHostLogTail(40);
    if (tail) {
      log('verify-dev', 'Recent host log tail:');
      console.log(tail);
    }
  } finally {
    clearDevSessions();
    clearHostLaunchConfig();
    stopHostProcesses();
    if (hostChild?.pid) {
      killProcessTree(hostChild.pid);
    }
    if (metroChild?.pid) {
      killProcessTree(metroChild.pid);
    }
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

