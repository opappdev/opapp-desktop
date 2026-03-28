const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const originalExecSync = childProcess.execSync;

function tokenizeWindowsCommandArgs(argText) {
  return (argText.match(/"[^"]*"|[^\s]+/g) ?? []).map(token => {
    if (token.startsWith('"') && token.endsWith('"')) {
      return token.slice(1, -1);
    }

    return token;
  });
}

function tryRunVswhereWithoutCmd(command, options = {}) {
  if (
    typeof command !== 'string' ||
    !/\\cmd(?:\.exe)?\s+\/c\b/i.test(command) ||
    !/vswhere\.exe/i.test(command)
  ) {
    return null;
  }

  const vswhereMatch = command.match(/"([^"]*vswhere\.exe)"\s+(.+)$/i);
  if (!vswhereMatch) {
    return null;
  }

  const [, vswherePath, argText] = vswhereMatch;
  const vswhereArgs = tokenizeWindowsCommandArgs(argText);
  const tempRoot = process.env.TEMP || process.env.TMP || os.tmpdir();
  const capturePath = path.join(
    tempRoot,
    `opapp-rnw-vswhere-${process.pid}-${Date.now()}.json`,
  );
  const stdoutFd = fs.openSync(capturePath, 'w');
  let result;

  try {
    result = childProcess.spawnSync(vswherePath, vswhereArgs, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      input: options.input,
      maxBuffer: options.maxBuffer,
      stdio: ['ignore', stdoutFd, 'ignore'],
      windowsHide: true,
    });
  } finally {
    fs.closeSync(stdoutFd);
  }

  const capturedOutput = fs.existsSync(capturePath)
    ? fs.readFileSync(capturePath, options.encoding ? options.encoding : undefined)
    : options.encoding
      ? ''
      : Buffer.alloc(0);
  fs.rmSync(capturePath, {force: true});

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    const errorText = result.stderr || `vswhere.exe exited with status ${result.status}`;
    const error = new Error(String(errorText).trim());
    error.status = result.status;
    error.stdout = capturedOutput;
    error.stderr = '';
    throw error;
  }

  return capturedOutput;
}

childProcess.execSync = function patchedExecSync(command, options) {
  const directVswhereResult = tryRunVswhereWithoutCmd(command, options);
  if (directVswhereResult !== null) {
    return directVswhereResult;
  }

  return originalExecSync.call(this, command, options);
};

const cliBinPath = require.resolve('@react-native-community/cli/build/bin.js', {
  paths: [process.cwd(), __dirname],
});

process.argv = [process.execPath, cliBinPath, 'run-windows', ...process.argv.slice(2)];
require(cliBinPath);
