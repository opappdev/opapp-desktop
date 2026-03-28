import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {pathToFileURL} from 'node:url';
import {parsePositiveIntegerArg} from './windows-args-common.mjs';
import {
  buildTimingBudgetRecommendation,
  parseMarkerTimingSummaryLine,
  parseVerifyTimingSummaryLine,
} from './windows-smoke-timing.mjs';

export function formatPercentileLabel(percentileValue) {
  return `P${String(percentileValue)}`;
}

export function resolveLaunchModeOrThrow(launchMode) {
  if (launchMode === 'all' || launchMode === 'packaged' || launchMode === 'portable') {
    return launchMode;
  }

  throw new Error(`Unknown --launch=${launchMode}. Supported values: all, packaged, portable.`);
}

export function resolvePercentileOrThrow(percentileValue) {
  if (!Number.isInteger(percentileValue) || percentileValue < 1 || percentileValue > 100) {
    throw new Error(`--percentile must be in [1, 100], got ${percentileValue}.`);
  }

  return percentileValue / 100;
}

export function collectTimingSummaries(logContents, selectedLaunchMode) {
  const timingSummaries = [];
  for (const line of logContents.split(/\r?\n/)) {
    const parsedSummary = parseMarkerTimingSummaryLine(line);
    if (!parsedSummary) {
      continue;
    }

    if (selectedLaunchMode !== 'all' && parsedSummary.launchMode !== selectedLaunchMode) {
      continue;
    }

    timingSummaries.push(parsedSummary);
  }

  return timingSummaries;
}

export function buildScenarioRecommendationMap(timingSummaries, recommendationOptions) {
  const groupedByScenario = new Map();
  for (const summary of timingSummaries) {
    const existing = groupedByScenario.get(summary.scenarioName) ?? [];
    existing.push(summary);
    groupedByScenario.set(summary.scenarioName, existing);
  }

  return [...groupedByScenario.entries()]
    .sort(([leftName], [rightName]) => leftName.localeCompare(rightName))
    .map(([scenarioName, scenarioSummaries]) => ({
      recommendation: buildTimingBudgetRecommendation(scenarioSummaries, recommendationOptions),
      scenarioName,
    }));
}

function getNearestRankValue(values, percentile) {
  const sortedValues = [...values].sort((a, b) => a - b);
  const percentileIndex = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil(sortedValues.length * percentile) - 1),
  );
  return sortedValues[percentileIndex];
}

export function buildDurationRecommendation(durationsMs, {headroomMs, percentile}) {
  if (durationsMs.length === 0) {
    return null;
  }

  const percentileMs = getNearestRankValue(durationsMs, percentile);
  return {
    maxMs: Math.max(...durationsMs),
    percentileMs,
    recommendedBudgetMs: percentileMs + headroomMs,
    sampleCount: durationsMs.length,
  };
}

export function collectVerifyTimingSummaries(logContents) {
  const verifySummaries = [];
  for (const line of logContents.split(/\r?\n/)) {
    const parsedSummary = parseVerifyTimingSummaryLine(line);
    if (parsedSummary) {
      verifySummaries.push(parsedSummary);
    }
  }

  return verifySummaries;
}

export function generateTimingReport({
  allowVerifyOnly = false,
  headroomMs = 5_000,
  launchMode = 'all',
  logContents,
  percentileValue = 95,
}) {
  const selectedLaunchMode = resolveLaunchModeOrThrow(launchMode);
  const percentile = resolvePercentileOrThrow(percentileValue);
  const timingSummaries = collectTimingSummaries(logContents, selectedLaunchMode);
  const recommendationOptions = {headroomMs, percentile};
  const verifyTimingSummaries = collectVerifyTimingSummaries(logContents);
  const verifyTotalRecommendation = buildDurationRecommendation(
    verifyTimingSummaries.map(summary => summary.totalDurationMs),
    recommendationOptions,
  );
  if (timingSummaries.length === 0) {
    if (allowVerifyOnly && verifyTotalRecommendation) {
      return {
        headroomMs,
        launchMode: selectedLaunchMode,
        overallRecommendation: null,
        percentileLabel: formatPercentileLabel(percentileValue),
        percentileValue,
        scenarioRecommendations: [],
        verifyTotalRecommendation,
      };
    }

    const additionalHint = verifyTotalRecommendation
      ? ' Add --allow-verify-only to emit verify timeout recommendations from verify summary lines only.'
      : ' Make sure the input file includes `timing summary scenario=...` log entries.';
    throw new Error(
      `No timing summary lines found for launch=${selectedLaunchMode}. ${additionalHint}`,
    );
  }

  return {
    headroomMs,
    launchMode: selectedLaunchMode,
    overallRecommendation: buildTimingBudgetRecommendation(timingSummaries, recommendationOptions),
    percentileLabel: formatPercentileLabel(percentileValue),
    percentileValue,
    scenarioRecommendations: buildScenarioRecommendationMap(timingSummaries, recommendationOptions),
    verifyTotalRecommendation,
  };
}

