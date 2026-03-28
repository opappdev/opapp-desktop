import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSerializedReport,
  buildDurationRecommendation,
  collectVerifyTimingSummaries,
  formatTimingTextReport,
  generateTimingReport,
  resolveInputPathsOrThrow,
  resolveLaunchModeOrThrow,
  resolvePercentileOrThrow,
} from './windows-smoke-timing-report.mjs';

const sampleLog = [
  '[verify] scenario timing summary totalMs=11111 scenarioCount=2',
  '[smoke] timing summary scenario=tab-session launchMode=packaged startupMs=8000 scenarioMs=11000 totalMarkerMs=19000',
  '[smoke] timing summary scenario=secondary-window launchMode=packaged startupMs=9000 scenarioMs=13000 totalMarkerMs=22000',
  '[smoke] timing summary scenario=secondary-window launchMode=portable startupMs=10000 scenarioMs=12500 totalMarkerMs=22500',
].join('\n');

const verifyOnlyLog = [
  '[verify] scenario timing summary totalMs=11111 scenarioCount=2',
  '[verify] scenario timing summary totalMs=12000 scenarioCount=2',
].join('\n');

const mixedLaunchVerifyLog = [
  '[verify] launchMode=packaged',
  '[verify] scenario timing summary totalMs=14000 scenarioCount=2',
  '[verify] launchMode=portable',
  '[verify] scenario timing summary totalMs=22000 scenarioCount=2',
].join('\n');

test('generateTimingReport computes packaged recommendations from summary logs', () => {
  const report = generateTimingReport({
    headroomMs: 5_000,
    launchMode: 'packaged',
    logContents: sampleLog,
    percentileValue: 95,
  });

  assert.equal(report.launchMode, 'packaged');
  assert.equal(report.overallRecommendation.sampleCount, 2);
  assert.equal(report.overallRecommendation.startup.recommendedBudgetMs, 14_000);
  assert.equal(report.overallRecommendation.scenario.recommendedBudgetMs, 18_000);
  assert.equal(report.scenarioRecommendations.length, 2);
  assert.ok(report.verifyTotalRecommendation);
  assert.equal(report.verifyTotalRecommendation.recommendedBudgetMs, 16_111);
});

test('formatTimingTextReport renders a readable timeout recommendation summary', () => {
  const report = generateTimingReport({
    launchMode: 'portable',
    logContents: sampleLog,
  });
  const output = formatTimingTextReport({
    inputPath: 'D:\\logs\\windows-verify.log',
    report,
  });

  assert.match(output, /input=D:\\logs\\windows-verify\.log/);
  assert.match(output, /recommended --startup-ms>=15000/);
  assert.match(output, /recommended --scenario-ms>=17500/);
  assert.match(output, /scenario=secondary-window/);
  assert.match(output, /recommended verify timeout >=16111/);
});

test('generateTimingReport supports verify-only recommendation mode', () => {
  const report = generateTimingReport({
    allowVerifyOnly: true,
    headroomMs: 4_000,
    logContents: verifyOnlyLog,
    percentileValue: 95,
  });

  assert.equal(report.overallRecommendation, null);
  assert.equal(report.scenarioRecommendations.length, 0);
  assert.ok(report.verifyTotalRecommendation);
  assert.equal(report.verifyTotalRecommendation.recommendedBudgetMs, 16_000);
});

test('collectVerifyTimingSummaries honors launch-mode filtering when markers are present', () => {
  const packagedSummaries = collectVerifyTimingSummaries(mixedLaunchVerifyLog, 'packaged');
  assert.deepEqual(
    packagedSummaries.map(summary => summary.totalDurationMs),
    [14_000],
  );
  assert.equal(packagedSummaries[0].launchMode, 'packaged');

  const portableSummaries = collectVerifyTimingSummaries(mixedLaunchVerifyLog, 'portable');
  assert.deepEqual(
    portableSummaries.map(summary => summary.totalDurationMs),
    [22_000],
  );
  assert.equal(portableSummaries[0].launchMode, 'portable');
});

