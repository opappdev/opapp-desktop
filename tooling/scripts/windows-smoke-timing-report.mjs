import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {pathToFileURL} from 'node:url';
import {parsePositiveIntegerArg} from './windows-args-common.mjs';
import {
  buildTimingBudgetRecommendation,
  parseMarkerTimingSummaryLine,
  parseVerifyLaunchModeLine,
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

export function collectVerifyTimingSummaries(logContents, selectedLaunchMode = 'all') {
  const verifySummaries = [];
  let activeLaunchMode = null;
  for (const line of logContents.split(/\r?\n/)) {
    const parsedLaunchMode = parseVerifyLaunchModeLine(line);
    if (parsedLaunchMode) {
      activeLaunchMode = parsedLaunchMode;
      continue;
    }

    const parsedSummary = parseVerifyTimingSummaryLine(line);
    if (!parsedSummary) {
      continue;
    }

    if (
      selectedLaunchMode !== 'all' &&
      activeLaunchMode &&
      activeLaunchMode !== selectedLaunchMode
    ) {
      continue;
    }

    verifySummaries.push({
      ...parsedSummary,
      launchMode: activeLaunchMode,
    });
  }

  return verifySummaries;
}

export function buildVerifyLaunchModeRecommendations(
  verifyTimingSummaries,
  recommendationOptions,
) {
  return ['packaged', 'portable']
    .map(launchMode => {
      const recommendation = buildDurationRecommendation(
        verifyTimingSummaries
          .filter(summary => summary.launchMode === launchMode)
          .map(summary => summary.totalDurationMs),
        recommendationOptions,
      );

      if (!recommendation) {
        return null;
      }

      return {
        launchMode,
        recommendation,
      };
    })
    .filter(Boolean);
}

export function buildMarkerLaunchModeRecommendations(timingSummaries, recommendationOptions) {
  return ['packaged', 'portable']
    .map(launchMode => {
      const launchTimingSummaries = timingSummaries.filter(
        summary => summary.launchMode === launchMode,
      );
      if (launchTimingSummaries.length === 0) {
        return null;
      }

      return {
        launchMode,
        recommendation: buildTimingBudgetRecommendation(
          launchTimingSummaries,
          recommendationOptions,
        ),
      };
    })
    .filter(Boolean);
}

function buildSuggestedDefaultItem({
  launchMode,
  markerRecommendation,
  verifyRecommendation,
}) {
  const startupMs = markerRecommendation?.startup?.recommendedBudgetMs ?? null;
  const scenarioMs = markerRecommendation?.scenario?.recommendedBudgetMs ?? null;
  const smokeMs =
    startupMs === null && scenarioMs === null
      ? null
      : Math.max(startupMs ?? 0, scenarioMs ?? 0);

  return {
    launchMode,
    readinessMs: smokeMs,
    scenarioMs,
    smokeMs,
    startupMs,
    verifyTotalMs: verifyRecommendation?.recommendedBudgetMs ?? null,
  };
}

export function buildSuggestedTimeoutDefaults({
  launchMode,
  markerLaunchModeRecommendations,
  overallRecommendation,
  verifyLaunchModeRecommendations,
  verifyTotalRecommendation,
}) {
  if (launchMode === 'all') {
    const markerByLaunchMode = new Map(
      markerLaunchModeRecommendations.map(item => [item.launchMode, item.recommendation]),
    );
    const verifyByLaunchMode = new Map(
      verifyLaunchModeRecommendations.map(item => [item.launchMode, item.recommendation]),
    );
    const perLaunchDefaults = ['packaged', 'portable']
      .map(candidateLaunchMode => {
        const markerRecommendation = markerByLaunchMode.get(candidateLaunchMode) ?? null;
        const verifyRecommendation = verifyByLaunchMode.get(candidateLaunchMode) ?? null;
        if (!markerRecommendation && !verifyRecommendation) {
          return null;
        }

        return buildSuggestedDefaultItem({
          launchMode: candidateLaunchMode,
          markerRecommendation,
          verifyRecommendation,
        });
      })
      .filter(Boolean);

    if (perLaunchDefaults.length > 0) {
      return perLaunchDefaults;
    }
  }

  if (!overallRecommendation && !verifyTotalRecommendation) {
    return [];
  }

  return [
    buildSuggestedDefaultItem({
      launchMode,
      markerRecommendation: overallRecommendation,
      verifyRecommendation: verifyTotalRecommendation,
    }),
  ];
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
  const verifyTimingSummaries = collectVerifyTimingSummaries(logContents, selectedLaunchMode);
  const verifyTotalRecommendation = buildDurationRecommendation(
    verifyTimingSummaries.map(summary => summary.totalDurationMs),
    recommendationOptions,
  );
  const markerLaunchModeRecommendations =
    selectedLaunchMode === 'all'
      ? buildMarkerLaunchModeRecommendations(timingSummaries, recommendationOptions)
      : [];
  const verifyLaunchModeRecommendations = buildVerifyLaunchModeRecommendations(
    verifyTimingSummaries,
    recommendationOptions,
  );
  if (timingSummaries.length === 0) {
    if (allowVerifyOnly && verifyTotalRecommendation) {
      const suggestedTimeoutDefaults = buildSuggestedTimeoutDefaults({
        launchMode: selectedLaunchMode,
        markerLaunchModeRecommendations: [],
        overallRecommendation: null,
        verifyLaunchModeRecommendations,
        verifyTotalRecommendation,
      });
      return {
        headroomMs,
        launchMode: selectedLaunchMode,
        markerLaunchModeRecommendations: [],
        overallRecommendation: null,
        percentileLabel: formatPercentileLabel(percentileValue),
        percentileValue,
        scenarioRecommendations: [],
        suggestedTimeoutDefaults,
        verifyLaunchModeRecommendations,
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

  const overallRecommendation = buildTimingBudgetRecommendation(
    timingSummaries,
    recommendationOptions,
  );
  const suggestedTimeoutDefaults = buildSuggestedTimeoutDefaults({
    launchMode: selectedLaunchMode,
    markerLaunchModeRecommendations,
    overallRecommendation,
    verifyLaunchModeRecommendations,
    verifyTotalRecommendation,
  });
  return {
    headroomMs,
    launchMode: selectedLaunchMode,
    markerLaunchModeRecommendations,
    overallRecommendation,
    percentileLabel: formatPercentileLabel(percentileValue),
    percentileValue,
    scenarioRecommendations: buildScenarioRecommendationMap(timingSummaries, recommendationOptions),
    suggestedTimeoutDefaults,
    verifyLaunchModeRecommendations,
    verifyTotalRecommendation,
  };
}

function formatOptionalDuration(value) {
  return value === null ? 'n/a' : String(value);
}

export function formatSuggestedDefaultsTextReport({inputPath, report}) {
  const lines = [`[timing-report] input=${inputPath}`];

  if (report.suggestedTimeoutDefaults.length === 0) {
    lines.push('[timing-report] no suggested timeout defaults available for the selected inputs.');
    return lines.join('\n');
  }

  lines.push('[timing-report] suggested timeout defaults:');
  for (const item of report.suggestedTimeoutDefaults) {
    lines.push(
      `[timing-report] defaults launch=${item.launchMode} ` +
        `readinessMs=${formatOptionalDuration(item.readinessMs)} ` +
        `smokeMs=${formatOptionalDuration(item.smokeMs)} ` +
        `startupMs=${formatOptionalDuration(item.startupMs)} ` +
        `scenarioMs=${formatOptionalDuration(item.scenarioMs)} ` +
        `verifyTotalMs=${formatOptionalDuration(item.verifyTotalMs)}`,
    );
  }

  return lines.join('\n');
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

  if (report.launchMode === 'all' && report.markerLaunchModeRecommendations.length > 0) {
    lines.push('[timing-report] marker recommendations by launch mode:');
    for (const item of report.markerLaunchModeRecommendations) {
      lines.push(
        `[timing-report] marker launch=${item.launchMode} samples=${item.recommendation.sampleCount} ` +
          `startup${report.percentileLabel}=${item.recommendation.startup.percentileMs}ms ` +
          `scenario${report.percentileLabel}=${item.recommendation.scenario.percentileMs}ms ` +
          `recommended --startup-ms>=${item.recommendation.startup.recommendedBudgetMs} ` +
          `--scenario-ms>=${item.recommendation.scenario.recommendedBudgetMs}`,
      );
    }
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

  if (report.launchMode === 'all' && report.verifyLaunchModeRecommendations.length > 0) {
    lines.push('[timing-report] verify-total recommendations by launch mode:');
    for (const item of report.verifyLaunchModeRecommendations) {
      lines.push(
        `[timing-report] verify-total launch=${item.launchMode} ${report.percentileLabel}=${item.recommendation.percentileMs}ms ` +
          `max=${item.recommendation.maxMs}ms ` +
          `recommended verify timeout >=${item.recommendation.recommendedBudgetMs}`,
      );
    }
  }

  if (report.suggestedTimeoutDefaults.length > 0) {
    lines.push('[timing-report] suggested timeout defaults:');
    for (const item of report.suggestedTimeoutDefaults) {
      lines.push(
        `[timing-report] defaults launch=${item.launchMode} ` +
          `readinessMs=${formatOptionalDuration(item.readinessMs)} ` +
          `smokeMs=${formatOptionalDuration(item.smokeMs)} ` +
          `startupMs=${formatOptionalDuration(item.startupMs)} ` +
          `scenarioMs=${formatOptionalDuration(item.scenarioMs)} ` +
          `verifyTotalMs=${formatOptionalDuration(item.verifyTotalMs)}`,
      );
    }
  }

  return lines.join('\n');
}

export function buildSerializedReport({
  defaultsOnly = false,
  inputPaths,
  outputJson,
  report,
}) {
  const inputPathLabel = inputPaths.length === 1 ? inputPaths[0] : `${inputPaths.length} files`;

  if (outputJson) {
    if (defaultsOnly) {
      return JSON.stringify(
        {
          inputPaths,
          launchMode: report.launchMode,
          suggestedDefaults: report.suggestedTimeoutDefaults,
        },
        null,
        2,
      );
    }

    return JSON.stringify(
      {
        headroomMs: report.headroomMs,
        inputPaths,
        launchMode: report.launchMode,
        markerByLaunchMode: report.markerLaunchModeRecommendations,
        overall: report.overallRecommendation,
        percentile: report.percentileValue,
        scenarioRecommendations: report.scenarioRecommendations,
        suggestedDefaults: report.suggestedTimeoutDefaults,
        verifyByLaunchMode: report.verifyLaunchModeRecommendations,
        verifyTotal: report.verifyTotalRecommendation,
      },
      null,
      2,
    );
  }

  if (defaultsOnly) {
    return formatSuggestedDefaultsTextReport({
      inputPath: inputPathLabel,
      report,
    });
  }

  return formatTimingTextReport({
    inputPath: inputPathLabel,
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
  const defaultsOnly = argv.includes('--defaults-only');
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
    defaultsOnly,
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
