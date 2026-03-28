import {spawnSync} from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';
import {parsePositiveIntegerArg} from './windows-args-common.mjs';

const includeSecondaryWindowOnly = process.argv.includes('--include-secondary-window');
const scenarioFilterToken = process.argv.find(argument => argument.startsWith('--scenario='));
const scenarioFilterArg = scenarioFilterToken?.split('=')[1];
const validateOnly = process.argv.includes('--validate-only');
const launchModeArg = process.argv.find(argument => argument.startsWith('--launch='))?.split('=')[1];
const portableFlag = process.argv.includes('--portable');
const launchMode = portableFlag ? 'portable' : (launchModeArg === 'portable' ? 'portable' : 'packaged');
const defaultReadinessTimeoutMs = 25_000;
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');
const workspaceRoot = path.resolve(repoRoot, '..');
const frontendRoot = path.join(workspaceRoot, 'opapp-frontend');
const smokeScriptPath = path.join(repoRoot, 'tooling', 'scripts', 'windows-release-smoke.mjs');
const readinessTimeoutMs = parsePositiveIntegerArg(
  process.argv,
  '--readiness-ms',
  defaultReadinessTimeoutMs,
);

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
  ];
  runOrThrow(process.execPath, smokeArgs, {
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
  for (const scenario of scenarios) {
    runWindowsSmoke(scenario);
  }
}

function main() {
  const scenarios = resolveScenariosOrThrow();

  log(`repoRoot=${repoRoot}`);
  log(`frontendRoot=${frontendRoot}`);
  log(`includeSecondaryWindowOnly=${includeSecondaryWindowOnly}`);
  log(`scenarioFilterName=${scenarioFilterArg ?? '<all>'}`);
  log(`scenarioCount=${scenarios.length}`);
  log(`validateOnly=${validateOnly}`);
  log(`launchMode=${launchMode}`);
  log(`readinessTimeoutMs=${readinessTimeoutMs}`);

  if (validateOnly) {
    log('validate-only enabled; skipping frontend typecheck and Windows smoke execution.');
    return;
  }

  typecheckFrontend();
  verifyPackagedScenarios(scenarios);
}

main();


