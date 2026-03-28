import {spawnSync} from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';
import {parsePositiveIntegerArg} from './windows-args-common.mjs';
import {loadTimeoutDefaultsForLaunch} from './windows-timeout-defaults.mjs';

const includeSecondaryWindowOnly = process.argv.includes('--include-secondary-window');
const scenarioFilterToken = process.argv.find(argument => argument.startsWith('--scenario='));
const scenarioFilterArg = scenarioFilterToken?.split('=')[1];
const validateOnly = process.argv.includes('--validate-only');
const preflightOnly = process.argv.includes('--preflight-only');
const launchModeArg = process.argv.find(argument => argument.startsWith('--launch='))?.split('=')[1];
const portableFlag = process.argv.includes('--portable');
const baseReadinessTimeoutMs = 25_000;
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');
const workspaceRoot = path.resolve(repoRoot, '..');
const frontendRoot = path.join(workspaceRoot, 'opapp-frontend');
const smokeScriptPath = path.join(repoRoot, 'tooling', 'scripts', 'windows-release-smoke.mjs');

const defaultScenarios = [
  {
    name: 'main-window-bootstrap-compact',
    description: 'packaged startup applies saved main window mode',
    args: ['--scenario=main-window-bootstrap-compact'],
  },
  {
    name: 'tab-session',
    description: 'packaged explicit settings tab flow seeds a persisted session',
    args: ['--scenario=tab-session', '--skip-prepare', '--preserve-state'],
  },
  {
    name: 'restore-tab-session',
    description: 'packaged relaunch restores the previously active settings tab without replaying auto-open',
    args: ['--scenario=restore-tab-session', '--skip-prepare', '--preserve-state'],
  },
  {
    name: 'startup-target-main-launcher',
    description: 'saved launcher startup target wins over a restored main-window settings session',
    args: ['--scenario=startup-target-main-launcher', '--skip-prepare'],
  },
  {
    name: 'settings-default-new-window',
    description: 'saved settings preference opens the default settings entry in a detached window and seeds a detached session',
    args: ['--scenario=settings-default-new-window', '--skip-prepare', '--preserve-state', '--reset-sessions'],
  },
  {
    name: 'restore-settings-window',
    description: 'packaged relaunch restores the previously detached settings window session',
    args: ['--scenario=restore-settings-window', '--skip-prepare', '--preserve-state'],
  },
  {
    name: 'save-main-window-preferences',
    description: 'saving settings applies the new main window mode to the current window immediately',
    args: ['--scenario=save-main-window-preferences', '--skip-prepare'],
  },
  {
    name: 'view-shot-current-window',
    description: 'packaged auto-open view-shot lab runs captureRef/captureScreen smoke in the current window',
    args: ['--scenario=view-shot-current-window', '--skip-prepare'],
  },
  {
    name: 'window-capture-current-window',
    description: 'packaged auto-open window-capture lab runs foreground WGC smoke in the current window',
    args: ['--scenario=window-capture-current-window', '--skip-prepare'],
  },
  {
    name: 'secondary-window',
    description: 'startup detached settings window surface-model check',
    args: ['--scenario=secondary-window'],
  },
];

const secondaryOnlyScenario = {
  name: 'secondary-window',
  description: 'startup detached settings window surface-model check',
  args: ['--scenario=secondary-window'],
};
const scenarioByName = new Map(defaultScenarios.map(scenario => [scenario.name, scenario]));
const launchMode = resolveLaunchModeOrThrow();
const timeoutDefaults = loadTimeoutDefaultsForLaunch({
  argv: process.argv,
  launchMode,
});
const timeoutDefaultsPath = timeoutDefaults?.defaultsPath ?? null;
const selectedTimeoutDefaults = timeoutDefaults?.defaults ?? null;
const suggestedVerifyTotalTimeoutMs = selectedTimeoutDefaults?.verifyTotalMs ?? null;
const defaultReadinessTimeoutMs =
  selectedTimeoutDefaults?.readinessMs ?? baseReadinessTimeoutMs;
