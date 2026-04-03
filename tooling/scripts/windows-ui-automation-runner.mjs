import {spawn} from 'node:child_process';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const powershellRunnerPath = path.join(
  scriptDir,
  'windows-ui-automation.ps1',
);

function formatRunnerFailure({
  message,
  stdout = '',
  stderr = '',
  parsedResult = null,
}) {
  const segments = [message];

  if (parsedResult?.error?.message) {
    segments.push(parsedResult.error.message);
  }

  const artifactPaths = [
    ...(parsedResult?.error?.artifacts ?? []),
    ...(parsedResult?.artifacts ?? []),
  ]
    .map(artifact =>
      typeof artifact === 'string' ? artifact : artifact?.path,
    )
    .filter(Boolean);
  if (artifactPaths.length > 0) {
    segments.push(`artifacts:\n${artifactPaths.join('\n')}`);
  }

  const trimmedStdout = stdout.trim();
  const trimmedStderr = stderr.trim();
  if (trimmedStdout) {
    segments.push(`stdout:\n${trimmedStdout}`);
  }
  if (trimmedStderr) {
    segments.push(`stderr:\n${trimmedStderr}`);
  }

  return segments.join('\n\n');
}

function hasArtifacts(parsedResult) {
  return Boolean(
    parsedResult?.artifacts?.length || parsedResult?.error?.artifacts?.length,
  );
}

async function removeTempDir(tempDir) {
  await rm(tempDir, {recursive: true, force: true});
}

export async function runWindowsUiAutomation(
  spec,
  {
    pollIntervalMs = 250,
    failFastCheck = null,
    failFastMessage = 'Windows UI automation aborted early.',
  } = {},
) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opapp-ui-automation-'));
  const artifactDir = await mkdtemp(
    path.join(os.tmpdir(), 'opapp-ui-automation-artifacts-'),
  );
  const specPath = path.join(tempDir, 'spec.json');
  const outputPath = path.join(tempDir, 'result.json');
  const effectiveSpec = {
    ...spec,
    debug: {
      captureOnFailure: true,
      ...(spec?.debug ?? {}),
      artifactDir: spec?.debug?.artifactDir ?? artifactDir,
    },
  };

  await writeFile(specPath, JSON.stringify(effectiveSpec, null, 2), 'utf8');

  let stdout = '';
  let stderr = '';
  let settled = false;
  let failFastError = null;
  let keepArtifactDir = false;

  const runner = spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      powershellRunnerPath,
      '-SpecPath',
      specPath,
      '-OutputPath',
      outputPath,
    ],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );

  runner.stdout.setEncoding('utf8');
  runner.stderr.setEncoding('utf8');
  runner.stdout.on('data', chunk => {
    stdout += chunk;
  });
  runner.stderr.on('data', chunk => {
    stderr += chunk;
  });

  const poller = (async () => {
    while (!settled) {
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
      if (settled || typeof failFastCheck !== 'function') {
        continue;
      }

      const failure = await failFastCheck();
      if (!failure) {
        continue;
      }

      settled = true;
      failFastError = new Error(
        typeof failure === 'string'
          ? `${failFastMessage} ${failure}`
          : failFastMessage,
      );
      runner.kill();
      return;
    }
  })();

  try {
    const exitResult = await new Promise((resolve, reject) => {
      runner.once('error', reject);
      runner.once('exit', (code, signal) => {
        resolve({code, signal});
      });
    });

    settled = true;
    await poller;

    if (failFastError) {
      throw failFastError;
    }

    let parsedResult = null;
    try {
      const raw = await readFile(outputPath, 'utf8');
      parsedResult = JSON.parse(raw.replace(/^\uFEFF/, ''));
    } catch {
      parsedResult = null;
    }

    if (exitResult.code !== 0 || parsedResult?.ok === false) {
      keepArtifactDir = hasArtifacts(parsedResult);
      throw new Error(
        formatRunnerFailure({
          message:
            exitResult.signal
              ? `Windows UI automation exited via signal ${exitResult.signal}.`
              : `Windows UI automation exited with code ${exitResult.code ?? 1}.`,
          stdout,
          stderr,
          parsedResult,
        }),
      );
    }

    if (!parsedResult?.ok) {
      throw new Error(
        formatRunnerFailure({
          message: 'Windows UI automation did not return a valid result payload.',
          stdout,
          stderr,
        }),
      );
    }

    keepArtifactDir = hasArtifacts(parsedResult);
    return parsedResult;
  } catch (error) {
    settled = true;
    runner.kill();
    throw error;
  } finally {
    await removeTempDir(tempDir);
    if (!keepArtifactDir) {
      await removeTempDir(artifactDir);
    }
  }
}
