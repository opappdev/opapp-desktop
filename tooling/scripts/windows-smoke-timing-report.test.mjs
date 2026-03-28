import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSerializedReport,
  buildDurationRecommendation,
  buildSuggestedTimeoutDefaults,
  collectVerifyTimingSummaries,
  formatSuggestedDefaultsTextReport,
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
  assert.equal(report.suggestedTimeoutDefaults.length, 1);
  assert.equal(report.suggestedTimeoutDefaults[0].launchMode, 'packaged');
  assert.equal(report.suggestedTimeoutDefaults[0].readinessMs, 18_000);
  assert.equal(report.suggestedTimeoutDefaults[0].smokeMs, 18_000);
  assert.equal(report.suggestedTimeoutDefaults[0].startupMs, 14_000);
  assert.equal(report.suggestedTimeoutDefaults[0].scenarioMs, 18_000);
  assert.ok(report.verifyTotalRecommendation);
  assert.equal(report.verifyTotalRecommendation.recommendedBudgetMs, 16_111);
  assert.equal(report.suggestedTimeoutDefaults[0].verifyTotalMs, 16_111);
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

test('generateTimingReport includes per-launch verify recommendations for mixed logs', () => {
  const report = generateTimingReport({
    allowVerifyOnly: true,
    headroomMs: 3_000,
    launchMode: 'all',
    logContents: mixedLaunchVerifyLog,
    percentileValue: 95,
  });

  assert.equal(report.verifyLaunchModeRecommendations.length, 2);
  assert.deepEqual(
    report.verifyLaunchModeRecommendations.map(item => item.launchMode),
    ['packaged', 'portable'],
  );
  assert.equal(report.verifyLaunchModeRecommendations[0].recommendation.recommendedBudgetMs, 17_000);
  assert.equal(report.verifyLaunchModeRecommendations[1].recommendation.recommendedBudgetMs, 25_000);

  const output = formatTimingTextReport({
    inputPath: 'D:\\logs\\verify-mixed.log',
    report,
  });
  assert.match(output, /verify-total recommendations by launch mode/);
  assert.match(output, /launch=packaged/);
  assert.match(output, /launch=portable/);
});

test('generateTimingReport includes per-launch marker recommendations when launch=all', () => {
  const report = generateTimingReport({
    headroomMs: 3_000,
    launchMode: 'all',
    logContents: sampleLog,
    percentileValue: 95,
  });

  assert.equal(report.markerLaunchModeRecommendations.length, 2);
  assert.deepEqual(
    report.markerLaunchModeRecommendations.map(item => item.launchMode),
    ['packaged', 'portable'],
  );
  assert.equal(
    report.markerLaunchModeRecommendations[0].recommendation.startup.recommendedBudgetMs,
    12_000,
  );
  assert.equal(
    report.markerLaunchModeRecommendations[1].recommendation.startup.recommendedBudgetMs,
    13_000,
  );

  const output = formatTimingTextReport({
    inputPath: 'D:\\logs\\mixed-marker.log',
    report,
  });
  assert.match(output, /marker recommendations by launch mode/);
  assert.match(output, /marker launch=packaged/);
  assert.match(output, /marker launch=portable/);
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
  assert.match(output, /suggested timeout defaults/);
  assert.match(output, /defaults launch=all/);
  assert.match(output, /verifyTotalMs=17000/);
  assert.match(output, /startupMs=n\/a/);
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
  assert.equal(parsed.markerByLaunchMode.length, 0);
  assert.equal(parsed.overall.sampleCount, 2);
  assert.equal(parsed.suggestedDefaults.length, 1);
  assert.equal(parsed.suggestedDefaults[0].launchMode, 'packaged');
  assert.equal(parsed.verifyByLaunchMode.length, 0);
  assert.equal(parsed.verifyTotal.recommendedBudgetMs, 16_111);
});

