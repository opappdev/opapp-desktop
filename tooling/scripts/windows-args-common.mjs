export function parsePositiveIntegerArg(argv, flagName, defaultValue) {
  const argument = argv.find(entry => entry.startsWith(`${flagName}=`));
  if (!argument) {
    return defaultValue;
  }

  const rawValue = argument.slice(flagName.length + 1);
  const parsedValue = Number(rawValue);
  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    throw new Error(`${flagName} must be a positive number, got "${rawValue}"`);
  }

  return Math.floor(parsedValue);
}