const readinessTimeoutMs = parsePositiveIntegerArg(
  process.argv,
  '--readiness-ms',
  defaultReadinessTimeoutMs,
);
const smokeTimeoutMs = parsePositiveIntegerArg(
  process.argv,
  '--smoke-ms',
  selectedTimeoutDefaults?.smokeMs ?? readinessTimeoutMs,
);
const startupTimeoutMs = parsePositiveIntegerArg(
  process.argv,
  '--startup-ms',
  selectedTimeoutDefaults?.startupMs ?? smokeTimeoutMs,
);
const scenarioTimeoutMs = parsePositiveIntegerArg(
  process.argv,
  '--scenario-ms',
  selectedTimeoutDefaults?.scenarioMs ?? smokeTimeoutMs,
);

function resolveLaunchModeOrThrow() {
  if (portableFlag) {
    if (launchModeArg && launchModeArg !== 'portable') {
      throw new Error(
        `--portable conflicts with --launch=${launchModeArg}. Use --launch=portable or remove --portable.`,
      );
    }

    return 'portable';
  }

  if (!launchModeArg || launchModeArg === 'packaged') {
    return 'packaged';
  }

  if (launchModeArg === 'portable') {
    return 'portable';
  }

  throw new Error(
    `Unknown --launch=${launchModeArg}. Supported launch modes: packaged, portable.`,
  );
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

function log(message) {
  console.log(`[verify] ${message}`);
}

function runOrThrow(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    windowsHide: false,
    ...options,
  });

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status ?? 1}`);
  }
}

function runCmdOrThrow(args, options = {}) {
  runOrThrow('cmd.exe', ['/d', '/s', '/c', ...args], options);
}

function typecheckFrontend() {
  log(`typechecking frontend at ${frontendRoot}`);

  const env = {
    ...process.env,
    COREPACK_HOME: path.join(workspaceRoot, '.corepack'),
    PNPM_HOME: path.join(workspaceRoot, '.pnpm'),
    TEMP: path.join(workspaceRoot, '.tmp'),
    TMP: path.join(workspaceRoot, '.tmp'),
    npm_config_cache: path.join(workspaceRoot, '.npm-cache'),
  };

  runCmdOrThrow(['corepack', 'pnpm', 'typecheck'], {
    cwd: frontendRoot,
    env,
  });
}

function runWindowsSmoke(scenario) {
  log(`running ${launchMode} Windows smoke: ${scenario.name} (${scenario.description})`);
  const smokeArgs = [
    smokeScriptPath,
    ...scenario.args,
    `--launch=${launchMode}`,
    `--readiness-ms=${readinessTimeoutMs}`,
    `--smoke-ms=${smokeTimeoutMs}`,
    `--startup-ms=${startupTimeoutMs}`,
    `--scenario-ms=${scenarioTimeoutMs}`,
  ];
  const startMs = Date.now();
  runOrThrow(process.execPath, smokeArgs, {
    cwd: repoRoot,
    env: process.env,
  });
  const durationMs = Date.now() - startMs;
  log(`scenario '${scenario.name}' completed in ${durationMs}ms`);
  return durationMs;
}

function runWindowsPreflight(scenarios) {
  const scenarioName = scenarios[0]?.name ?? 'tab-session';
  if (scenarios.length > 1) {
    log(
      `preflight-only ignores multi-scenario execution; using first scenario '${scenarioName}' for smoke-script option validation.`,
    );
  }

  log(`running ${launchMode} Windows preflight diagnostics`);
  const preflightArgs = [
    smokeScriptPath,
    '--preflight-only',
    `--scenario=${scenarioName}`,
    `--launch=${launchMode}`,
    `--readiness-ms=${readinessTimeoutMs}`,
    `--smoke-ms=${smokeTimeoutMs}`,
    `--startup-ms=${startupTimeoutMs}`,
    `--scenario-ms=${scenarioTimeoutMs}`,
  ];
  runOrThrow(process.execPath, preflightArgs, {
    cwd: repoRoot,
    env: process.env,
  });
}

function resolveScenariosOrThrow() {
  const scenarioFilterNames = parseScenarioFilterNames(scenarioFilterArg);
  const hasScenarioFlag = Boolean(scenarioFilterToken);
  const hasScenarioFilter = scenarioFilterNames.length > 0;

  if (
    includeSecondaryWindowOnly &&
    hasScenarioFilter &&
    scenarioFilterNames.some(name => name !== secondaryOnlyScenario.name)
  ) {
    throw new Error(
      `--include-secondary-window conflicts with --scenario=${scenarioFilterArg}. ` +
      `Use --scenario=${secondaryOnlyScenario.name} when selecting a single scenario.`,
    );
  }

  if (hasScenarioFlag && scenarioFilterNames.length === 0) {
    throw new Error('`--scenario=` must include at least one scenario name.');
  }

  if (hasScenarioFilter) {
    const knownScenarioNames = [...scenarioByName.keys()].join(', ');
    const selectedScenarios = [];
    const seen = new Set();
    for (const scenarioName of scenarioFilterNames) {
      const selectedScenario = scenarioByName.get(scenarioName);
      if (!selectedScenario) {
        throw new Error(
          `Unknown --scenario=${scenarioName}. Supported scenarios: ${knownScenarioNames}`,
        );
      }
      if (seen.has(scenarioName)) {
        continue;
      }
      seen.add(scenarioName);
      selectedScenarios.push(selectedScenario);
    }

    return selectedScenarios;
  }

  return includeSecondaryWindowOnly
    ? [secondaryOnlyScenario]
    : defaultScenarios;
}

function verifyPackagedScenarios(scenarios) {
  const scenarioTimings = [];

  for (const scenario of scenarios) {
    const durationMs = runWindowsSmoke(scenario);
    scenarioTimings.push({name: scenario.name, durationMs});
  }

  return scenarioTimings;
}

function main() {
  const scenarios = resolveScenariosOrThrow();

  log(`repoRoot=${repoRoot}`);
  log(`frontendRoot=${frontendRoot}`);
  log(`includeSecondaryWindowOnly=${includeSecondaryWindowOnly}`);
  log(`scenarioFilterName=${scenarioFilterArg ?? '<all>'}`);
  log(`scenarioCount=${scenarios.length}`);
  log(`validateOnly=${validateOnly}`);
  log(`preflightOnly=${preflightOnly}`);
  log(`launchMode=${launchMode}`);
  if (timeoutDefaultsPath) {
    log(`timeoutDefaultsPath=${timeoutDefaultsPath}`);
    log(`timeoutDefaultsLaunch=${selectedTimeoutDefaults.launchMode}`);
    if (suggestedVerifyTotalTimeoutMs !== null) {
      log(`timeoutDefaultsVerifyTotalMs=${suggestedVerifyTotalTimeoutMs}`);
    }
  }
  log(`readinessTimeoutMs=${readinessTimeoutMs}`);
  log(`smokeTimeoutMs=${smokeTimeoutMs}`);
  log(`startupTimeoutMs=${startupTimeoutMs}`);
  log(`scenarioTimeoutMs=${scenarioTimeoutMs}`);

  if (validateOnly && preflightOnly) {
    throw new Error('`--validate-only` conflicts with `--preflight-only`; choose one execution mode.');
  }

  if (validateOnly) {
    log('validate-only enabled; skipping frontend typecheck and Windows smoke execution.');
    return;
  }

  if (preflightOnly) {
    log('preflight-only enabled; skipping frontend typecheck and running release diagnostics only.');
    runWindowsPreflight(scenarios);
    return;
  }

  typecheckFrontend();
  const scenarioTimings = verifyPackagedScenarios(scenarios);
  const totalDurationMs = scenarioTimings.reduce((sum, item) => sum + item.durationMs, 0);
  log(`scenario timing summary totalMs=${totalDurationMs} scenarioCount=${scenarioTimings.length}`);
}

main();