test('buildSerializedReport emits verify-by-launch payload when launch markers are present', () => {
  const report = generateTimingReport({
    allowVerifyOnly: true,
    headroomMs: 3_000,
    launchMode: 'all',
    logContents: mixedLaunchVerifyLog,
  });
  const serialized = buildSerializedReport({
    inputPaths: ['logs/mixed.log'],
    outputJson: true,
    report,
  });
  const parsed = JSON.parse(serialized);

  assert.equal(parsed.markerByLaunchMode.length, 0);
  assert.equal(parsed.suggestedDefaults.length, 2);
  assert.equal(parsed.verifyByLaunchMode.length, 2);
  assert.deepEqual(
    parsed.verifyByLaunchMode.map(item => item.launchMode),
    ['packaged', 'portable'],
  );
});

test('buildSerializedReport emits marker-by-launch payload when marker summaries are mixed', () => {
  const report = generateTimingReport({
    headroomMs: 3_000,
    launchMode: 'all',
    logContents: sampleLog,
  });
  const serialized = buildSerializedReport({
    inputPaths: ['logs/mixed-marker.log'],
    outputJson: true,
    report,
  });
  const parsed = JSON.parse(serialized);

  assert.equal(parsed.markerByLaunchMode.length, 2);
  assert.equal(parsed.suggestedDefaults.length, 2);
  assert.deepEqual(
    parsed.markerByLaunchMode.map(item => item.launchMode),
    ['packaged', 'portable'],
  );
});

test('buildSerializedReport supports defaults-only json mode', () => {
  const report = generateTimingReport({
    allowVerifyOnly: true,
    launchMode: 'all',
    logContents: verifyOnlyLog,
  });
  const serialized = buildSerializedReport({
    defaultsOnly: true,
    inputPaths: ['logs/verify-only.log'],
    outputJson: true,
    report,
  });
  const parsed = JSON.parse(serialized);

  assert.deepEqual(parsed.inputPaths, ['logs/verify-only.log']);
  assert.equal(parsed.launchMode, 'all');
  assert.equal(parsed.suggestedDefaults.length, 1);
  assert.equal(parsed.suggestedDefaults[0].verifyTotalMs, 17_000);
  assert.equal(parsed.suggestedDefaults[0].startupMs, null);
});

test('formatSuggestedDefaultsTextReport emits a compact defaults summary', () => {
  const report = generateTimingReport({
    launchMode: 'packaged',
    logContents: sampleLog,
  });
  const output = formatSuggestedDefaultsTextReport({
    inputPath: 'D:\\logs\\packaged.log',
    report,
  });

  assert.match(output, /input=D:\\logs\\packaged\.log/);
  assert.match(output, /suggested timeout defaults/);
  assert.match(output, /defaults launch=packaged/);
  assert.match(output, /smokeMs=18000/);
});

test('buildSerializedReport supports defaults-only text mode', () => {
  const report = generateTimingReport({
    launchMode: 'packaged',
    logContents: sampleLog,
  });
  const output = buildSerializedReport({
    defaultsOnly: true,
    inputPaths: ['logs/packaged.log'],
    outputJson: false,
    report,
  });

  assert.match(output, /suggested timeout defaults/);
  assert.match(output, /defaults launch=packaged/);
  assert.doesNotMatch(output, /per-scenario recommendations/);
});

test('buildSuggestedTimeoutDefaults falls back to launch=all aggregate when per-launch data is missing', () => {
  const defaults = buildSuggestedTimeoutDefaults({
    launchMode: 'all',
    markerLaunchModeRecommendations: [],
    overallRecommendation: {
      startup: {recommendedBudgetMs: 15_000},
      scenario: {recommendedBudgetMs: 19_000},
    },
    verifyLaunchModeRecommendations: [],
    verifyTotalRecommendation: {recommendedBudgetMs: 42_000},
  });

  assert.equal(defaults.length, 1);
  assert.equal(defaults[0].launchMode, 'all');
  assert.equal(defaults[0].readinessMs, 19_000);
  assert.equal(defaults[0].smokeMs, 19_000);
  assert.equal(defaults[0].startupMs, 15_000);
  assert.equal(defaults[0].scenarioMs, 19_000);
  assert.equal(defaults[0].verifyTotalMs, 42_000);
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
