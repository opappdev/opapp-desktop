import {spawnSync} from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');
const hostRoot = path.join(repoRoot, 'hosts', 'windows-host');
const runWindowsCliWrapperPath = path.join(repoRoot, 'tooling', 'scripts', 'run-windows-cli-wrapper.cjs');
const releaseArgs = [
  runWindowsCliWrapperPath,
  '--release',
  '--no-packager',
  '--no-launch',
  '--logging',
  '--no-telemetry',
  ...process.argv.slice(2),
];

console.log(`[raw-release] hostRoot=${hostRoot}`);
console.log(`[raw-release] command=${process.execPath} ${releaseArgs.join(' ')}`);

const result = spawnSync(process.execPath, releaseArgs, {
  cwd: hostRoot,
  env: process.env,
  stdio: 'inherit',
  windowsHide: false,
});

if (result.error) {
  console.error(result.error instanceof Error ? result.error.message : String(result.error));
  process.exit(1);
}

process.exit(result.status ?? 1);
