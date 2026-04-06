import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createArtifactProgressReporter,
  shouldKeepArtifactDir,
} from './windows-ui-automation-runner.mjs';

async function withTempArtifactDir(run) {
  const artifactDir = mkdtempSync(
    path.join(tmpdir(), 'opapp-ui-automation-runner-test-'),
  );
  try {
    return await run(artifactDir);
  } finally {
    rmSync(artifactDir, {recursive: true, force: true});
  }
}

test('artifact progress reporter announces the screenshot directory and only reports new files once', async () => {
  await withTempArtifactDir(async artifactDir => {
    const messages = [];
    const reporter = createArtifactProgressReporter(artifactDir, {
      logger: message => {
        messages.push(message);
      },
      specName: 'debug-spec',
    });

    reporter.announceStart();
    assert.equal(
      messages[0],
      `[windows-ui-automation] debug screenshots enabled for 'debug-spec'; saving screenshots under ${artifactDir}`,
    );

    const nestedDir = path.join(artifactDir, 'nested');
    mkdirSync(nestedDir, {recursive: true});
    const firstScreenshotPath = path.join(artifactDir, '02-after-step-click-open.png');
    const secondScreenshotPath = path.join(artifactDir, '10-after-step-setValue-command.png');
    writeFileSync(firstScreenshotPath, 'first', 'utf8');
    writeFileSync(secondScreenshotPath, 'second', 'utf8');

    await reporter.reportNewArtifacts();
    assert.deepEqual(messages.slice(1), [
      `[windows-ui-automation] screenshot saved for 'debug-spec': ${firstScreenshotPath}`,
      `[windows-ui-automation] screenshot saved for 'debug-spec': ${secondScreenshotPath}`,
    ]);

    await reporter.reportNewArtifacts();
    assert.equal(messages.length, 3);

    const thirdScreenshotPath = path.join(artifactDir, '11-after-step-click-save.png');
    writeFileSync(thirdScreenshotPath, 'third', 'utf8');
    await reporter.reportNewArtifacts();
    assert.equal(
      messages.at(-1),
      `[windows-ui-automation] screenshot saved for 'debug-spec': ${thirdScreenshotPath}`,
    );
    assert.equal(messages.length, 4);
  });
});

test('shouldKeepArtifactDir keeps successful debug screenshot directories when files were captured', () => {
  assert.equal(shouldKeepArtifactDir(null, []), false);
  assert.equal(
    shouldKeepArtifactDir(
      {
        ok: true,
        artifacts: [],
      },
      ['C:\\temp\\02-after-step-click.png'],
    ),
    true,
  );
  assert.equal(
    shouldKeepArtifactDir(
      {
        ok: false,
        error: {
          artifacts: [{path: 'C:\\temp\\failure.png'}],
        },
      },
      [],
    ),
    true,
  );
});
