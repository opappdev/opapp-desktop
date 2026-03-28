import {readFile, unlink} from 'node:fs/promises';
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
  formatHostCommandTailDetails,
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
  writeHostLaunchConfig,
} from './windows-dev-common.mjs';
import {parsePositiveIntegerArg} from './windows-args-common.mjs';
import {assertPngCaptureLooksOpaque} from './windows-image-inspection.mjs';

const scenarioFilterToken = process.argv.find(argument => argument.startsWith('--scenario='));
const scenarioFilterArg = scenarioFilterToken?.split('=')[1];
const validateOnly = process.argv.includes('--validate-only');

const readinessMarkers = [
  'Runtime=Metro',
  'InstanceLoaded failed=false',
  '[frontend-companion] mounted',
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

const defaultScenarios = [
  {
    name: 'challenge-advisor-basics',
    description:
      'Metro-backed main surface runs the challenge-advisor dev smoke flow',
    smokeMarkers: [
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
    ],
    launchConfig: {
      mainProps: {
        'dev-smoke-scenario': 'challenge-advisor-basics',
      },
    },
    successSummary:
      'Metro-backed Windows host completed challenge-advisor dev smoke.',
  },
  {
    name: 'view-shot-current-window',
    description:
      'Metro-backed auto-open view-shot lab runs captureRef/captureScreen smoke in the current window',
    smokeMarkers: [
      'InitialOpenSurface surface=companion.view-shot policy=tool presentation=current-window',
      '[frontend-companion] auto-open window=window.main surface=companion.view-shot presentation=current-window',
      '[frontend-companion] render window=window.main surface=companion.view-shot policy=tool',
      '[frontend-companion] mounted window=window.main surface=companion.view-shot policy=tool',
      '[frontend-companion] session window=window.main tabs=1 active=tab:companion.main:1 entries=tab:companion.main:1:companion.view-shot',
      '[frontend-view-shot] dev-smoke-start',
      '[frontend-view-shot] dev-smoke-capture-ref uri=',
      '[frontend-view-shot] dev-smoke-inspection-ref uri=',
      '[frontend-view-shot] dev-smoke-component-data-uri prefix=data:image/png;base64, length=',
      '[frontend-view-shot] dev-smoke-jpg-quality low=',
      '[frontend-view-shot] dev-smoke-capture-screen uri=',
      '[frontend-view-shot] dev-smoke-release-complete',
      '[frontend-view-shot] dev-smoke-complete',
    ],
    launchConfig: {
      initialOpen: {
        surface: 'companion.view-shot',
        policy: 'tool',
        presentation: 'current-window',
      },
      initialOpenProps: {
        'dev-smoke-scenario': 'view-shot-basics',
      },
    },
    async verifyLog(logContents) {
      assertLogContainsRegex(
        logContents,
        /\[frontend-view-shot\] dev-smoke-capture-ref uri=.*OPApp[\\/]+view-shot[\\/]+/i,
        'view-shot dev smoke did not produce a tmpfile captureRef artifact under the managed host directory.',
      );
      const inspectionCapturePath = extractLoggedPath(
        logContents,
        /\[frontend-view-shot\] dev-smoke-inspection-ref uri=([^\r\n]+)/i,
        'view-shot dev smoke did not produce an inspection tmpfile artifact under the managed host directory.',
      );
      try {
        const inspectionStats = assertPngCaptureLooksOpaque(
          inspectionCapturePath,
          'Windows dev verify view-shot inspection capture',
        );
        log(
          'verify-dev',
          `view-shot inspection OK: path=${inspectionCapturePath} opaqueSamples=${inspectionStats.opaqueSamples}/${inspectionStats.sampleCount} distinctSamples=${inspectionStats.distinctSampleCount} averageAlpha=${inspectionStats.averageAlpha}`,
        );
      } finally {
        await clearOptionalFile(inspectionCapturePath);
      }
      assertLogContainsRegex(
        logContents,
        /\[frontend-view-shot\] dev-smoke-component-data-uri prefix=data:image\/png;base64, length=\d+/i,
        'view-shot dev smoke did not produce a PNG data-uri from ViewShot.capture.',
      );
      const jpgQualityMatch = normalizeLogContents(logContents).match(
        /\[frontend-view-shot\] dev-smoke-jpg-quality low=(\d+) high=(\d+)/i,
      );
      if (!jpgQualityMatch) {
        throw new Error(
          'Windows dev verify failed: view-shot dev smoke did not emit the JPG quality summary marker.',
        );
      }
      const lowQualityLength = Number(jpgQualityMatch[1]);
      const highQualityLength = Number(jpgQualityMatch[2]);
      if (!Number.isFinite(lowQualityLength) || !Number.isFinite(highQualityLength)) {
        throw new Error(
          'Windows dev verify failed: view-shot dev smoke emitted an invalid JPG quality summary marker.',
        );
      }
      if (highQualityLength <= lowQualityLength) {
        throw new Error(
          'Windows dev verify failed: high-quality JPG capture was not larger than low-quality JPG capture.',
        );
      }
      assertLogContainsRegex(
        logContents,
        /\[frontend-view-shot\] dev-smoke-capture-screen uri=.*OPApp[\\/]+view-shot[\\/]+/i,
        'view-shot dev smoke did not produce a tmpfile captureScreen artifact under the managed host directory.',
      );
    },
    successSummary:
      'Metro-backed Windows host completed view-shot dev smoke.',
  },
  {
    name: 'window-capture-current-window',
    description:
      'Metro-backed auto-open window-capture lab runs foreground WGC smoke in the current window',
    smokeMarkers: [
      'InitialOpenSurface surface=companion.window-capture policy=tool presentation=current-window',
      '[frontend-companion] auto-open window=window.main surface=companion.window-capture presentation=current-window',
      '[frontend-companion] render window=window.main surface=companion.window-capture policy=tool',
      '[frontend-companion] mounted window=window.main surface=companion.window-capture policy=tool',
      '[frontend-companion] session window=window.main tabs=1 active=tab:companion.main:1 entries=tab:companion.main:1:companion.window-capture',
      '[frontend-window-capture] dev-smoke-start',
      '[frontend-window-capture] dev-smoke-list count=',
      '[frontend-window-capture] dev-smoke-capture-window backend=wgc size=',
      '[frontend-window-capture] dev-smoke-capture-client backend=wgc crop=',
      '[frontend-window-capture] dev-smoke-complete',
    ],
    launchConfig: {
      initialOpen: {
        surface: 'companion.window-capture',
        policy: 'tool',
        presentation: 'current-window',
      },
      initialOpenProps: {
        'dev-smoke-scenario': 'window-capture-basics',
      },
    },
    async verifyLog(logContents) {
      assertLogContainsRegex(
        logContents,
        /\[frontend-window-capture\] dev-smoke-list count=\d+ handle=0x[0-9a-f]+ process=/i,
        'window-capture dev smoke did not list a foreground window.',
      );
      assertLogContainsRegex(
        logContents,
        /\[frontend-window-capture\] dev-smoke-capture-window backend=wgc size=\d+x\d+ path=.*OPApp[\\/]+window-capture[\\/]+/i,
        'window-capture dev smoke did not produce a WGC window capture under the managed host directory.',
      );
      const windowCapturePath = extractLoggedPath(
        logContents,
        /\[frontend-window-capture\] dev-smoke-capture-window backend=wgc size=\d+x\d+ path=([^\r\n]+)/i,
        'window-capture dev smoke did not emit the window capture path.',
      );
      try {
        const inspectionStats = assertPngCaptureLooksOpaque(
          windowCapturePath,
          'Windows dev verify window-capture window capture',
        );
        log(
          'verify-dev',
          `window-capture window OK: path=${windowCapturePath} opaqueSamples=${inspectionStats.opaqueSamples}/${inspectionStats.sampleCount} distinctSamples=${inspectionStats.distinctSampleCount} averageAlpha=${inspectionStats.averageAlpha}`,
        );
      } finally {
        await clearOptionalFile(windowCapturePath);
      }
      assertLogContainsRegex(
        logContents,
        /\[frontend-window-capture\] dev-smoke-capture-client backend=wgc crop=\d+x\d+ path=.*OPApp[\\/]+window-capture[\\/]+/i,
        'window-capture dev smoke did not produce a WGC client capture under the managed host directory.',
      );
      const clientCapturePath = extractLoggedPath(
        logContents,
        /\[frontend-window-capture\] dev-smoke-capture-client backend=wgc crop=\d+x\d+ path=([^\r\n]+)/i,
        'window-capture dev smoke did not emit the client capture path.',
      );
      try {
        const inspectionStats = assertPngCaptureLooksOpaque(
          clientCapturePath,
          'Windows dev verify window-capture client capture',
        );
        log(
          'verify-dev',
          `window-capture client OK: path=${clientCapturePath} opaqueSamples=${inspectionStats.opaqueSamples}/${inspectionStats.sampleCount} distinctSamples=${inspectionStats.distinctSampleCount} averageAlpha=${inspectionStats.averageAlpha}`,
        );
      } finally {
        await clearOptionalFile(clientCapturePath);
      }
    },
    successSummary:
      'Metro-backed Windows host completed window-capture dev smoke.',
  },
];

const scenarioByName = new Map(defaultScenarios.map(scenario => [scenario.name, scenario]));

function normalizeLogContents(logContents) {
  return logContents.replace(/\r/g, '');
}

function assertLogContainsRegex(logContents, regex, reason) {
  if (!regex.test(normalizeLogContents(logContents))) {
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

function buildLaunchConfigForScenario(scenario) {
  let content = `[sessions]\npath=${devSessionsPath}\n`;
  content = appendConfigSection(content, 'main-props', scenario.launchConfig.mainProps);
  content = appendConfigSection(content, 'initial-open', scenario.launchConfig.initialOpen);
  content = appendConfigSection(
    content,
    'initial-open-props',
    scenario.launchConfig.initialOpenProps,
  );
  return content;
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

async function prepareScenarioRun(scenario) {
  log('verify-dev', `preparing scenario '${scenario.name}'`);
  stopHostProcesses();
  clearDevSessions();
  clearHostLaunchConfig();
  clearHostLog();
  await clearOptionalFile(hostCommandOutputPath);
  await writeHostLaunchConfig(buildLaunchConfigForScenario(scenario));
}

async function runDevScenario(scenario) {
  await prepareScenarioRun(scenario);

  let hostChild = null;
  const scenarioStartMs = Date.now();

  try {
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

    const smokeReady = await waitForHostLogMarkers(scenario.smokeMarkers, smokeTimeoutMs, {
      failFastOnFatalFrontendError: true,
      failFastCheck: () =>
        detectDeterministicCommandFailureFromHost(hostChild, {
          fallbackOutputPath: hostCommandOutputPath,
        }),
    });
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

    const durationMs = Date.now() - scenarioStartMs;
    const logContents = await readFile(hostLogPath, 'utf8');
    await scenario.verifyLog?.(logContents);
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
  }
}

async function main() {
  const scenarios = resolveScenariosOrThrow();

  ensureWorkspaceTemp();
  clearDevSessions();
  clearHostLaunchConfig();
  clearHostLog();
  await clearOptionalFile(hostCommandOutputPath);
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
