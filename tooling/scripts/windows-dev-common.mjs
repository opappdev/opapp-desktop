import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {spawn, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(scriptDir, '..', '..');
export const workspaceRoot = path.resolve(repoRoot, '..');
export const frontendRoot = path.join(workspaceRoot, 'opapp-frontend');
export const hostRoot = path.join(repoRoot, 'hosts', 'windows-host');
export const tempRoot = path.join(workspaceRoot, '.tmp');
export const hostLogPath = path.join(os.tmpdir(), 'opapp-windows-host.log');
export const launchConfigPath = path.join(os.tmpdir(), 'opapp-windows-host.launch.ini');
export const devSessionsPath = path.join(os.tmpdir(), 'opapp-windows-host.dev.sessions.ini');
export const metroPort = 8081;
const frontendDiagnosticPrefix = '[frontend-diagnostics] ';

export function log(scope, message) {
  console.log(`[${scope}] ${message}`);
}

export function buildFrontendEnv() {
  return {
    ...process.env,
    COREPACK_HOME: path.join(workspaceRoot, '.corepack'),
    PNPM_HOME: path.join(workspaceRoot, '.pnpm'),
    TEMP: tempRoot,
    TMP: tempRoot,
    npm_config_cache: path.join(workspaceRoot, '.npm-cache'),
  };
}

export function ensureWorkspaceTemp() {
  fs.mkdirSync(tempRoot, {recursive: true});
}

function pipeStream(stream, label) {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', chunk => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line.length > 0) {
        log(label, line);
      }
    }
  });
  stream.on('end', () => {
    if (buffer.length > 0) {
      log(label, buffer);
      buffer = '';
    }
  });
}

export function spawnCmd(command, {cwd, env, label}) {
  return createCmdChild(command, {cwd, env, label});
}

function createCmdChild(command, {cwd, env, label}) {
  const child = spawn('cmd.exe', ['/d', '/s', '/c', command], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false,
  });
  child.opappSpawnMode = 'cmd.exe (stdio=pipe)';

  pipeStream(child.stdout, label);
  pipeStream(child.stderr, label);
  return child;
}

function createDirectChild(
  command,
  args,
  {cwd, env, label, stdioMode = 'pipe', outputCapturePath = null},
) {
  let stdio = ['ignore', 'pipe', 'pipe'];
  let captureFd = null;
  if (stdioMode === 'ignore') {
    stdio = 'ignore';
  } else if (stdioMode === 'capture-file') {
    if (!outputCapturePath) {
      throw new Error(`missing outputCapturePath for capture-file mode (${command})`);
    }
    fs.mkdirSync(path.dirname(outputCapturePath), {recursive: true});
    captureFd = fs.openSync(outputCapturePath, 'w');
    stdio = ['ignore', captureFd, captureFd];
  }

  try {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio,
      windowsHide: false,
    });
    child.opappSpawnMode = `${command} (stdio=${stdioMode})`;

    if (stdioMode === 'pipe') {
      pipeStream(child.stdout, label);
      pipeStream(child.stderr, label);
    }
    return child;
  } finally {
    if (captureFd !== null) {
      try {
        fs.closeSync(captureFd);
      } catch {
        // ignore best-effort descriptor cleanup
      }
    }
  }
}

function parseCommandTokens(command) {
  const tokens = String(command ?? '')
    .match(/"[^"]*"|[^\s]+/g)
    ?.map(token => token.replace(/^"|"$/g, ''));
  return tokens?.filter(Boolean) ?? [];
}

export function resolveOutputCaptureCandidates(outputCapturePath, {tmpDir = os.tmpdir()} = {}) {
  if (!outputCapturePath) {
    return [];
  }

  const candidates = [];
  const seen = new Set();
  const addCandidate = candidatePath => {
    if (!candidatePath) {
      return;
    }
    const normalizedPath = path.normalize(candidatePath);
    const dedupeKey = process.platform === 'win32'
      ? normalizedPath.toLowerCase()
      : normalizedPath;
    if (seen.has(dedupeKey)) {
      return;
    }
    seen.add(dedupeKey);
    candidates.push(normalizedPath);
  };

  addCandidate(outputCapturePath);
  addCandidate(path.join(tmpDir, path.basename(outputCapturePath)));
  return candidates;
}

