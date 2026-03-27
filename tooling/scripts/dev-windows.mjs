import {unlink} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {
  clearHostLaunchConfig,
  clearHostLog,
  describeMetroOutcome,
  ensureMetroRunning,
  ensureWorkspaceTemp,
  hostRoot,
  isMetroReady,
  killProcessTree,
  log,
  readFileTail,
  readHostLogTail,
  spawnCmdAsync,
  stopHostProcesses,
  tempRoot,
  waitForHostLogMarkers,
} from './windows-dev-common.mjs';

const readinessMarkers = [
  'Runtime=Metro',
  'InstanceLoaded failed=false',
  '[frontend-companion] mounted',
];
const hostCommandOutputPath = path.join(tempRoot, 'opapp-windows-host.dev.command.log');
const smokeMsArg = process.argv.find(argument => argument.startsWith('--smoke-ms='));
const smokeMs = smokeMsArg ? Number(smokeMsArg.split('=')[1]) : null;

let cleanedUp = false;
let metroChild = null;
let hostChild = null;
let healthCheckRunning = false;
let restartRunning = false;

function cleanup() {
  if (cleanedUp) {
    return;
  }
  cleanedUp = true;
  stopHostProcesses();
  if (hostChild?.pid) {
    killProcessTree(hostChild.pid);
  }
  if (metroChild?.pid) {
    killProcessTree(metroChild.pid);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function clearOptionalFile(targetPath) {
  try {
    await unlink(targetPath);
  } catch {
    // ignore
  }
}

function describeHostWaitFailure(result, phase, hostChild) {
  const spawnModeDetail = hostChild?.opappSpawnMode
    ? ` Host spawn mode: ${hostChild.opappSpawnMode}.`
    : '';
  if (result.status === 'fatal-frontend-error') {
    const detail = `${result.fatalDiagnostic.event}: ${result.fatalDiagnostic.message}`;
    return `Windows dev host hit a frontend exception while waiting for ${phase}. ${detail}${spawnModeDetail}`;
  }

  return `Windows dev host did not reach ${phase} within 120s.${spawnModeDetail}`;
}

function resolveHostCommandOutputPath(hostChild) {
  const candidatePath = hostChild?.opappOutputCapturePath;
  return typeof candidatePath === 'string' && candidatePath.length > 0
    ? candidatePath
    : hostCommandOutputPath;
}

async function buildHostWaitFailureMessage(result, phase, hostChild, {hostTailLines = 80, commandTailLines = 120} = {}) {
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

async function launchHost({label = 'host'} = {}) {
  clearHostLaunchConfig();
  clearHostLog();
  await clearOptionalFile(hostCommandOutputPath);
  stopHostProcesses();
  if (hostChild?.pid) {
    killProcessTree(hostChild.pid);
  }

  log('host', 'launching Windows host against Metro-backed bundle');
  hostChild = await spawnCmdAsync('npm run windows', {
    cwd: hostRoot,
    env: process.env,
    label,
    outputCapturePath: hostCommandOutputPath,
  });
  if (hostChild?.opappSpawnMode) {
    log('host', `spawn mode: ${hostChild.opappSpawnMode}`);
  }

  const ready = await waitForHostLogMarkers(readinessMarkers, 120000, {
    failFastOnFatalFrontendError: true,
  });
  if (ready.status !== 'matched') {
    throw new Error(await buildHostWaitFailureMessage(ready, 'Metro-backed mounted state', hostChild));
  }

  log('host', 'Windows host reached Metro-backed mounted state');
}

async function restartMetroAndHost(reason) {
  if (restartRunning || cleanedUp) {
    return;
  }

  restartRunning = true;
  try {
    log('dev', `Metro is unavailable (${reason}); restarting Metro and relaunching the Windows host`);
    stopHostProcesses();
    if (hostChild?.pid) {
      killProcessTree(hostChild.pid);
    }
    if (metroChild?.pid) {
      killProcessTree(metroChild.pid);
      metroChild = null;
    }

    const metro = await ensureMetroRunning({reuseIfReady: false, label: 'metro'});
    metroChild = metro.child;
    log('dev', `Metro restart outcome: ${describeMetroOutcome(metro)}`);
    await launchHost({label: 'host'});
    log('dev', 'Metro and Windows host restarted successfully.');
  } catch (error) {
    const tail = await readHostLogTail(80);
    const commandTail = await readFileTail(hostCommandOutputPath, 120);
    cleanup();
    console.error(error instanceof Error ? error.message : String(error));
    if (tail) {
      console.error(tail);
    }
    if (commandTail) {
      console.error(`[host-command-tail ${hostCommandOutputPath}]`);
      console.error(commandTail);
    }
    process.exit(1);
  } finally {
    restartRunning = false;
  }
}

async function runHealthCheck() {
  if (healthCheckRunning || restartRunning || cleanedUp || (Number.isFinite(smokeMs) && smokeMs > 0)) {
    return;
  }

  healthCheckRunning = true;
  try {
    if (metroChild?.exitCode != null) {
      await restartMetroAndHost(`Metro process exited with code ${metroChild.exitCode}`);
      return;
    }

    const metroReady = await isMetroReady(800);
    if (!metroReady) {
      await restartMetroAndHost(`port 8081 stopped reporting packager-status:running`);
    }
  } finally {
    healthCheckRunning = false;
  }
}

async function main() {
  ensureWorkspaceTemp();
  clearHostLaunchConfig();
  stopHostProcesses();

  const metro = await ensureMetroRunning({reuseIfReady: true, label: 'metro'});
  metroChild = metro.child;
  log('dev', `Metro startup outcome: ${describeMetroOutcome(metro)}`);
  await launchHost({label: 'host'});

  log('dev', 'Windows host connected to Metro. Fast Refresh is ready.');

  if (Number.isFinite(smokeMs) && smokeMs > 0) {
    log('dev', `smoke mode enabled; keeping the dev loop alive for ${smokeMs}ms before cleanup`);
    await sleep(smokeMs);
    cleanup();
    return;
  }

  log('dev', 'Keep this command running while adjusting UI. Press Ctrl+C to stop the dev loop.');

  const monitor = setInterval(() => {
    void runHealthCheck();
  }, 2500);
  monitor.unref();

  await new Promise(resolve => {
    const shutdown = signal => {
      log('dev', `received ${signal}, stopping dev loop`);
      cleanup();
      resolve();
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  });
}

main().catch(async error => {
  const tail = await readHostLogTail(80);
  const commandTail = await readFileTail(hostCommandOutputPath, 120);
  cleanup();
  console.error(error instanceof Error ? error.message : String(error));
  if (tail) {
    console.error(tail);
  }
  if (commandTail) {
    console.error(`[host-command-tail ${hostCommandOutputPath}]`);
    console.error(commandTail);
  }
  process.exit(1);
});