export function formatTimingTextReport({inputPath, report}) {
  const lines = [`[timing-report] input=${inputPath}`];

  if (report.overallRecommendation) {
    lines.push(
      `[timing-report] samples=${report.overallRecommendation.sampleCount} launch=${report.launchMode} ` +
        `percentile=${report.percentileLabel} headroomMs=${report.overallRecommendation.headroomMs}`,
      `[timing-report] startup ${report.percentileLabel}=${report.overallRecommendation.startup.percentileMs}ms ` +
        `max=${report.overallRecommendation.startup.maxMs}ms ` +
        `recommended --startup-ms>=${report.overallRecommendation.startup.recommendedBudgetMs}`,
      `[timing-report] scenario ${report.percentileLabel}=${report.overallRecommendation.scenario.percentileMs}ms ` +
        `max=${report.overallRecommendation.scenario.maxMs}ms ` +
        `recommended --scenario-ms>=${report.overallRecommendation.scenario.recommendedBudgetMs}`,
    );
  } else {
    lines.push(
      `[timing-report] marker timing samples=0 launch=${report.launchMode} ` +
        `percentile=${report.percentileLabel} headroomMs=${report.headroomMs}`,
      '[timing-report] no marker timing summary lines found; startup/scenario recommendations skipped.',
    );
  }

  if (report.scenarioRecommendations.length > 0) {
    lines.push('[timing-report] per-scenario recommendations:');
  }

  for (const {scenarioName, recommendation} of report.scenarioRecommendations) {
    lines.push(
      `[timing-report] scenario=${scenarioName} samples=${recommendation.sampleCount} ` +
        `startup${report.percentileLabel}=${recommendation.startup.percentileMs}ms ` +
        `scenario${report.percentileLabel}=${recommendation.scenario.percentileMs}ms`,
    );
  }

  if (report.verifyTotalRecommendation) {
    lines.push(
      `[timing-report] verify-total ${report.percentileLabel}=${report.verifyTotalRecommendation.percentileMs}ms ` +
        `max=${report.verifyTotalRecommendation.maxMs}ms ` +
        `recommended verify timeout >=${report.verifyTotalRecommendation.recommendedBudgetMs}`,
    );
  }

  return lines.join('\n');
}

export function buildSerializedReport({inputPaths, outputJson, report}) {
  if (outputJson) {
    return JSON.stringify(
      {
        headroomMs: report.headroomMs,
        inputPaths,
        launchMode: report.launchMode,
        overall: report.overallRecommendation,
        percentile: report.percentileValue,
        scenarioRecommendations: report.scenarioRecommendations,
        verifyTotal: report.verifyTotalRecommendation,
      },
      null,
      2,
    );
  }

  return formatTimingTextReport({
    inputPath: inputPaths.length === 1 ? inputPaths[0] : `${inputPaths.length} files`,
    report,
  });
}

function findArgValue(argv, flagName) {
  return argv.find(argument => argument.startsWith(`${flagName}=`))?.split('=')[1];
}

export function resolveInputPathsOrThrow(argv) {
  const rawInputPaths = argv
    .filter(argument => argument.startsWith('--input='))
    .flatMap(argument => argument.slice('--input='.length).split(','))
    .map(value => value.trim())
    .filter(Boolean);

  if (rawInputPaths.length === 0) {
    throw new Error('Missing required --input=<path> argument.');
  }

  return rawInputPaths.map(rawInputPath => path.resolve(process.cwd(), rawInputPath));
}

function resolveOutputPath(argv) {
  const rawOutputPath = findArgValue(argv, '--output');
  if (!rawOutputPath) {
    return null;
  }

  return path.resolve(process.cwd(), rawOutputPath);
}

async function writeOutputFileIfRequested(outputPath, outputText) {
  if (!outputPath) {
    return;
  }

  await mkdir(path.dirname(outputPath), {recursive: true});
  await writeFile(outputPath, `${outputText}\n`, 'utf8');
}

async function main(argv = process.argv) {
  const allowVerifyOnly = argv.includes('--allow-verify-only');
  const launchMode = findArgValue(argv, '--launch') ?? 'all';
  const outputJson = argv.includes('--json');
  const outputPath = resolveOutputPath(argv);
  const inputPaths = resolveInputPathsOrThrow(argv);
  const headroomMs = parsePositiveIntegerArg(argv, '--headroom-ms', 5_000);
  const percentileValue = parsePositiveIntegerArg(argv, '--percentile', 95);
  const logContents = (
    await Promise.all(inputPaths.map(inputPath => readFile(inputPath, 'utf8')))
  ).join('\n');
  const report = generateTimingReport({
    allowVerifyOnly,
    headroomMs,
    launchMode,
    logContents,
    percentileValue,
  });
  const serializedReport = buildSerializedReport({
    inputPaths,
    outputJson,
    report,
  });
  await writeOutputFileIfRequested(outputPath, serializedReport);

  if (outputPath) {
    console.log(`[timing-report] wrote report to ${outputPath}`);
  }

  console.log(serializedReport);
}

const isMainEntryPoint =
  Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMainEntryPoint) {
  main().catch(error => {
    console.error(error);
    process.exit(1);
  });
}
