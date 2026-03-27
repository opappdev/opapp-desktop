import {unlink} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {
  clearDevSessions,
  clearHostLaunchConfig,
  devSessionsPath,
  clearHostLog,
  describeMetroOutcome,
  ensureMetroRunning,
  ensureWorkspaceTemp,
  hostRoot,
  killProcessTree,
  log,
  readFileTail,
  readHostLogTail,
  spawnCmdAsync,
  writeHostLaunchConfig,
  stopHostProcesses,
  tempRoot,
  waitForHostLogMarkers,
} from './windows-dev-common.mjs';

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

function describeHostWaitFailure(result, phase, hostChild) {
  const spawnModeDetail = hostChild?.opappSpawnMode
    ? ` Host spawn mode: ${hostChild.opappSpawnMode}.`
    : '';
  if (result.status === 'fatal-frontend-error') {
    const detail = `${result.fatalDiagnostic.event}: ${result.fatalDiagnostic.message}`;
    return `Windows dev verify hit a frontend exception while waiting for ${phase}. ${detail}${spawnModeDetail}`;
  }

  return `Windows dev verify timed out waiting for ${phase}.${spawnModeDetail}`;
}

function resolveHostCommandOutputPath(hostChild) {
  const candidatePath = hostChild?.opappOutputCapturePath;
  return typeof candidatePath === 'string' && candidatePath.length > 0
    ? candidatePath
    : hostCommandOutputPath;
}

async function clearOptionalFile(targetPath) {
  try {
    await unlink(targetPath);
  } catch {
    // ignore
  }
}

async function buildHostWaitFailureMessage(result, phase, hostChild, {hostTailLines = 80, commandTailLines = 80} = {}) {
  const hostTail = await readHostLogTail(hostTailLines);
  const activeCommandOutputPath = resolveHostCommandOutputPath(hostChild);
  const commandTail = await readFileTail(activeCommandOutputPath, commandTailLines);
  let detail = describeHostWaitFailure(result, phase, hostChild);
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

    const ready = await waitForHostLogMarkers(readinessMarkers, 120000, {
      failFastOnFatalFrontendError: true,
    });
    if (ready.status !== 'matched') {
      throw new Error(
        await buildHostWaitFailureMessage(ready, 'Metro-backed host readiness', hostChild, {
          hostTailLines: 80,
          commandTailLines: 120,
        }),
      );
    }

    const smokeReady = await waitForHostLogMarkers(smokeMarkers, 120000, {
      failFastOnFatalFrontendError: true,
    });
    if (smokeReady.status !== 'matched') {
      throw new Error(
        await buildHostWaitFailureMessage(smokeReady, 'challenge-advisor dev smoke completion', hostChild, {
          hostTailLines: 120,
          commandTailLines: 160,
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

