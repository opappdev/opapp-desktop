import {spawnSync} from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';

const includeSecondaryWindowOnly = process.argv.includes('--include-secondary-window');
const launchModeArg = process.argv.find(argument => argument.startsWith('--launch='))?.split('=')[1];
const portableFlag = process.argv.includes('--portable');
const launchMode = portableFlag ? 'portable' : (launchModeArg === 'portable' ? 'portable' : 'packaged');
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
  const smokeArgs = [smokeScriptPath, ...scenario.args, `--launch=${launchMode}`];
  runOrThrow(process.execPath, smokeArgs, {
    cwd: repoRoot,
    env: process.env,
  });
}

function verifyPackagedScenarios() {
  const scenarios = includeSecondaryWindowOnly
    ? [secondaryOnlyScenario]
    : defaultScenarios;

  for (const scenario of scenarios) {
    runWindowsSmoke(scenario);
  }
}

function main() {
  log(`repoRoot=${repoRoot}`);
  log(`frontendRoot=${frontendRoot}`);
  log(`includeSecondaryWindowOnly=${includeSecondaryWindowOnly}`);
  log(`launchMode=${launchMode}`);

  typecheckFrontend();
  verifyPackagedScenarios();
}

main();


