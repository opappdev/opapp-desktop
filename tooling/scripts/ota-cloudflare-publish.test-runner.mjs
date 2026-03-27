import path from 'node:path';
import process from 'node:process';
import {spawnSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(scriptPath);
const repoRoot = path.resolve(scriptDir, '..', '..');
const testFilePath = path.join(scriptDir, 'ota-cloudflare-publish.test.mjs');

function runNode(args) {
  return spawnSync(process.execPath, args, {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

function writeResultOutput(result) {
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
}

const primaryResult = runNode(['--test', testFilePath]);
const hasSpawnEperm =
  primaryResult.error?.code === 'EPERM' ||
  primaryResult.stderr?.includes('spawn EPERM');

if (!hasSpawnEperm) {
  writeResultOutput(primaryResult);
  if (primaryResult.error) {
    console.error(
      `[ota-cloudflare-publish.test-runner] failed to start node --test: ${primaryResult.error.message}`,
    );
    process.exit(1);
  }
  process.exit(primaryResult.status ?? 1);
}

console.warn(
  '[ota-cloudflare-publish.test-runner] node --test hit spawn EPERM; falling back to in-process execution.',
);
await import(pathToFileURL(testFilePath).href);