test('generateTimingReport verify-only recommendations respect --launch when logs are mixed', () => {
  const packagedReport = generateTimingReport({
    allowVerifyOnly: true,
    headroomMs: 3_000,
    launchMode: 'packaged',
    logContents: mixedLaunchVerifyLog,
    percentileValue: 95,
  });
  assert.equal(packagedReport.verifyTotalRecommendation.recommendedBudgetMs, 17_000);

  const portableReport = generateTimingReport({
    allowVerifyOnly: true,
    headroomMs: 3_000,
    launchMode: 'portable',
    logContents: mixedLaunchVerifyLog,
    percentileValue: 95,
  });
  assert.equal(portableReport.verifyTotalRecommendation.recommendedBudgetMs, 25_000);
});

test('formatTimingTextReport describes verify-only fallback output', () => {
  const report = generateTimingReport({
    allowVerifyOnly: true,
    logContents: verifyOnlyLog,
  });
  const output = formatTimingTextReport({
    inputPath: 'D:\\logs\\verify-preflight.log',
    report,
  });

  assert.match(output, /marker timing samples=0/);
  assert.match(output, /startup\/scenario recommendations skipped/);
  assert.match(output, /recommended verify timeout >=17000/);
});

test('generateTimingReport fails when selected launch mode has no timing samples', () => {
  assert.throws(
    () =>
      generateTimingReport({
        launchMode: 'portable',
        logContents:
          '[smoke] timing summary scenario=tab-session launchMode=packaged startupMs=8000 scenarioMs=11000 totalMarkerMs=19000',
      }),
    /No timing summary lines found/,
  );
});

test('generateTimingReport requires marker timing samples unless verify-only is enabled', () => {
  assert.throws(
    () =>
      generateTimingReport({
        logContents: verifyOnlyLog,
      }),
    /No timing summary lines found/,
  );
});

test('resolveInputPathsOrThrow supports repeated and comma-separated --input flags', () => {
  const resolved = resolveInputPathsOrThrow([
    'node',
    'windows-smoke-timing-report.mjs',
    '--input=logs/a.log,logs/b.log',
    '--input=logs/c.log',
  ]);

  assert.equal(resolved.length, 3);
  assert.match(resolved[0], /logs[\\/]a\.log$/);
  assert.match(resolved[1], /logs[\\/]b\.log$/);
  assert.match(resolved[2], /logs[\\/]c\.log$/);
});

test('buildSerializedReport emits json payload with verify summary recommendations', () => {
  const report = generateTimingReport({
    launchMode: 'packaged',
    logContents: sampleLog,
  });
  const serialized = buildSerializedReport({
    inputPaths: ['logs/run-a.log', 'logs/run-b.log'],
    outputJson: true,
    report,
  });
  const parsed = JSON.parse(serialized);

  assert.deepEqual(parsed.inputPaths, ['logs/run-a.log', 'logs/run-b.log']);
  assert.equal(parsed.launchMode, 'packaged');
  assert.equal(parsed.overall.sampleCount, 2);
  assert.equal(parsed.verifyTotal.recommendedBudgetMs, 16_111);
});

test('resolveLaunchModeOrThrow validates launch filter options', () => {
  assert.equal(resolveLaunchModeOrThrow('all'), 'all');
  assert.equal(resolveLaunchModeOrThrow('packaged'), 'packaged');
  assert.equal(resolveLaunchModeOrThrow('portable'), 'portable');
  assert.throws(() => resolveLaunchModeOrThrow('invalid'), /Unknown --launch=invalid/);
});

test('resolvePercentileOrThrow validates allowed percentile range', () => {
  assert.equal(resolvePercentileOrThrow(95), 0.95);
  assert.throws(() => resolvePercentileOrThrow(0), /--percentile must be in \[1, 100]/);
  assert.throws(() => resolvePercentileOrThrow(101), /--percentile must be in \[1, 100]/);
});

test('buildDurationRecommendation returns null for empty input and computes nearest-rank percentile', () => {
  assert.equal(buildDurationRecommendation([], {headroomMs: 5000, percentile: 0.95}), null);

  const recommendation = buildDurationRecommendation([12_000, 10_000, 15_000], {
    headroomMs: 3_000,
    percentile: 0.8,
  });
  assert.equal(recommendation.percentileMs, 15_000);
  assert.equal(recommendation.recommendedBudgetMs, 18_000);
});