function resolveCorepackScriptPath() {
  const execDir = path.dirname(process.execPath);
  const candidates = [
    path.join(execDir, 'node_modules', 'corepack', 'dist', 'corepack.js'),
    path.join(execDir, '..', 'node_modules', 'corepack', 'dist', 'corepack.js'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function resolveNpmCliScriptPath() {
  const execDir = path.dirname(process.execPath);
  const candidates = [
    path.join(execDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(execDir, '..', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function waitForChildSpawn(child) {
  return new Promise((resolve, reject) => {
    const onSpawn = () => {
      cleanup();
      resolve();
    };
    const onError = error => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      child.off('spawn', onSpawn);
      child.off('error', onError);
    };

    child.once('spawn', onSpawn);
    child.once('error', onError);
  });
}

function isRetriableSpawnError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return error?.code === 'EPERM' || message.includes('spawn EPERM');
}

async function spawnDirectFallback(command, {cwd, env, label, outputCapturePath = null}) {
  const tokens = parseCommandTokens(command);
  if (tokens.length === 0) {
    return null;
  }

  const [baseCommand, ...baseArgs] = tokens;
  const fallbackAttempts = [{command: baseCommand, args: baseArgs}];
  const normalizedBaseCommand = baseCommand.toLowerCase();

  if (process.platform === 'win32' && !normalizedBaseCommand.endsWith('.cmd')) {
    fallbackAttempts.push({command: `${baseCommand}.cmd`, args: baseArgs});
  }

  if (normalizedBaseCommand === 'corepack' || normalizedBaseCommand === 'corepack.cmd') {
    const corepackScriptPath = resolveCorepackScriptPath();
    if (corepackScriptPath) {
      fallbackAttempts.push({
        command: process.execPath,
        args: [corepackScriptPath, ...baseArgs],
      });
    }
  }

  if (normalizedBaseCommand === 'npm' || normalizedBaseCommand === 'npm.cmd') {
    const npmCliScriptPath = resolveNpmCliScriptPath();
    if (npmCliScriptPath) {
      fallbackAttempts.push({
        command: process.execPath,
        args: [npmCliScriptPath, ...baseArgs],
      });
    }
  }

  const outputCaptureCandidates = resolveOutputCaptureCandidates(outputCapturePath);
  const errors = [];
  for (const attempt of fallbackAttempts) {
    try {
      const child = createDirectChild(attempt.command, attempt.args, {
        cwd,
        env,
        label,
        stdioMode: 'pipe',
      });
      await waitForChildSpawn(child);
      log(
        label,
        `spawn fallback engaged (without cmd.exe): ${attempt.command} ${attempt.args.join(' ')}`.trim(),
      );
      child.opappOutputCaptureMode = 'pipe';
      if (outputCapturePath) {
        child.opappOutputCapturePath = outputCapturePath;
        child.opappOutputCaptureRequestedPath = outputCapturePath;
      }
      return child;
    } catch (error) {
      errors.push(`${attempt.command}: ${error instanceof Error ? error.message : String(error)}`);
      if (isRetriableSpawnError(error)) {
        const captureFileFailures = [];
        if (outputCaptureCandidates.length > 0) {
          for (const captureCandidatePath of outputCaptureCandidates) {
            try {
              const child = createDirectChild(attempt.command, attempt.args, {
                cwd,
                env,
                label,
                stdioMode: 'capture-file',
                outputCapturePath: captureCandidatePath,
              });
              await waitForChildSpawn(child);
              log(
                label,
                `spawn fallback engaged (without cmd.exe, stdio=capture-file): ${attempt.command} ${attempt.args.join(' ')}`.trim(),
              );
              if (captureCandidatePath !== outputCapturePath) {
                log(
                  label,
                  `capture-file output path fallback: ${outputCapturePath} -> ${captureCandidatePath}`,
                );
              }
              child.opappOutputCaptureMode = 'capture-file';
              child.opappOutputCapturePath = captureCandidatePath;
              if (outputCapturePath) {
                child.opappOutputCaptureRequestedPath = outputCapturePath;
              }
              return child;
            } catch (captureError) {
              const captureFileFailure = captureError instanceof Error ? captureError.message : String(captureError);
              captureFileFailures.push(`${captureCandidatePath}: ${captureFileFailure}`);
              errors.push(
                `${attempt.command} (stdio=capture-file @ ${captureCandidatePath}): ${captureFileFailure}`,
              );
              log(
                label,
                `stdio=capture-file fallback failed for ${attempt.command} @ ${captureCandidatePath}: ${captureFileFailure}`,
              );
            }
          }
        }

        try {
          const child = createDirectChild(attempt.command, attempt.args, {
            cwd,
            env,
            label,
            stdioMode: 'ignore',
          });
          await waitForChildSpawn(child);
          log(
            label,
            `spawn fallback engaged (without cmd.exe, stdio=ignore): ${attempt.command} ${attempt.args.join(' ')}`.trim(),
          );
          child.opappOutputCaptureMode = 'ignore';
          if (outputCaptureCandidates.length > 0) {
            child.opappOutputCapturePath = outputCaptureCandidates[0];
          }
          if (outputCapturePath) {
            child.opappOutputCaptureRequestedPath = outputCapturePath;
          }
          if (captureFileFailures.length > 0) {
            child.opappOutputCaptureFailure = captureFileFailures.join(' | ');
          }
          return child;
        } catch (ignoreError) {
          errors.push(
            `${attempt.command} (stdio=ignore): ${ignoreError instanceof Error ? ignoreError.message : String(ignoreError)}`,
          );
        }
      }
    }
  }

  throw new Error(
    `direct spawn fallback failed for "${command}": ${errors.join('; ')}`,
  );
}

export async function spawnCmdAsync(
  command,
  {cwd, env, label, maxAttempts = 3, retryDelayMs = 1500, outputCapturePath = null},
) {
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const child = createCmdChild(command, {cwd, env, label});
      await waitForChildSpawn(child);
      return child;
    } catch (error) {
      lastError = error;
      if (!isRetriableSpawnError(error)) {
        throw error;
      }
      try {
        const fallbackChild = await spawnDirectFallback(command, {
          cwd,
          env,
          label,
          outputCapturePath,
        });
        if (fallbackChild) {
          return fallbackChild;
        }
      } catch (fallbackError) {
        lastError = fallbackError;
        if (!isRetriableSpawnError(fallbackError)) {
          throw fallbackError;
        }
      }
      if (attempt >= maxAttempts) {
        throw lastError;
      }
      log(label, `spawn EPERM on attempt ${attempt}/${maxAttempts}; retrying in ${retryDelayMs}ms`);
      await sleep(retryDelayMs);
    }
  }
  throw lastError ?? new Error(`failed to spawn command: ${command}`);
}

export function killProcessTree(pid) {
  if (!pid) {
    return;
  }

  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
    stdio: 'ignore',
    windowsHide: true,
  });
}

export function stopHostProcesses() {
  spawnSync('taskkill', ['/IM', 'OpappWindowsHost.exe', '/T', '/F'], {
    stdio: 'ignore',
    windowsHide: true,
  });
}

export function clearHostLog() {
  try {
    fs.unlinkSync(hostLogPath);
  } catch {
    // ignore
  }
}

export function clearHostLaunchConfig() {
  try {
    fs.unlinkSync(launchConfigPath);
  } catch {
    // ignore
  }
}

export async function writeHostLaunchConfig(content) {
  await fsp.writeFile(launchConfigPath, content, 'utf8');
}

export function clearDevSessions() {
  try {
    fs.unlinkSync(devSessionsPath);
  } catch {
    // ignore
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function getListeningPids(port) {
  const result = spawnSync('netstat', ['-ano', '-p', 'tcp'], {
    stdio: ['ignore', 'pipe', 'ignore'],
    encoding: 'utf8',
    windowsHide: true,
  });

  const stdout = result.stdout ?? '';
  const pids = new Set();
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || !line.startsWith('TCP')) {
      continue;
    }

    const parts = line.split(/\s+/);
    if (parts.length < 5) {
      continue;
    }

    const localAddress = parts[1] ?? '';
    const state = (parts[3] ?? '').toUpperCase();
    const pid = Number(parts[4]);
    if (!localAddress.endsWith(`:${port}`) || state !== 'LISTENING' || !Number.isFinite(pid)) {
      continue;
    }

    pids.add(pid);
  }

  return [...pids];
}

export async function waitFor(predicate, timeoutMs, intervalMs = 250) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) {
      return true;
    }
    await sleep(intervalMs);
  }
  return false;
}

