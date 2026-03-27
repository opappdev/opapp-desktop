import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
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

function parseVswhereOutput(rawOutput) {
  try {
    const parsed = JSON.parse(rawOutput);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return null;
  }
}

export function collectReleaseBuildProbe({
  env = process.env,
  spawn = spawnSync,
  exists = existsSync,
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
  if (vswhereProbe.ok && !vswhereProbe.captureBlocked) {
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
  };
}

const FAILURE_CLASSIFIERS = [
  {
    code: 'cmd-spawn-eperm',
    summary: 'nested cmd spawn rejected (EPERM)',
    matcher: /spawnSync\s+[^\r\n]*cmd\.exe\s+EPERM/i,
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

  if (classification.code === 'cmd-spawn-eperm') {
    hints.push(
      '@react-native-windows/cli failed while spawning nested cmd.exe during vswhere probing, which usually points to sandbox/endpoint policy restrictions.',
    );
    hints.push(
      'Compare direct cmd execution with Node child-process execution; if only the nested path fails, this is likely an environment policy issue rather than project config.',
    );
    hints.push('Re-run `npm run verify:windows:portable` on a non-sandbox machine to confirm release-chain health.');
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

  return null;
}

export function formatReleaseFailureDiagnostics({
  args,
  classification,
  command,
  failureSummary,
  probe,
  result,
}) {
  const lines = [
    'Windows release smoke failed while running `run-windows --release`.',
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
