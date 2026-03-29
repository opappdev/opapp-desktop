import {mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {
  classifyRunWindowsFailure,
  collectReleaseBuildProbe,
  formatReleaseProbeReport,
  getBlockingReleaseProbeFailure,
} from './windows-release-diagnostics.mjs';

const jsonFlag = process.argv.includes('--json');
const failOnBlockingFlag = process.argv.includes('--fail-on-blocking');
const outputArg = process.argv.find(argument => argument.startsWith('--output='));
const outputPath = outputArg?.split('=').slice(1).join('=') || null;

const probe = collectReleaseBuildProbe();
const blockingFailure = getBlockingReleaseProbeFailure(probe);

const output = jsonFlag
  ? JSON.stringify(
      {
        blockingFailure,
        classification: blockingFailure
          ? classifyRunWindowsFailure(blockingFailure.classifierHint)
          : null,
        probe,
      },
      null,
      2,
    )
  : formatReleaseProbeReport({
      command: process.execPath,
      probe,
      blockingFailure,
    });

if (outputPath) {
  try {
    mkdirSync(path.dirname(outputPath), {recursive: true});
    writeFileSync(outputPath, `${output}\n`, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `[release-probe-report] failed to write report to ${outputPath}: ${message}. ` +
        'Try %TEMP% or another writable directory.',
    );
    process.exit(1);
  }
  console.log(`[release-probe-report] wrote ${jsonFlag ? 'json' : 'text'} report to ${outputPath}`);
} else {
  console.log(output);
}

if (failOnBlockingFlag && blockingFailure) {
  process.exit(1);
}