export async function waitForPortToBeFree(port, timeoutMs = 5000) {
  return waitFor(() => getListeningPids(port).length === 0, timeoutMs, 200);
}

export async function killPortOwners(port, {label = 'metro'} = {}) {
  const owners = getListeningPids(port);
  if (owners.length === 0) {
    return [];
  }

  log(label, `port ${port} is occupied by pid(s) ${owners.join(', ')}; stopping them before restart`);
  for (const pid of owners) {
    killProcessTree(pid);
  }

  await waitForPortToBeFree(port, 5000);
  return owners;
}

export function isMetroReady(timeoutMs = 1500) {
  return new Promise(resolve => {
    const req = http.get(
      {
        hostname: '127.0.0.1',
        port: metroPort,
        path: '/status',
        timeout: timeoutMs,
      },
      res => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', chunk => {
          body += chunk;
        });
        res.on('end', () => {
          resolve(body.includes('packager-status:running'));
        });
      },
    );

    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitForMetroReadyOrExit(child, timeoutMs = 60000) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    if (await isMetroReady()) {
      return {ready: true, exited: false};
    }

    if (child.exitCode != null) {
      return {ready: false, exited: true, exitCode: child.exitCode};
    }

    await sleep(500);
  }

  return {ready: false, exited: child.exitCode != null, exitCode: child.exitCode};
}

