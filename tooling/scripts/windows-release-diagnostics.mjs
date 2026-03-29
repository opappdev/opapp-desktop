import {spawnSync} from 'node:child_process';
import {existsSync, mkdtempSync, readdirSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';

function normalizeText(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function truncateOneLine(value, maxLength = 200) {
  const normalized = String(value ?? '')
    .replace(/\r/g, '')
    .split('\n')[0]
    .trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 3)}...`;
}

function collectOutputLines(...chunks) {
  return chunks.flatMap(chunk =>
    String(chunk ?? '')
      .replace(/\r/g, '')
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean),
  );
}

function summarizeIcaclsOutput(stdout, stderr) {
  const lines = collectOutputLines(stdout, stderr);
  if (lines.length === 0) {
    return null;
  }

  const detailLines = lines.filter(
    line => !/^Successfully processed \d+ files; Failed processing \d+ files$/i.test(line),
  );
  const summaryLines = detailLines.length > 0 ? detailLines : lines;
  return truncateOneLine(summaryLines.join(' | '), 160);
}

function probeStatusSummary(probe) {
  if (!probe) {
    return 'n/a';
  }

  const status = probe.status ?? 'null';
  if (probe.ok) {
    if (probe.captureBlocked) {
      return `ok(status=${status}, capture=blocked)`;
    }
    return `ok(status=${status})`;
  }

  const parts = [`failed(status=${status}`];
  if (probe.errorCode) {
    parts.push(`code=${probe.errorCode}`);
  }
  if (probe.errorMessage) {
    parts.push(`message=${truncateOneLine(probe.errorMessage, 140)}`);
  }

  return `${parts.join(', ')})`;
}

function toYesNo(value) {
  return value ? 'yes' : 'no';
}

function runProbe(spawn, command, args, {captureOutput = false} = {}) {
  const captureOptions = {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false,
  };
  const basicOptions = {
    stdio: 'ignore',
    windowsHide: false,
  };

  if (!captureOutput) {
    const result = spawn(command, args, basicOptions);
    return {
      ok: result.status === 0 && !result.error,
      status: result.status,
      errorCode: result.error?.code ?? null,
      errorMessage: result.error?.message ?? null,
      stdout: '',
      stderr: '',
      captureBlocked: false,
    };
  }

  const captureResult = spawn(command, args, captureOptions);
  if (captureResult.error?.code === 'EPERM') {
    const fallbackResult = spawn(command, args, basicOptions);
    return {
      ok: fallbackResult.status === 0 && !fallbackResult.error,
      status: fallbackResult.status,
      errorCode: fallbackResult.error?.code ?? null,
      errorMessage:
        fallbackResult.error?.message ??
        (fallbackResult.status === 0
          ? 'Output capture blocked by environment; fallback probe without pipe succeeded.'
          : captureResult.error.message),
      stdout: '',
      stderr: '',
      captureBlocked: true,
    };
  }

  return {
    ok: captureResult.status === 0 && !captureResult.error,
    status: captureResult.status,
    errorCode: captureResult.error?.code ?? null,
    errorMessage: captureResult.error?.message ?? null,
    stdout: captureResult.stdout ?? '',
    stderr: captureResult.stderr ?? '',
    captureBlocked: false,
  };
}

function parseJsonOutput(rawOutput) {
  try {
    return JSON.parse(String(rawOutput ?? '').replace(/^\uFEFF/, '').trim());
  } catch {
    return null;
  }
}

function parseVswhereOutput(rawOutput) {
  const parsed = parseJsonOutput(rawOutput);
  return Array.isArray(parsed) ? parsed : null;
}

function probeVswhereWithTempFile(vswherePath, {
  spawn = spawnSync,
} = {}) {
  const normalizedVswherePath = normalizeText(vswherePath);
  if (!normalizedVswherePath) {
    return {
      probe: null,
      installs: null,
    };
  }

  const tempDir = mkdtempSync(path.join(tmpdir(), 'opapp-vswhere-'));
  const outputPath = path.join(tempDir, 'vswhere.json');
  const escapedVswherePath = normalizedVswherePath.replace(/'/g, "''");
  const escapedOutputPath = outputPath.replace(/'/g, "''");

  try {
    const result = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        `$ErrorActionPreference = 'Stop'; ` +
          `$vswhereArgs = @('-products', '*', '-requires', 'Microsoft.Component.MSBuild', '-latest', '-format', 'json', '-utf8'); ` +
          `& '${escapedVswherePath}' @vswhereArgs | Set-Content -LiteralPath '${escapedOutputPath}' -Encoding utf8`,
      ],
      {
        stdio: 'ignore',
        windowsHide: false,
      },
    );

    if (result.status !== 0 || result.error) {
      return {
        probe: {
          ok: false,
          status: result.status,
          errorCode: result.error?.code ?? null,
          errorMessage: truncateOneLine(result.error?.message ?? '', 160),
          stdout: '',
          stderr: '',
          captureBlocked: false,
        },
        installs: null,
      };
    }

    if (!existsSync(outputPath)) {
      return {
        probe: {
          ok: false,
          status: result.status,
          errorCode: 'NO_OUTPUT',
          errorMessage: 'vswhere temp-file probe did not produce JSON output',
          stdout: '',
          stderr: '',
          captureBlocked: false,
        },
        installs: null,
      };
    }

    const parsed = parseVswhereOutput(readFileSync(outputPath, 'utf8'));
    if (!parsed) {
      return {
        probe: {
          ok: false,
          status: result.status,
          errorCode: 'PARSE_ERROR',
          errorMessage: 'vswhere temp-file probe returned non-JSON output',
          stdout: '',
          stderr: '',
          captureBlocked: false,
        },
        installs: null,
      };
    }

    return {
      probe: {
        ok: true,
        status: result.status,
        errorCode: null,
        errorMessage: 'Output capture redirected to temp file because pipe capture is blocked.',
        stdout: '',
        stderr: '',
        captureBlocked: false,
      },
      installs: parsed,
    };
  } finally {
    rmSync(tempDir, {recursive: true, force: true});
  }
}

function probePathAccess(pathValue, {
  exists = existsSync,
  readDir = readdirSync,
} = {}) {
  const targetPath = normalizeText(pathValue);
  if (!targetPath) {
    return {
      path: null,
      exists: false,
      accessible: false,
      errorMessage: null,
    };
  }

  if (!exists(targetPath)) {
    return {
      path: targetPath,
      exists: false,
      accessible: false,
      errorMessage: null,
    };
  }

  try {
    readDir(targetPath);
    return {
      path: targetPath,
      exists: true,
      accessible: true,
      errorMessage: null,
    };
  } catch (error) {
    return {
      path: targetPath,
      exists: true,
      accessible: false,
      errorMessage: truncateOneLine(error?.message ?? String(error), 160),
    };
  }
}

function probePathAcl(pathValue, {
  spawn = spawnSync,
} = {}) {
  const targetPath = normalizeText(pathValue);
  if (!targetPath) {
    return null;
  }

  const escapedPath = targetPath.replace(/'/g, "''");
  const tempDir = mkdtempSync(path.join(tmpdir(), 'opapp-windows-acl-'));
  const outputPath = path.join(tempDir, 'acl.json');
  const escapedOutputPath = outputPath.replace(/'/g, "''");

  try {
    const aclProbe = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        `$ErrorActionPreference = 'Stop'; ` +
          `try { ` +
          `$acl = Get-Acl -LiteralPath '${escapedPath}'; ` +
          `[pscustomobject]@{Ok=$true;Path=$acl.Path;Owner=$acl.Owner;AccessToString=$acl.AccessToString;ErrorMessage=$null} | ` +
          `ConvertTo-Json -Compress | Set-Content -LiteralPath '${escapedOutputPath}' -Encoding utf8; ` +
          `} catch { ` +
          `[pscustomobject]@{Ok=$false;Path='${escapedPath}';Owner=$null;AccessToString=$null;ErrorMessage=$_.Exception.Message} | ` +
          `ConvertTo-Json -Compress | Set-Content -LiteralPath '${escapedOutputPath}' -Encoding utf8; ` +
          `}`,
      ],
      {
        stdio: 'ignore',
        windowsHide: false,
      },
    );

    if (aclProbe.status !== 0 || aclProbe.error) {
      return {
        path: targetPath,
        ok: false,
        status: aclProbe.status,
        errorCode: aclProbe.error?.code ?? null,
        errorMessage: truncateOneLine(aclProbe.error?.message ?? '', 160),
        captureBlocked: false,
        owner: null,
        accessToString: null,
      };
    }

    if (!existsSync(outputPath)) {
      return {
        path: targetPath,
        ok: false,
        status: aclProbe.status,
        errorCode: 'NO_OUTPUT',
        errorMessage: 'Get-Acl probe did not produce a JSON report file',
        captureBlocked: false,
        owner: null,
        accessToString: null,
      };
    }

    const parsed = parseJsonOutput(readFileSync(outputPath, 'utf8'));
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
      return {
        path: targetPath,
        ok: false,
        status: aclProbe.status,
        errorCode: 'PARSE_ERROR',
        errorMessage: 'Get-Acl returned non-JSON output',
        captureBlocked: false,
        owner: null,
        accessToString: null,
      };
    }

    if (parsed.Ok === false) {
      return {
        path: normalizeText(parsed.Path) ?? targetPath,
        ok: false,
        status: aclProbe.status,
        errorCode: 'GET_ACL_FAILED',
        errorMessage: truncateOneLine(parsed.ErrorMessage ?? 'Get-Acl failed', 160),
        captureBlocked: false,
        owner: null,
        accessToString: null,
      };
    }

    return {
      path: normalizeText(parsed.Path) ?? targetPath,
      ok: true,
      status: aclProbe.status,
      errorCode: null,
      errorMessage: null,
      captureBlocked: false,
      owner: normalizeText(parsed.Owner),
      accessToString: normalizeText(parsed.AccessToString),
    };
  } finally {
    rmSync(tempDir, {recursive: true, force: true});
  }
}

function probePathIcacls(pathValue, {
  spawn = spawnSync,
  cmdPath = 'cmd.exe',
} = {}) {
  const targetPath = normalizeText(pathValue);
  if (!targetPath) {
    return null;
  }

  const escapedCmdPath = targetPath.replace(/"/g, '""');
  const directProbe = runProbe(
    spawn,
    cmdPath,
    ['/d', '/s', '/c', `icacls "${escapedCmdPath}"`],
    {captureOutput: true},
  );
  const directDetail = summarizeIcaclsOutput(directProbe.stdout, directProbe.stderr);

  if (directDetail) {
    return {
      path: targetPath,
      ok: directProbe.ok,
      status: directProbe.status,
      errorCode: directProbe.errorCode,
      errorMessage: directProbe.ok
        ? null
        : truncateOneLine(directDetail ?? directProbe.errorMessage ?? '', 160),
      captureBlocked: directProbe.captureBlocked,
      detail: directProbe.ok ? directDetail : null,
    };
  }

  const tempDir = mkdtempSync(path.join(tmpdir(), 'opapp-windows-icacls-'));
  const outputPath = path.join(tempDir, 'icacls.txt');
  const escapedOutputPath = outputPath.replace(/"/g, '""');

  try {
    const icaclsProbe = spawn(cmdPath, [
      '/d',
      '/s',
      '/c',
      `icacls "${escapedCmdPath}" > "${escapedOutputPath}" 2>&1`,
    ], {
      stdio: 'ignore',
      windowsHide: false,
    });
    const detail = existsSync(outputPath)
      ? summarizeIcaclsOutput(readFileSync(outputPath, 'utf8'), '')
      : null;

    return {
      path: targetPath,
      ok: icaclsProbe.status === 0 && !icaclsProbe.error,
      status: icaclsProbe.status,
      errorCode: icaclsProbe.error?.code ?? null,
      errorMessage:
        icaclsProbe.status === 0 && !icaclsProbe.error
          ? null
          : (detail ?? truncateOneLine(icaclsProbe.error?.message ?? '', 160)),
      captureBlocked: false,
      detail: icaclsProbe.status === 0 && !icaclsProbe.error ? detail : null,
    };
  } finally {
    rmSync(tempDir, {recursive: true, force: true});
  }
}

export function collectReleaseBuildProbe({
  env = process.env,
  spawn = spawnSync,
  exists = existsSync,
  readDir = readdirSync,
} = {}) {
  const systemRoot = normalizeText(env.SystemRoot) ?? normalizeText(env.WINDIR) ?? 'C:\\Windows';
  const cmdPath = path.join(systemRoot, 'System32', 'cmd.exe');
  const programFilesX86 =
    normalizeText(env['ProgramFiles(x86)']) ?? normalizeText(env.ProgramFiles) ?? 'C:\\Program Files (x86)';
  const vswherePath = path.join(programFilesX86, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');

  const cmdExists = exists(cmdPath);
  const cmdProbe = cmdExists
    ? runProbe(spawn, cmdPath, ['/c', 'ver'])
    : {
        ok: false,
        status: null,
        errorCode: 'MISSING',
        errorMessage: `cmd.exe not found at ${cmdPath}`,
        stdout: '',
        stderr: '',
        captureBlocked: false,
      };

  const vswhereExists = exists(vswherePath);
  let vswhereProbe = vswhereExists
    ? runProbe(
        spawn,
        vswherePath,
        [
          '-products',
          '*',
          '-requires',
          'Microsoft.Component.MSBuild',
          '-latest',
          '-format',
          'json',
          '-utf8',
        ],
        {captureOutput: true},
      )
    : {
        ok: false,
        status: null,
        errorCode: 'MISSING',
        errorMessage: `vswhere.exe not found at ${vswherePath}`,
        stdout: '',
        stderr: '',
        captureBlocked: false,
      };

  let vswhereInstalls = [];
  if (vswhereProbe.ok && vswhereProbe.captureBlocked) {
    const redirectedVswhereProbe = probeVswhereWithTempFile(vswherePath, {spawn});
    if (redirectedVswhereProbe.probe) {
      vswhereProbe = redirectedVswhereProbe.probe;
      if (redirectedVswhereProbe.probe.ok && Array.isArray(redirectedVswhereProbe.installs)) {
        vswhereInstalls = redirectedVswhereProbe.installs;
      }
    }
  } else if (vswhereProbe.ok && !vswhereProbe.captureBlocked) {
    const parsed = parseVswhereOutput(vswhereProbe.stdout);
    if (parsed) {
      vswhereInstalls = parsed;
    } else {
      vswhereProbe = {
        ...vswhereProbe,
        ok: false,
        errorCode: 'PARSE_ERROR',
        errorMessage: 'vswhere returned non-JSON output',
      };
    }
  }

  const msbuildCandidatesUnknown = vswhereProbe.ok && vswhereProbe.captureBlocked;
  const msbuildCandidates = vswhereInstalls.map(install => {
    const installationPath = normalizeText(install.installationPath);
    const msbuildPath = installationPath
      ? path.join(installationPath, 'MSBuild', 'Current', 'Bin', 'amd64', 'msbuild.exe')
      : null;

    return {
      displayName: normalizeText(install.displayName),
      installationVersion: normalizeText(install.installationVersion),
      installationPath,
      msbuildPath,
      exists: msbuildPath ? exists(msbuildPath) : false,
    };
  });

  const localAppDataPath =
    normalizeText(env.LOCALAPPDATA) ??
    (normalizeText(env.USERPROFILE) ? path.join(normalizeText(env.USERPROFILE), 'AppData', 'Local') : null);
  const localMicrosoftSdkProbe = probePathAccess(
    localAppDataPath ? path.join(localAppDataPath, 'Microsoft SDKs') : null,
    {
      exists,
      readDir,
    },
  );
  const localMicrosoftSdkAclProbe =
    localMicrosoftSdkProbe?.exists && !localMicrosoftSdkProbe.accessible
    ? probePathAcl(localMicrosoftSdkProbe.path, {spawn})
    : null;
  const localMicrosoftSdkIcaclsProbe =
    localMicrosoftSdkProbe?.exists && !localMicrosoftSdkProbe.accessible
    ? probePathIcacls(localMicrosoftSdkProbe.path, {spawn, cmdPath})
    : null;

  return {
    cmdPath,
    cmdExists,
    cmdProbe,
    minimumVisualStudioVersion: normalizeText(env.MinimumVisualStudioVersion),
    systemRoot,
    visualStudioVersion: normalizeText(env.VisualStudioVersion),
    vswherePath,
    vswhereExists,
    vswhereProbe,
    msbuildCandidatesUnknown,
    msbuildCandidates,
    localMicrosoftSdkProbe,
    localMicrosoftSdkAclProbe,
    localMicrosoftSdkIcaclsProbe,
  };
}

function addPortableMsbuildFallbackCandidate(candidates, seen, candidatePath, exists) {
  const normalizedPath = normalizeText(candidatePath);
  if (!normalizedPath) {
    return;
  }
  if (seen.has(normalizedPath)) {
    return;
  }
  if (!exists(normalizedPath)) {
    return;
  }
  seen.add(normalizedPath);
  candidates.push(normalizedPath);
}

export function collectPortableMsbuildFallbackCandidates({
  probe,
  env = process.env,
  exists = existsSync,
} = {}) {
  const candidates = [];
  const seen = new Set();

  addPortableMsbuildFallbackCandidate(
    candidates,
    seen,
    normalizeText(env.OPAPP_WINDOWS_MSBUILD_PATH),
    exists,
  );

  if (Array.isArray(probe?.msbuildCandidates)) {
    for (const candidate of probe.msbuildCandidates) {
      if (!candidate?.exists) {
        continue;
      }
      addPortableMsbuildFallbackCandidate(candidates, seen, candidate.msbuildPath, exists);
    }
  }

  const programFileRoots = [
    normalizeText(env.ProgramFiles),
    normalizeText(env['ProgramFiles(x86)']),
  ].filter(Boolean);
  const visualStudioYears = ['2022', '2019'];
  const visualStudioEditions = ['BuildTools', 'Community', 'Professional', 'Enterprise', 'Preview'];

  for (const root of programFileRoots) {
    for (const year of visualStudioYears) {
      for (const edition of visualStudioEditions) {
        addPortableMsbuildFallbackCandidate(
          candidates,
          seen,
          path.join(
            root,
            'Microsoft Visual Studio',
            year,
            edition,
            'MSBuild',
            'Current',
            'Bin',
            'amd64',
            'msbuild.exe',
          ),
          exists,
        );
      }
    }
  }

  return candidates;
}

export function collectPortableMsbuildFallbackProfiles({
  env = process.env,
} = {}) {
  const profiles = [
    {
      id: 'restore-build',
      description: 'solution build with restore',
      args: [
        '/restore',
        '/t:Build',
        '/p:Configuration=Release',
        '/p:Platform=x64',
        '/p:AppxBundle=Never',
        '/p:UapAppxPackageBuildMode=SideLoadOnly',
        '/m',
      ],
    },
  ];

  if (normalizeText(env.OPAPP_WINDOWS_MSBUILD_FALLBACK_TRY_NO_RESTORE) !== '0') {
    profiles.push({
      id: 'no-restore-host-target',
      description: 'host-target build without restore',
      args: [
        '/t:OpappWindowsHost',
        '/p:Restore=false',
        '/p:Configuration=Release',
        '/p:Platform=x64',
        '/p:AppxBundle=Never',
        '/p:UapAppxPackageBuildMode=SideLoadOnly',
        '/m',
      ],
    });
  }

  return profiles;
}

const FAILURE_CLASSIFIERS = [
  {
    code: 'local-sdk-acl-denied',
    summary: 'Local Microsoft SDKs ACL blocks MSBuild SDK resolution',
    matcher:
      /Local Microsoft SDKs path is not readable|Microsoft SDKs.+(?:Access is denied|访问被拒绝)|Get(?:PlatformSDKLocation|LatestSDKTargetPlatformVersion)\([^)]+\).*?(?:Access is denied|访问被拒绝)/i,
  },
  {
    code: 'cmd-spawn-eperm',
    summary: 'nested cmd spawn rejected (EPERM)',
    matcher: /spawn(?:Sync)?\s+[^\r\n]*cmd\.exe\s+EPERM/i,
  },
  {
    code: 'process-spawn-eperm',
    summary: 'process spawn rejected (EPERM)',
    matcher: /spawnSync\s+[^\r\n]+EPERM/i,
  },
  {
    code: 'vswhere-missing',
    summary: 'vswhere.exe missing',
    matcher: /Unable to find vswhere/i,
  },
  {
    code: 'vs-install-not-found',
    summary: 'no compatible Visual Studio installation discovered',
    matcher: /No public VS release found|No VS prerelease found|Could not find MSBuild/i,
  },
  {
    code: 'msbuild-missing',
    summary: 'MSBuild tools unavailable',
    matcher: /MSBuild tools not found|NoMSBuild/i,
  },
  {
    code: 'msbuild-build-failure',
    summary: 'MSBuild invocation failed',
    matcher: /\bMSBuildError\b|\bMSB\d{4}\b/i,
  },
];

export function classifyRunWindowsFailure(outputText) {
  const normalizedOutput = String(outputText ?? '');

  for (const classifier of FAILURE_CLASSIFIERS) {
    if (classifier.matcher.test(normalizedOutput)) {
      return {
        code: classifier.code,
        summary: classifier.summary,
      };
    }
  }

  return {
    code: 'unknown',
    summary: 'unclassified run-windows failure',
  };
}

export function refineReleaseFailureClassification({
  classification,
  probe,
  result,
}) {
  if (classification.code !== 'unknown') {
    return classification;
  }

  if (result.status !== 4294967295) {
    return classification;
  }

  const cmdProbeHealthy = probe.cmdExists && probe.cmdProbe.ok;
  const vswhereCaptureBlocked = probe.vswhereProbe.ok && probe.vswhereProbe.captureBlocked;
  if (cmdProbeHealthy && vswhereCaptureBlocked) {
    return classifyRunWindowsFailure('spawnSync C:\\WINDOWS\\system32\\cmd.exe EPERM');
  }

  return classifyRunWindowsFailure('spawnSync process EPERM');
}

export function formatReleaseProbeForLogs(probe) {
  const lines = [
    `cmd path=${probe.cmdPath} exists=${toYesNo(probe.cmdExists)} probe=${probeStatusSummary(probe.cmdProbe)}`,
    `vswhere path=${probe.vswherePath} exists=${toYesNo(probe.vswhereExists)} probe=${probeStatusSummary(probe.vswhereProbe)}`,
    `env VisualStudioVersion=${probe.visualStudioVersion ?? '<unset>'} MinimumVisualStudioVersion=${probe.minimumVisualStudioVersion ?? '<unset>'}`,
  ];

  if (probe.localMicrosoftSdkProbe?.path) {
    lines.push(
      `local sdk path=${probe.localMicrosoftSdkProbe.path} exists=${toYesNo(probe.localMicrosoftSdkProbe.exists)} ` +
        `accessible=${toYesNo(probe.localMicrosoftSdkProbe.accessible)}`,
    );
    if (probe.localMicrosoftSdkProbe.exists && !probe.localMicrosoftSdkProbe.accessible) {
      lines.push(
        `local sdk access-error=${truncateOneLine(probe.localMicrosoftSdkProbe.errorMessage ?? 'access denied', 160)}`,
      );
    }
  }

  if (probe.localMicrosoftSdkAclProbe?.path) {
    lines.push(`local sdk acl probe=${probeStatusSummary(probe.localMicrosoftSdkAclProbe)}`);
    if (probe.localMicrosoftSdkAclProbe.ok && probe.localMicrosoftSdkAclProbe.owner) {
      lines.push(
        `local sdk acl owner=${truncateOneLine(probe.localMicrosoftSdkAclProbe.owner, 160)}`,
      );
    }
    if (probe.localMicrosoftSdkAclProbe.ok && probe.localMicrosoftSdkAclProbe.accessToString) {
      lines.push(
        `local sdk acl access=${truncateOneLine(probe.localMicrosoftSdkAclProbe.accessToString, 160)}`,
      );
    }
  }

  if (probe.localMicrosoftSdkIcaclsProbe?.path) {
    lines.push(`local sdk icacls probe=${probeStatusSummary(probe.localMicrosoftSdkIcaclsProbe)}`);
    if (probe.localMicrosoftSdkIcaclsProbe.ok && probe.localMicrosoftSdkIcaclsProbe.detail) {
      lines.push(
        `local sdk icacls detail=${truncateOneLine(probe.localMicrosoftSdkIcaclsProbe.detail, 160)}`,
      );
    }
  }

  if (probe.msbuildCandidatesUnknown) {
    lines.push('msbuild candidates=<unknown (vswhere output capture blocked)>');
    return lines;
  }

  if (!probe.msbuildCandidates || probe.msbuildCandidates.length === 0) {
    lines.push('msbuild candidates=<none>');
    return lines;
  }

  const existingCount = probe.msbuildCandidates.filter(candidate => candidate.exists).length;
  lines.push(`msbuild candidates=${probe.msbuildCandidates.length} available=${existingCount}`);

  for (const candidate of probe.msbuildCandidates.slice(0, 2)) {
    const version = candidate.installationVersion ?? '<unknown-version>';
    lines.push(
      `msbuild candidate version=${version} exists=${toYesNo(candidate.exists)} path=${candidate.msbuildPath ?? '<unknown-path>'}`,
    );
  }

  return lines;
}

function buildActionHints(classification, probe) {
  const hints = [];

  if (classification.code === 'local-sdk-acl-denied') {
    hints.push(
      'MSBuild SDK resolution is blocked before restore/build because ToolLocationHelper cannot read the per-user `Local Microsoft SDKs` directory.',
    );
    hints.push(
      'Fix the ACL on that directory or rerun on a machine/profile where `C:\\Users\\<user>\\AppData\\Local\\Microsoft SDKs` is readable.',
    );
    hints.push(
      'Portable MSBuild fallback does not bypass this class of failure, because the same SDK discovery API runs inside MSBuild evaluation.',
    );
    hints.push(
      'If you need the full upstream MSBuild output after confirming the preflight diagnosis, rerun once with `OPAPP_WINDOWS_RELEASE_SKIP_PREFLIGHT_FAILFAST=1`.',
    );
    hints.push(
      'Use `npm run report:windows:release-probe` or `npm run report:windows:release-probe:json` to capture the same blocker diagnosis without running the smoke harness.',
    );
  } else if (classification.code === 'cmd-spawn-eperm') {
    hints.push(
      '@react-native-windows/cli failed while spawning nested cmd.exe during vswhere probing, which usually points to sandbox/endpoint policy restrictions.',
    );
    hints.push(
      'Compare direct cmd execution with Node child-process execution; if only the nested path fails, this is likely an environment policy issue rather than project config.',
    );
    hints.push('Re-run `npm run verify:windows:portable` on a non-sandbox machine to confirm release-chain health.');
    hints.push(
      'For portable checks, use direct msbuild fallback by setting OPAPP_WINDOWS_MSBUILD_PATH when auto-discovery misses your Visual Studio install; set OPAPP_WINDOWS_RELEASE_FORCE_MSBUILD_FALLBACK=1 to override local SDK ACL blockers.',
    );
  } else if (classification.code === 'process-spawn-eperm') {
    hints.push('A child process was blocked with EPERM before release build completion, which strongly suggests host/sandbox policy restrictions.');
    hints.push('Retry from a machine/session with fewer execution constraints to verify whether this is environmental.');
  } else if (classification.code === 'vswhere-missing') {
    hints.push('Install Visual Studio Installer components that provide vswhere.exe or repair the Visual Studio installation.');
  } else if (classification.code === 'vs-install-not-found' || classification.code === 'msbuild-missing') {
    hints.push('Install/repair Visual Studio 2022 Build Tools with `Microsoft.Component.MSBuild` and matching VC toolchain components.');
  } else {
    hints.push('Inspect run-windows output above for the first upstream failure marker and map it to VS discovery, MSBuild, or deploy stages.');
  }

  if (!probe.cmdExists) {
    hints.push(`cmd.exe is missing at ${probe.cmdPath}; verify SystemRoot and base OS image.`);
  } else if (!probe.cmdProbe.ok) {
    hints.push(
      `Direct cmd probe failed (${probe.cmdProbe.errorCode ?? probe.cmdProbe.status ?? 'unknown'}): ${truncateOneLine(probe.cmdProbe.errorMessage ?? probe.cmdProbe.stderr, 160)}`,
    );
  }

  if (!probe.vswhereExists) {
    hints.push(`vswhere.exe not found at ${probe.vswherePath}.`);
  } else if (!probe.vswhereProbe.ok) {
    hints.push(
      `Direct vswhere probe failed (${probe.vswhereProbe.errorCode ?? probe.vswhereProbe.status ?? 'unknown'}): ${truncateOneLine(probe.vswhereProbe.errorMessage ?? probe.vswhereProbe.stderr, 160)}`,
    );
  } else if (probe.vswhereProbe.captureBlocked) {
    hints.push('Direct vswhere command succeeded, but structured output capture is blocked in this environment.');
  } else if (probe.msbuildCandidates.length === 0) {
    hints.push('Direct vswhere probe succeeded but found no installation satisfying `Microsoft.Component.MSBuild`.');
  } else if (!probe.msbuildCandidates.some(candidate => candidate.exists)) {
    hints.push('Visual Studio installs were detected, but expected `MSBuild/Current/Bin/amd64/msbuild.exe` paths are missing.');
  }

  if (probe.localMicrosoftSdkProbe?.exists && !probe.localMicrosoftSdkProbe.accessible) {
    const sdkPath = probe.localMicrosoftSdkProbe.path;
    const aclProbe = probe.localMicrosoftSdkAclProbe;
    const icaclsProbe = probe.localMicrosoftSdkIcaclsProbe;
    hints.push(
      `Local Microsoft SDKs path is not readable (${sdkPath}): ${probe.localMicrosoftSdkProbe.errorMessage ?? 'access denied'}.`,
    );
    if (aclProbe?.ok) {
      if (aclProbe.captureBlocked) {
        hints.push('Automated `Get-Acl` probing succeeded, but structured output capture is blocked in this environment.');
      } else {
        if (aclProbe.owner) {
          hints.push(`Detected Local Microsoft SDKs ACL owner: ${aclProbe.owner}.`);
        }
        if (aclProbe.accessToString) {
          hints.push(
            `Detected Local Microsoft SDKs ACL entries (truncated): ${truncateOneLine(aclProbe.accessToString, 160)}.`,
          );
        }
      }
    } else if (aclProbe?.path) {
      hints.push(
        `Automated Get-Acl probe failed (${aclProbe.errorCode ?? aclProbe.status ?? 'unknown'}): ` +
          `${truncateOneLine(aclProbe.errorMessage ?? 'unknown ACL probe failure', 160)}.`,
      );
      if (/module could not be loaded|Import-Module/i.test(aclProbe.errorMessage ?? '')) {
        hints.push(
          'The current PowerShell host cannot load `Microsoft.PowerShell.Security`; retry `Get-Acl` from Windows PowerShell or an elevated/full-trust session.',
        );
      }
    }
    if (icaclsProbe?.ok) {
      if (icaclsProbe.captureBlocked) {
        hints.push('Direct `icacls` execution succeeded, but structured output capture is blocked in this environment.');
      } else if (icaclsProbe.detail) {
        hints.push(`Direct icacls ACL view (truncated): ${truncateOneLine(icaclsProbe.detail, 160)}.`);
      }
    } else if (icaclsProbe?.path) {
      hints.push(
        `Direct icacls probe result (${icaclsProbe.errorCode ?? icaclsProbe.status ?? 'unknown'}): ` +
          `${truncateOneLine(icaclsProbe.errorMessage ?? 'unknown icacls probe failure', 160)}.`,
      );
      if (/^Successfully processed 0 files; Failed processing 1 files$/i.test(icaclsProbe.errorMessage ?? '')) {
        hints.push(
          `This redirected icacls invocation only surfaced the summary line; rerun \`icacls "${sdkPath}"\` interactively in cmd.exe or Windows PowerShell to inspect the denied entry text.`,
        );
      }
    }
    hints.push(
      `Inspect ACL details before retrying portable fallback: powershell -NoProfile -Command "Get-Acl '${sdkPath}' | Format-List"`,
    );
    hints.push(
      'If `Get-Acl` is also unauthorized in the current session, inspect/fix the directory from an elevated or less-restricted Windows session before retrying verify.',
    );
  }

  return hints;
}

