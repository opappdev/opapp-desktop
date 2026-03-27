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
  readHostLogTail,
  spawnCmdAsync,
  writeHostLaunchConfig,
  stopHostProcesses,
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

async function main() {
  ensureWorkspaceTemp();
  clearDevSessions();
  clearHostLaunchConfig();
  clearHostLog();
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
    });
    if (hostChild?.opappSpawnMode) {
      log('verify-dev', `Host spawn mode: ${hostChild.opappSpawnMode}`);
    }

    const ready = await waitForHostLogMarkers(readinessMarkers, 120000, {
      failFastOnFatalFrontendError: true,
    });
    if (ready.status !== 'matched') {
      const tail = await readHostLogTail(80);
      throw new Error(`${describeHostWaitFailure(ready, 'Metro-backed host readiness', hostChild)}\n${tail}`);
    }

    const smokeReady = await waitForHostLogMarkers(smokeMarkers, 120000, {
      failFastOnFatalFrontendError: true,
    });
    if (smokeReady.status !== 'matched') {
      const tail = await readHostLogTail(120);
      throw new Error(
        `${describeHostWaitFailure(smokeReady, 'challenge-advisor dev smoke completion', hostChild)}\n${tail}`,
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