export function describeMetroOutcome(outcome) {
  switch (outcome.action) {
    case 'reused-existing':
      return `reused existing Metro on :${metroPort}`;
    case 'reused-after-grace':
      return `reused healthy Metro on :${metroPort} after re-check`;
    case 'started-new':
      return `started new Metro on :${metroPort}`;
    case 'restarted-after-kill':
      return `killed stale listener(s) ${outcome.killedPids.join(', ')} and started new Metro on :${metroPort}`;
    default:
      return `Metro outcome: ${outcome.action}`;
  }
}

export async function ensureMetroRunning({reuseIfReady = true, label = 'metro'} = {}) {
  if (reuseIfReady && (await isMetroReady())) {
    const outcome = {child: null, reused: true, action: 'reused-existing', killedPids: []};
    log(label, describeMetroOutcome(outcome));
    return outcome;
  }

  const owners = getListeningPids(metroPort);
  if (owners.length > 0) {
    log(label, `port ${metroPort} already has listener(s): ${owners.join(', ')}`);

    if (reuseIfReady) {
      const healthyAfterGrace = await waitFor(() => isMetroReady(), 3000, 300);
      if (healthyAfterGrace) {
        const outcome = {child: null, reused: true, action: 'reused-after-grace', killedPids: []};
        log(label, describeMetroOutcome(outcome));
        return outcome;
      }
    }

    const killedPids = await killPortOwners(metroPort, {label});
    const child = await spawnCmdAsync('corepack pnpm start:companion:windows', {
      cwd: frontendRoot,
      env: buildFrontendEnv(),
      label,
    });

    const result = await waitForMetroReadyOrExit(child, 60000);
    if (!result.ready) {
      killProcessTree(child.pid);
      await killPortOwners(metroPort, {label});
      const exitSuffix = result.exited ? ` (Metro process exited with code ${result.exitCode ?? 'unknown'})` : '';
      throw new Error(`Metro did not become ready on port ${metroPort} within 60s${exitSuffix}`);
    }

    const outcome = {child, reused: false, action: 'restarted-after-kill', killedPids};
    log(label, describeMetroOutcome(outcome));
    return outcome;
  }

  const child = await spawnCmdAsync('corepack pnpm start:companion:windows', {
    cwd: frontendRoot,
    env: buildFrontendEnv(),
    label,
  });

  const result = await waitForMetroReadyOrExit(child, 60000);
  if (!result.ready) {
    killProcessTree(child.pid);
    await killPortOwners(metroPort, {label});
    const exitSuffix = result.exited ? ` (Metro process exited with code ${result.exitCode ?? 'unknown'})` : '';
    throw new Error(`Metro did not become ready on port ${metroPort} within 60s${exitSuffix}`);
  }

  const outcome = {child, reused: false, action: 'started-new', killedPids: []};
  log(label, describeMetroOutcome(outcome));
  return outcome;
}

function parseFrontendDiagnosticLine(line) {
  const prefixIndex = line.indexOf(frontendDiagnosticPrefix);
  if (prefixIndex === -1) {
    return null;
  }

  try {
    return JSON.parse(line.slice(prefixIndex + frontendDiagnosticPrefix.length));
  } catch {
    return null;
  }
}

function getFatalFrontendDiagnostic(content) {
  const lines = content.split(/\r?\n/).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const payload = parseFrontendDiagnosticLine(lines[index]);
    if (!payload) {
      continue;
    }

    const isFatalDiagnostic = payload.level === 'fatal';
    const isStartupBlockingException =
      payload.category === 'exception' &&
      payload.level === 'error' &&
      (payload.event === 'companion.render-fallback' || String(payload.event ?? '').includes('js-error'));
    if (!isFatalDiagnostic && !isStartupBlockingException) {
      continue;
    }

    return {
      event: payload.event ?? 'unknown',
      level: payload.level,
      message: payload.error?.message ?? 'frontend error',
      rawLine: lines[index],
    };
  }

  return null;
}