function formatProbeFailure(name, probe) {
  const code = probe?.errorCode ?? (probe?.status ?? 'unknown');
  const detail = truncateOneLine(probe?.errorMessage ?? probe?.stderr ?? '', 160);
  return `${name} probe failed (${code})${detail ? `: ${detail}` : ''}`;
}

export function getBlockingReleaseProbeFailure(probe) {
  if (!probe.cmdExists) {
    return {
      code: 'CMD_MISSING',
      reason: `cmd.exe not found at ${probe.cmdPath}`,
      classifierHint: `spawnSync ${probe.cmdPath} EPERM`,
    };
  }

  if (!probe.cmdProbe.ok) {
    return {
      code: probe.cmdProbe.errorCode ?? 'CMD_PROBE_FAILED',
      reason: formatProbeFailure('cmd', probe.cmdProbe),
      classifierHint: probe.cmdProbe.errorMessage ?? probe.cmdProbe.stderr ?? probe.cmdProbe.errorCode ?? '',
    };
  }

  if (!probe.vswhereExists) {
    return {
      code: 'VSWHERE_MISSING',
      reason: `vswhere.exe not found at ${probe.vswherePath}`,
      classifierHint: `Unable to find vswhere at ${probe.vswherePath}`,
    };
  }

  if (!probe.vswhereProbe.ok) {
    return {
      code: probe.vswhereProbe.errorCode ?? 'VSWHERE_PROBE_FAILED',
      reason: formatProbeFailure('vswhere', probe.vswhereProbe),
      classifierHint: probe.vswhereProbe.errorMessage ?? probe.vswhereProbe.stderr ?? probe.vswhereProbe.errorCode ?? '',
    };
  }

  if (probe.localMicrosoftSdkProbe?.exists && !probe.localMicrosoftSdkProbe.accessible) {
    const sdkPath = probe.localMicrosoftSdkProbe.path;
    const sdkError = probe.localMicrosoftSdkProbe.errorMessage ?? 'access denied';
    return {
      code: 'LOCAL_MICROSOFT_SDKS_UNREADABLE',
      reason: `Local Microsoft SDKs path is not readable (${sdkPath}): ${sdkError}`,
      classifierHint: `Local Microsoft SDKs path is not readable (${sdkPath}): ${sdkError}`,
    };
  }

  return null;
}

