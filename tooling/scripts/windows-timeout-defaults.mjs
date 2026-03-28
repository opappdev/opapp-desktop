import {existsSync, readFileSync} from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const supportedLaunchModes = new Set(['all', 'packaged', 'portable']);
const optionalTimeoutFields = [
  'readinessMs',
  'smokeMs',
  'startupMs',
  'scenarioMs',
  'verifyTotalMs',
];

function findArgValues(argv, flagName) {
  return argv
    .filter(argument => argument.startsWith(`${flagName}=`))
    .map(argument => argument.slice(flagName.length + 1));
}

function normalizeOptionalPositiveTimeout(value, {defaultsPath, fieldName, launchMode}) {
  if (value === null || value === undefined) {
    return null;
  }

  const parsedValue = Number(value);
  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    throw new Error(
      `Invalid suggestedDefaults ${fieldName} for launch=${launchMode} in ${defaultsPath}: expected a positive number or null, got ${JSON.stringify(value)}.`,
    );
  }

  return Math.floor(parsedValue);
}

function normalizeSuggestedDefaultItem(rawItem, index, defaultsPath) {
  if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) {
    throw new Error(
      `Invalid suggestedDefaults[${index}] in ${defaultsPath}: expected an object.`,
    );
  }

  const rawLaunchMode = typeof rawItem.launchMode === 'string' ? rawItem.launchMode.trim() : '';
  if (!supportedLaunchModes.has(rawLaunchMode)) {
    throw new Error(
      `Invalid suggestedDefaults[${index}].launchMode in ${defaultsPath}: expected one of all, packaged, portable.`,
    );
  }

  const normalizedItem = {
    launchMode: rawLaunchMode,
  };
  for (const fieldName of optionalTimeoutFields) {
    normalizedItem[fieldName] = normalizeOptionalPositiveTimeout(rawItem[fieldName], {
      defaultsPath,
      fieldName,
      launchMode: rawLaunchMode,
    });
  }

  return normalizedItem;
}

function loadSuggestedDefaultsOrThrow(defaultsPath) {
  if (!existsSync(defaultsPath)) {
    throw new Error(`Timeout defaults file not found: ${defaultsPath}`);
  }

  let parsedPayload;
  try {
    parsedPayload = JSON.parse(readFileSync(defaultsPath, 'utf8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse timeout defaults JSON at ${defaultsPath}: ${message}`);
  }

  if (!parsedPayload || typeof parsedPayload !== 'object' || Array.isArray(parsedPayload)) {
    throw new Error(
      `Invalid timeout defaults payload in ${defaultsPath}: expected a JSON object.`,
    );
  }

  if (!Array.isArray(parsedPayload.suggestedDefaults)) {
    throw new Error(
      `Invalid timeout defaults payload in ${defaultsPath}: missing suggestedDefaults array.`,
    );
  }

  return parsedPayload.suggestedDefaults.map((item, index) =>
    normalizeSuggestedDefaultItem(item, index, defaultsPath),
  );
}

function selectDefaultsForLaunchOrThrow(suggestedDefaults, launchMode, defaultsPath) {
  const launchMatch = suggestedDefaults.find(item => item.launchMode === launchMode);
  if (launchMatch) {
    return launchMatch;
  }

  const aggregateMatch = suggestedDefaults.find(item => item.launchMode === 'all');
  if (aggregateMatch) {
    return aggregateMatch;
  }

  throw new Error(
    `No suggestedDefaults entry found for launch=${launchMode} in ${defaultsPath}. Add launch=${launchMode} or launch=all defaults.`,
  );
}

export function loadTimeoutDefaultsForLaunch({
  argv,
  launchMode,
  cwd = process.cwd(),
}) {
  if (!supportedLaunchModes.has(launchMode)) {
    throw new Error(
      `Unsupported launchMode "${launchMode}" while resolving --timeout-defaults. Expected one of all, packaged, portable.`,
    );
  }

  const rawDefaultsPaths = findArgValues(argv, '--timeout-defaults');
  if (rawDefaultsPaths.length === 0) {
    return null;
  }
  if (rawDefaultsPaths.length > 1) {
    throw new Error(
      `Duplicate --timeout-defaults arguments are not supported. Received ${rawDefaultsPaths.length} values.`,
    );
  }

  const rawDefaultsPath = rawDefaultsPaths[0];
  const defaultsPath = path.resolve(cwd, rawDefaultsPath);
  const suggestedDefaults = loadSuggestedDefaultsOrThrow(defaultsPath);
  const defaults = selectDefaultsForLaunchOrThrow(suggestedDefaults, launchMode, defaultsPath);

  return {
    defaults,
    defaultsPath,
  };
}
