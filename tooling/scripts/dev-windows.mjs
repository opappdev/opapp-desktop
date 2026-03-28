import {unlink} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {
  clearHostLaunchConfig,
  clearHostLog,
  detectDeterministicCommandFailureFromHost,
  describeMetroOutcome,
  ensureMetroRunning,
  ensureWorkspaceTemp,
  formatHostCommandTailDetails,
  hostRoot,
  isMetroReady,
  killProcessTree,
  log,
  readFileTail,
  readHostLogTail,
  resolveHostCommandOutputPath,
  spawnCmdAsync,
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
const hostCommandOutputPath = path.join(tempRoot, 'opapp-windows-host.dev.command.log');
const defaultReadinessTimeoutMs = 120000;
const smokeMs = parsePositiveIntegerArg(process.argv, '--smoke-ms', null);
const readinessTimeoutMs = parsePositiveIntegerArg(
  process.argv,
  '--readiness-ms',
  defaultReadinessTimeoutMs,
);

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
      `Windows dev host detected deterministic command failure while waiting for ${phase}: ` +
      `${code} (${summary}). Aborting early instead of waiting ${timeoutMs}ms.` +
      `${spawnModeDetail}${commandOutputPath}`
    );
  }

  if (result.status === 'fatal-frontend-error') {
    const detail = `${result.fatalDiagnostic.event}: ${result.fatalDiagnostic.message}`;
    return `Windows dev host hit a frontend exception while waiting for ${phase}. ${detail}${spawnModeDetail}`;
  }

  return `Windows dev host did not reach ${phase} within ${timeoutMs}ms.${spawnModeDetail}`;
}

async function buildHostWaitFailureMessage(
  result,
  phase,
  hostChild,
  {hostTailLines = 80, commandTailLines = 120, timeoutMs = defaultReadinessTimeoutMs} = {},
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

  const ready = await waitForHostLogMarkers(readinessMarkers, readinessTimeoutMs, {
    failFastOnFatalFrontendError: true,
    failFastCheck: () =>
      detectDeterministicCommandFailureFromHost(hostChild, {
        fallbackOutputPath: hostCommandOutputPath,
      }),
  });
  if (ready.status !== 'matched') {
    throw new Error(
      await buildHostWaitFailureMessage(ready, 'Metro-backed mounted state', hostChild, {
        timeoutMs: readinessTimeoutMs,
      }),
    );
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