export function getPortableMsbuildFallbackBlocker(probe, {env = process.env} = {}) {
  const forcePortableMsbuildFallback =
    normalizeText(env.OPAPP_WINDOWS_RELEASE_FORCE_MSBUILD_FALLBACK) === '1';
  if (forcePortableMsbuildFallback) {
    return null;
  }

  if (probe.localMicrosoftSdkProbe?.exists && !probe.localMicrosoftSdkProbe.accessible) {
    return (
      `local Microsoft SDKs path is not readable (${probe.localMicrosoftSdkProbe.path}): ` +
      `${probe.localMicrosoftSdkProbe.errorMessage ?? 'access denied'}`
    );
  }

  return null;
}

export function formatReleaseFailureDiagnostics({
  args,
  classification,
  command,
  failureSummary,
  introLine = 'Windows release smoke failed while running `run-windows --release`.',
  probe,
  result,
}) {
  const lines = [
    introLine,
    `Failure summary: ${failureSummary}`,
    `Failure classification: ${classification.code} (${classification.summary})`,
    `Process exit status: ${result.status ?? 'null'}${result.error?.code ? `, errorCode=${result.error.code}` : ''}`,
    'Release toolchain probe:',
    ...formatReleaseProbeForLogs(probe).map(line => `  - ${line}`),
  ];

  const hints = buildActionHints(classification, probe);
  if (hints.length > 0) {
    lines.push('Suggested next actions:');
    for (let index = 0; index < hints.length; index += 1) {
      lines.push(`  ${index + 1}. ${hints[index]}`);
    }
  }

  if (args?.length) {
    lines.push(`Command: ${command} ${args.join(' ')}`);
  }

  return lines.join('\n');
}

export function formatReleaseProbeReport({
  command = process.execPath,
  probe,
  blockingFailure,
}) {
  if (blockingFailure) {
    return formatReleaseFailureDiagnostics({
      args: [],
      classification: classifyRunWindowsFailure(blockingFailure.classifierHint),
      command,
      failureSummary: `release preflight blocked execution: ${blockingFailure.reason}`,
      introLine: 'Windows release preflight probe detected a blocking toolchain issue.',
      probe,
      result: {status: null, error: {code: blockingFailure.code}},
    });
  }

  return [
    'Windows release preflight probe found no blocking toolchain issue.',
    'Release toolchain probe:',
    ...formatReleaseProbeForLogs(probe).map(line => `  - ${line}`),
  ].join('\n');
}
