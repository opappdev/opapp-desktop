import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {loadTimeoutDefaultsForLaunch} from './windows-timeout-defaults.mjs';

function withTimeoutDefaultsFile(content, run) {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'opapp-timeout-defaults-'));
  const defaultsPath = path.join(tempDir, 'timeout-defaults.json');
  writeFileSync(defaultsPath, JSON.stringify(content), 'utf8');
  try {
    return run({defaultsPath, tempDir});
  } finally {
    rmSync(tempDir, {force: true, recursive: true});
  }
}

test('loadTimeoutDefaultsForLaunch returns null without --timeout-defaults', () => {
  const result = loadTimeoutDefaultsForLaunch({
    argv: ['node', 'verify-windows.mjs'],
    launchMode: 'packaged',
  });

  assert.equal(result, null);
});

test('loadTimeoutDefaultsForLaunch selects launch-specific defaults when present', () => {
  withTimeoutDefaultsFile(
    {
      suggestedDefaults: [
        {
          launchMode: 'packaged',
          readinessMs: 26_000,
          smokeMs: 27_000,
          startupMs: 25_000,
          scenarioMs: 27_000,
          verifyTotalMs: 60_000,
        },
      ],
    },
    ({defaultsPath, tempDir}) => {
      const result = loadTimeoutDefaultsForLaunch({
        argv: ['node', 'verify-windows.mjs', `--timeout-defaults=${defaultsPath}`],
        cwd: tempDir,
        launchMode: 'packaged',
      });

      assert.ok(result);
      assert.equal(result.defaults.launchMode, 'packaged');
      assert.equal(result.defaults.readinessMs, 26_000);
      assert.equal(result.defaults.verifyTotalMs, 60_000);
    },
  );
});

test('loadTimeoutDefaultsForLaunch falls back to launch=all defaults', () => {
  withTimeoutDefaultsFile(
    {
      suggestedDefaults: [
        {
          launchMode: 'all',
          readinessMs: 33_000,
          smokeMs: 33_000,
          startupMs: 30_000,
          scenarioMs: 33_000,
        },
      ],
    },
    ({defaultsPath, tempDir}) => {
      const result = loadTimeoutDefaultsForLaunch({
        argv: ['node', 'verify-windows.mjs', `--timeout-defaults=${defaultsPath}`],
        cwd: tempDir,
        launchMode: 'portable',
      });

      assert.ok(result);
      assert.equal(result.defaults.launchMode, 'all');
      assert.equal(result.defaults.startupMs, 30_000);
    },
  );
});

test('loadTimeoutDefaultsForLaunch rejects non-positive timeout values', () => {
  withTimeoutDefaultsFile(
    {
      suggestedDefaults: [
        {
          launchMode: 'packaged',
          startupMs: 0,
        },
      ],
    },
    ({defaultsPath, tempDir}) => {
      assert.throws(
        () =>
          loadTimeoutDefaultsForLaunch({
            argv: ['node', 'verify-windows.mjs', `--timeout-defaults=${defaultsPath}`],
            cwd: tempDir,
            launchMode: 'packaged',
          }),
        /expected a positive number or null/,
      );
    },
  );
});

test('loadTimeoutDefaultsForLaunch rejects payloads without matching defaults', () => {
  withTimeoutDefaultsFile(
    {
      suggestedDefaults: [
        {
          launchMode: 'portable',
          startupMs: 28_000,
        },
      ],
    },
    ({defaultsPath, tempDir}) => {
      assert.throws(
        () =>
          loadTimeoutDefaultsForLaunch({
            argv: ['node', 'verify-windows.mjs', `--timeout-defaults=${defaultsPath}`],
            cwd: tempDir,
            launchMode: 'packaged',
          }),
        /No suggestedDefaults entry found for launch=packaged/,
      );
    },
  );
});

test('loadTimeoutDefaultsForLaunch rejects duplicate --timeout-defaults arguments', () => {
  withTimeoutDefaultsFile(
    {
      suggestedDefaults: [
        {
          launchMode: 'packaged',
          startupMs: 28_000,
        },
      ],
    },
    ({defaultsPath, tempDir}) => {
      assert.throws(
        () =>
          loadTimeoutDefaultsForLaunch({
            argv: [
              'node',
              'verify-windows.mjs',
              `--timeout-defaults=${defaultsPath}`,
              '--timeout-defaults=other.json',
            ],
            cwd: tempDir,
            launchMode: 'packaged',
          }),
        /Duplicate --timeout-defaults arguments are not supported/,
      );
    },
  );
});

test('loadTimeoutDefaultsForLaunch rejects unsupported launchMode input', () => {
  withTimeoutDefaultsFile(
    {
      suggestedDefaults: [
        {
          launchMode: 'all',
          startupMs: 30_000,
        },
      ],
    },
    ({defaultsPath, tempDir}) => {
      assert.throws(
        () =>
          loadTimeoutDefaultsForLaunch({
            argv: ['node', 'verify-windows.mjs', `--timeout-defaults=${defaultsPath}`],
            cwd: tempDir,
            launchMode: 'desktop',
          }),
        /Unsupported launchMode "desktop"/,
      );
    },
  );
});
