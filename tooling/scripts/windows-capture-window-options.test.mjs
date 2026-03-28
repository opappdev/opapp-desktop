import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const captureScriptPath = path.join(scriptDir, 'windows-capture-window.mjs');

function runCaptureValidateOnly(args = []) {
  const result = spawnSync(
    process.execPath,
    [captureScriptPath, '--validate-only', '--json', ...args],
    {
      encoding: 'utf8',
      windowsHide: true,
    },
  );

  if (result.error) {
    throw result.error;
  }

  return result;
}

function parseJsonOrThrow(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

test('windows-capture-window defaults client captures to WGC', () => {
  const result = runCaptureValidateOnly(['--foreground', '--region=client']);
  const parsed = parseJsonOrThrow(result);

  assert.equal(parsed.backend, 'wgc');
  assert.equal(parsed.region, 'client');
});

test('windows-capture-window defaults monitor captures to copy-screen', () => {
  const result = runCaptureValidateOnly(['--foreground', '--region=monitor']);
  const parsed = parseJsonOrThrow(result);

  assert.equal(parsed.backend, 'copy-screen');
  assert.equal(parsed.region, 'monitor');
});

test('windows-capture-window rejects WGC monitor captures', () => {
  const result = runCaptureValidateOnly([
    '--foreground',
    '--region=monitor',
    '--backend=wgc',
  ]);

  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /supports only --region=window or --region=client/i,
  );
});

test('windows-capture-window validates explicit output paths without writing files', () => {
  const result = runCaptureValidateOnly([
    '--foreground',
    '--region=window',
    '--out=tmp/window-capture-test.png',
  ]);
  const parsed = parseJsonOrThrow(result);

  assert.equal(parsed.backend, 'wgc');
  assert.match(parsed.outputPath, /tmp[\\/]+window-capture-test\.png$/i);
});

test('windows-capture-window default output path includes millisecond precision', () => {
  const result = runCaptureValidateOnly(['--foreground', '--region=window']);
  const parsed = parseJsonOrThrow(result);

  assert.match(
    parsed.outputPath,
    /foreground-window-\d{8}-\d{9}\.png$/i,
  );
});

test('windows-capture-window accepts selector and options JSON files', () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'opapp-window-capture-test-'));

  try {
    const selectorPath = path.join(tempDir, 'selector.json');
    const optionsPath = path.join(tempDir, 'options.json');
    writeFileSync(
      selectorPath,
      JSON.stringify({
        foreground: true,
      }),
    );
    writeFileSync(
      optionsPath,
      JSON.stringify({
        region: 'client',
        backend: 'auto',
        outputPath: 'tmp/from-options-file.png',
      }),
    );

    const result = runCaptureValidateOnly([
      `--selector-file=${selectorPath}`,
      `--options-file=${optionsPath}`,
    ]);
    const parsed = parseJsonOrThrow(result);

    assert.equal(parsed.selector.foreground, true);
    assert.equal(parsed.region, 'client');
    assert.equal(parsed.backend, 'wgc');
    assert.match(parsed.outputPath, /tmp[\\/]+from-options-file\.png$/i);
  } finally {
    rmSync(tempDir, {recursive: true, force: true});
  }
});
