import {spawn} from 'node:child_process';
import {mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
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

export function shouldKeepArtifactDir(parsedResult, artifactPaths = []) {
  return hasArtifacts(parsedResult) || artifactPaths.length > 0;
}

function normalizeArtifactPathKey(artifactPath) {
  const normalizedPath = path.normalize(String(artifactPath ?? ''));
  return process.platform === 'win32'
    ? normalizedPath.toLowerCase()
    : normalizedPath;
}

async function listArtifactPaths(artifactDir) {
  try {
    const entries = await readdir(artifactDir, {withFileTypes: true});
    return entries
      .filter(entry => entry.isFile())
      .map(entry => path.join(artifactDir, entry.name))
      .sort((left, right) =>
        left.localeCompare(right, undefined, {
          numeric: true,
          sensitivity: 'base',
        }),
      );
  } catch {
    return [];
  }
}

export function createArtifactProgressReporter(
  artifactDir,
  {
    logger = console.log,
    specName = 'windows-ui-automation',
  } = {},
) {
  const seenArtifactKeys = new Set();

  return {
    announceStart() {
      logger(
        `[windows-ui-automation] debug screenshots enabled for '${specName}'; saving screenshots under ${artifactDir}`,
      );
    },
    async reportNewArtifacts() {
      const artifactPaths = await listArtifactPaths(artifactDir);
      for (const artifactPath of artifactPaths) {
        const artifactKey = normalizeArtifactPathKey(artifactPath);
        if (seenArtifactKeys.has(artifactKey)) {
          continue;
        }

        seenArtifactKeys.add(artifactKey);
        logger(
          `[windows-ui-automation] screenshot saved for '${specName}': ${artifactPath}`,
        );
      }
    },
  };
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
  const tempRoot = process.env.RUNNER_TEMP || os.tmpdir();
  const tempDir = await mkdtemp(path.join(tempRoot, 'opapp-ui-automation-'));
  const artifactDir = await mkdtemp(
    path.join(tempRoot, 'opapp-ui-automation-artifacts-'),
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
  const shouldReportArtifactsDuringRun = Boolean(
    effectiveSpec.debug?.reportArtifactsDuringRun,
  );
  const artifactProgressReporter = shouldReportArtifactsDuringRun
    ? createArtifactProgressReporter(effectiveSpec.debug.artifactDir, {
        specName: effectiveSpec.name,
      })
    : null;

  await writeFile(specPath, JSON.stringify(effectiveSpec, null, 2), 'utf8');

  let stdout = '';
  let stderr = '';
  let settled = false;
  let failFastError = null;
  let keepArtifactDir = false;

  artifactProgressReporter?.announceStart();

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
      await artifactProgressReporter?.reportNewArtifacts();
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

    await artifactProgressReporter?.reportNewArtifacts();

    let parsedResult = null;
    try {
      const raw = await readFile(outputPath, 'utf8');
      parsedResult = JSON.parse(raw.replace(/^\uFEFF/, ''));
    } catch {
      parsedResult = null;
    }

    const artifactPaths = await listArtifactPaths(artifactDir);

    if (exitResult.code !== 0 || parsedResult?.ok === false) {
      keepArtifactDir = shouldKeepArtifactDir(parsedResult, artifactPaths);
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

    keepArtifactDir = shouldKeepArtifactDir(parsedResult, artifactPaths);
    return parsedResult;
  } catch (error) {
    settled = true;
    runner.kill();
    await artifactProgressReporter?.reportNewArtifacts();
    throw error;
  } finally {
    await removeTempDir(tempDir);
    if (!keepArtifactDir) {
      await removeTempDir(artifactDir);
    }
  }
}
