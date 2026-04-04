function normalizeNonEmptyString(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeHostVersionString(value) {
  return normalizeNonEmptyString(value);
}

export function parseComparableHostVersion(value) {
  const normalized = normalizeHostVersionString(value);
  if (!normalized || !/^\d+(?:\.\d+){0,3}$/.test(normalized)) {
    return null;
  }

  const parts = normalized.split('.').map(part => Number.parseInt(part, 10));
  if (parts.some(part => !Number.isSafeInteger(part) || part < 0)) {
    return null;
  }

  return parts;
}

export function compareHostVersions(left, right) {
  const parsedLeft = parseComparableHostVersion(left);
  const parsedRight = parseComparableHostVersion(right);
  if (!parsedLeft || !parsedRight) {
    return null;
  }

  const width = Math.max(4, parsedLeft.length, parsedRight.length);
  for (let index = 0; index < width; index += 1) {
    const leftPart = parsedLeft[index] ?? 0;
    const rightPart = parsedRight[index] ?? 0;
    if (leftPart < rightPart) {
      return -1;
    }
    if (leftPart > rightPart) {
      return 1;
    }
  }

  return 0;
}

export function normalizeHostCompatibilityEntry(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const rawMinHostVersion = normalizeHostVersionString(value.minHostVersion);
  const rawMaxHostVersion = normalizeHostVersionString(value.maxHostVersion);
  const minHostVersion =
    rawMinHostVersion && parseComparableHostVersion(rawMinHostVersion)
      ? rawMinHostVersion
      : null;
  const maxHostVersion =
    rawMaxHostVersion && parseComparableHostVersion(rawMaxHostVersion)
      ? rawMaxHostVersion
      : null;
  if (!minHostVersion && !maxHostVersion) {
    return null;
  }

  return {
    ...(minHostVersion ? {minHostVersion} : {}),
    ...(maxHostVersion ? {maxHostVersion} : {}),
  };
}

export function normalizeHostCompatibilityMap(value, versions = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const versionSet = new Set(
    Array.isArray(versions)
      ? versions.filter(version => typeof version === 'string' && version.length > 0)
      : [],
  );

  const entries = Object.entries(value).flatMap(([version, compatibility]) => {
    if (typeof version !== 'string') {
      return [];
    }

    const normalizedVersion = version.trim();
    if (
      normalizedVersion.length === 0 ||
      (versionSet.size > 0 && !versionSet.has(normalizedVersion))
    ) {
      return [];
    }

    const normalizedCompatibility = normalizeHostCompatibilityEntry(compatibility);
    if (!normalizedCompatibility) {
      return [];
    }

    return [[normalizedVersion, normalizedCompatibility]];
  });

  if (entries.length === 0) {
    return null;
  }

  return Object.fromEntries(
    entries.sort(([left], [right]) => left.localeCompare(right)),
  );
}

export function isVersionCompatibleWithHost({
  version,
  hostVersion,
  hostCompatibility,
}) {
  if (typeof version !== 'string' || version.trim().length === 0) {
    return false;
  }

  const normalizedVersion = version.trim();
  const compatibility = hostCompatibility?.[normalizedVersion] ?? null;
  if (!compatibility) {
    return true;
  }

  const normalizedHostVersion = normalizeHostVersionString(hostVersion);
  if (!normalizedHostVersion) {
    return true;
  }

  if (compatibility.minHostVersion) {
    const minComparison = compareHostVersions(
      normalizedHostVersion,
      compatibility.minHostVersion,
    );
    if (minComparison === null || minComparison < 0) {
      return false;
    }
  }

  if (compatibility.maxHostVersion) {
    const maxComparison = compareHostVersions(
      normalizedHostVersion,
      compatibility.maxHostVersion,
    );
    if (maxComparison === null || maxComparison > 0) {
      return false;
    }
  }

  return true;
}

export function pickLatestCompatibleVersion({
  versions,
  legacyLatestVersion,
  hostVersion,
  hostCompatibility,
}) {
  const normalizedVersions = Array.isArray(versions)
    ? [...new Set(versions.filter(version => typeof version === 'string' && version.length > 0))].sort()
    : [];

  for (let index = normalizedVersions.length - 1; index >= 0; index -= 1) {
    const version = normalizedVersions[index];
    if (
      isVersionCompatibleWithHost({
        version,
        hostVersion,
        hostCompatibility,
      })
    ) {
      return version;
    }
  }

  const normalizedLegacyLatestVersion = normalizeNonEmptyString(legacyLatestVersion);
  if (
    normalizedVersions.length === 0 &&
    normalizedLegacyLatestVersion &&
    isVersionCompatibleWithHost({
      version: normalizedLegacyLatestVersion,
      hostVersion,
      hostCompatibility,
    })
  ) {
    return normalizedLegacyLatestVersion;
  }

  return null;
}