export function classifyDeterministicCommandFailure(outputText) {
  const normalizedOutput = String(outputText ?? '');
  const hasSpawnMarker = /\bspawn(?:Sync)?\b/i.test(normalizedOutput);
  if (!hasSpawnMarker) {
    return null;
  }

  const hasCmdAndEperm =
    /\bcmd(?:\.exe)?\b[^\r\n]*\bEPERM\b/i.test(normalizedOutput) ||
    /\bEPERM\b[^\r\n]*\bcmd(?:\.exe)?\b/i.test(normalizedOutput);
  if (!hasCmdAndEperm) {
    return null;
  }

  return {
    code: 'cmd-spawn-eperm',
    summary: 'nested cmd spawn rejected (EPERM)',
  };
}

export function resolveHostCommandOutputPath(hostChild, fallbackOutputPath = null) {
  const candidatePath = hostChild?.opappOutputCapturePath;
  if (typeof candidatePath === 'string' && candidatePath.length > 0) {
    return candidatePath;
  }
  return fallbackOutputPath;
}

export async function detectDeterministicCommandFailureFromHost(
  hostChild,
  {fallbackOutputPath = null, tailLines = 80} = {},
) {
  const activeCommandOutputPath = resolveHostCommandOutputPath(hostChild, fallbackOutputPath);
  if (!activeCommandOutputPath) {
    return null;
  }

  const commandTail = await readFileTail(activeCommandOutputPath, tailLines);
  const classification = classifyDeterministicCommandFailure(commandTail);
  if (!classification) {
    return null;
  }

  return {
    ...classification,
    commandOutputPath: activeCommandOutputPath,
  };
}

export function formatHostCommandTailDetails(
  hostChild,
  {activeCommandOutputPath = null, commandTail = ''} = {},
) {
  const displayPath = activeCommandOutputPath ?? '<unknown-path>';
  let detail = '';

  if (hostChild?.opappOutputCaptureRequestedPath && hostChild.opappOutputCaptureRequestedPath !== activeCommandOutputPath) {
    detail += `\n[host-command-tail remapped ${hostChild.opappOutputCaptureRequestedPath} -> ${displayPath}]`;
  }

  if (commandTail) {
    detail += `\n[host-command-tail ${displayPath}]\n${commandTail}`;
  } else if (hostChild?.opappOutputCaptureFailure) {
    detail += `\n[host-command-tail unavailable ${displayPath}] ${hostChild.opappOutputCaptureFailure}`;
  } else if (hostChild?.opappOutputCaptureMode === 'ignore' && hostChild?.opappOutputCapturePath) {
    detail += `\n[host-command-tail unavailable ${displayPath}] direct fallback used stdio=ignore`;
  }

  return detail;
}

export async function waitForHostLogMarkers(
  markers,
  timeoutMs = 60000,
  {failFastOnFatalFrontendError = false, failFastCheck = null} = {},
) {
  let outcome = {status: 'timeout'};

  await waitFor(async () => {
    try {
      const content = await fsp.readFile(hostLogPath, 'utf8');
      if (markers.every(marker => content.includes(marker))) {
        outcome = {status: 'matched'};
        return true;
      }

      if (failFastOnFatalFrontendError) {
        const fatalDiagnostic = getFatalFrontendDiagnostic(content);
        if (fatalDiagnostic) {
          outcome = {status: 'fatal-frontend-error', fatalDiagnostic};
          return true;
        }
      }
    } catch {
      // ignore transient log-read failures while the host is still starting
    }

    if (typeof failFastCheck === 'function') {
      try {
        const externalFailure = await failFastCheck();
        if (externalFailure) {
          outcome = {status: 'external-failure', externalFailure};
          return true;
        }
      } catch {
        // ignore transient fail-fast checker errors
      }
    }

    return false;
  }, timeoutMs, 300);

  return outcome;
}

export async function readFileTail(filePath, maxLines = 40) {
  try {
    const content = await fsp.readFile(filePath, 'utf8');
    return content.split(/\r?\n/).filter(Boolean).slice(-maxLines).join('\n');
  } catch {
    return '';
  }
}

export async function readHostLogTail(maxLines = 40) {
  return readFileTail(hostLogPath, maxLines);
}


