import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyRunWindowsFailure,
  collectReleaseBuildProbe,
  collectPortableMsbuildFallbackCandidates,
  collectPortableMsbuildFallbackProfiles,
  formatReleaseFailureDiagnostics,
  formatReleaseProbeForLogs,
  getBlockingReleaseProbeFailure,
  getPortableMsbuildFallbackBlocker,
  refineReleaseFailureClassification,
} from './windows-release-diagnostics.mjs';

test('classifyRunWindowsFailure detects cmd spawn EPERM failures', () => {
  const output = 'Command failed with error Unknown: spawnSync C:\\WINDOWS\\system32\\cmd.exe EPERM';
  const classification = classifyRunWindowsFailure(output);
  assert.equal(classification.code, 'cmd-spawn-eperm');
});

test('classifyRunWindowsFailure detects cmd spawn EPERM failures without spawnSync marker', () => {
  const output = 'Command failed with error Unknown: spawn C:\\WINDOWS\\system32\\cmd.exe EPERM';
  const classification = classifyRunWindowsFailure(output);
  assert.equal(classification.code, 'cmd-spawn-eperm');
});

test('classifyRunWindowsFailure detects missing vswhere failures', () => {
  const output = 'Unable to find vswhere at C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe';
  const classification = classifyRunWindowsFailure(output);
  assert.equal(classification.code, 'vswhere-missing');
});

test('formatReleaseProbeForLogs renders concise probe lines', () => {
  const lines = formatReleaseProbeForLogs({
    cmdPath: 'C:\\Windows\\System32\\cmd.exe',
    cmdExists: true,
    cmdProbe: {ok: true, status: 0},
    minimumVisualStudioVersion: null,
    visualStudioVersion: null,
    vswherePath: 'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe',
    vswhereExists: true,
    vswhereProbe: {ok: true, status: 0},
    msbuildCandidates: [
      {
        installationVersion: '17.11.2',
        msbuildPath: 'C:\\VS\\MSBuild\\Current\\Bin\\amd64\\msbuild.exe',
        exists: true,
      },
    ],
    localMicrosoftSdkProbe: {
      path: 'C:\\Users\\ArrayZoneYour\\AppData\\Local\\Microsoft SDKs',
      exists: true,
      accessible: false,
      errorMessage: 'Access to the path is denied.',
    },
  });

  assert(lines.some(line => line.includes('cmd path=C:\\Windows\\System32\\cmd.exe')));
  assert(lines.some(line => line.includes('vswhere path=')));
  assert(lines.some(line => line.includes('msbuild candidates=1 available=1')));
  assert(lines.some(line => line.includes('local sdk path=C:\\Users\\ArrayZoneYour\\AppData\\Local\\Microsoft SDKs')));
  assert(lines.some(line => line.includes('accessible=no')));
});

test('formatReleaseProbeForLogs marks msbuild candidates as unknown when vswhere capture is blocked', () => {
  const lines = formatReleaseProbeForLogs({
    cmdPath: 'C:\\Windows\\System32\\cmd.exe',
    cmdExists: true,
    cmdProbe: {ok: true, status: 0},
    minimumVisualStudioVersion: null,
    visualStudioVersion: null,
    vswherePath: 'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe',
    vswhereExists: true,
    vswhereProbe: {ok: true, status: 0, captureBlocked: true},
    msbuildCandidatesUnknown: true,
    msbuildCandidates: [],
  });

  assert(lines.some(line => line.includes('msbuild candidates=<unknown')));
});

test('formatReleaseFailureDiagnostics includes classification and actionable hints', () => {
  const diagnostics = formatReleaseFailureDiagnostics({
    args: ['run-windows', '--release'],
    classification: {code: 'cmd-spawn-eperm', summary: 'nested cmd spawn rejected (EPERM)'},
    command: 'node.exe',
    failureSummary: 'node.exe run-windows --release failed with exit code 1',
    probe: {
      cmdPath: 'C:\\Windows\\System32\\cmd.exe',
      cmdExists: true,
      cmdProbe: {ok: true, status: 0},
      minimumVisualStudioVersion: null,
      visualStudioVersion: null,
      vswherePath: 'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe',
      vswhereExists: true,
      vswhereProbe: {ok: true, status: 0},
      msbuildCandidates: [],
      localMicrosoftSdkProbe: {
        path: 'C:\\Users\\ArrayZoneYour\\AppData\\Local\\Microsoft SDKs',
        exists: true,
        accessible: false,
        errorMessage: 'Access to the path is denied.',
      },
    },
    result: {status: 1, error: null},
  });

  assert(diagnostics.includes('Failure classification: cmd-spawn-eperm'));
  assert(diagnostics.includes('Suggested next actions:'));
  assert(diagnostics.includes('non-sandbox'));
  assert(diagnostics.includes('Local Microsoft SDKs path is not readable'));
});

test('getBlockingReleaseProbeFailure reports cmd EPERM as blocking', () => {
  const blockingFailure = getBlockingReleaseProbeFailure({
    cmdPath: 'C:\\Windows\\System32\\cmd.exe',
    cmdExists: true,
    cmdProbe: {
      ok: false,
      status: null,
      errorCode: 'EPERM',
      errorMessage: 'spawnSync C:\\WINDOWS\\System32\\cmd.exe EPERM',
      stderr: '',
    },
    minimumVisualStudioVersion: null,
    visualStudioVersion: null,
    vswherePath: 'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe',
    vswhereExists: true,
    vswhereProbe: {ok: true, status: 0},
    msbuildCandidates: [],
  });

  assert(blockingFailure);
  assert.equal(blockingFailure.code, 'EPERM');
  assert(blockingFailure.reason.includes('cmd probe failed'));
});

test('getPortableMsbuildFallbackBlocker reports unreadable local sdk path', () => {
  const blocker = getPortableMsbuildFallbackBlocker({
    localMicrosoftSdkProbe: {
      path: 'C:\\Users\\ArrayZoneYour\\AppData\\Local\\Microsoft SDKs',
      exists: true,
      accessible: false,
      errorMessage: 'Access to the path is denied.',
    },
  });

  assert.equal(
    blocker,
    'local Microsoft SDKs path is not readable (C:\\Users\\ArrayZoneYour\\AppData\\Local\\Microsoft SDKs): Access to the path is denied.',
  );
});

test('getPortableMsbuildFallbackBlocker returns null when local sdk path is accessible', () => {
  const blocker = getPortableMsbuildFallbackBlocker({
    localMicrosoftSdkProbe: {
      path: 'C:\\Users\\ArrayZoneYour\\AppData\\Local\\Microsoft SDKs',
      exists: true,
      accessible: true,
      errorMessage: null,
    },
  });

  assert.equal(blocker, null);
});

test('getPortableMsbuildFallbackBlocker allows forced fallback override via env', () => {
  const blocker = getPortableMsbuildFallbackBlocker(
    {
      localMicrosoftSdkProbe: {
        path: 'C:\\Users\\ArrayZoneYour\\AppData\\Local\\Microsoft SDKs',
        exists: true,
        accessible: false,
        errorMessage: 'Access to the path is denied.',
      },
    },
    {
      env: {
        OPAPP_WINDOWS_RELEASE_FORCE_MSBUILD_FALLBACK: '1',
      },
    },
  );

  assert.equal(blocker, null);
});

test('refineReleaseFailureClassification upgrades unknown release failure to cmd-spawn-eperm with blocked capture signal', () => {
  const classification = refineReleaseFailureClassification({
    classification: {code: 'unknown', summary: 'unclassified run-windows failure'},
    probe: {
      cmdExists: true,
      cmdProbe: {ok: true},
      vswhereProbe: {ok: true, captureBlocked: true},
    },
    result: {status: 4294967295},
  });

  assert.equal(classification.code, 'cmd-spawn-eperm');
});

test('refineReleaseFailureClassification falls back to process-spawn-eperm without capture-blocked evidence', () => {
  const classification = refineReleaseFailureClassification({
    classification: {code: 'unknown', summary: 'unclassified run-windows failure'},
    probe: {
      cmdExists: true,
      cmdProbe: {ok: true},
      vswhereProbe: {ok: true, captureBlocked: false},
    },
    result: {status: 4294967295},
  });

  assert.equal(classification.code, 'process-spawn-eperm');
});

test('collectPortableMsbuildFallbackCandidates prioritizes env override and deduplicates probe matches', () => {
  const existingPaths = new Set([
    'D:\\Tooling\\msbuild.exe',
    'C:\\VS\\MSBuild\\Current\\Bin\\amd64\\msbuild.exe',
  ]);
  const candidates = collectPortableMsbuildFallbackCandidates({
    env: {
      OPAPP_WINDOWS_MSBUILD_PATH: 'D:\\Tooling\\msbuild.exe',
      ProgramFiles: 'C:\\Program Files',
      'ProgramFiles(x86)': 'C:\\Program Files (x86)',
    },
    exists: candidatePath => existingPaths.has(candidatePath),
    probe: {
      msbuildCandidates: [
        {exists: true, msbuildPath: 'C:\\VS\\MSBuild\\Current\\Bin\\amd64\\msbuild.exe'},
        {exists: true, msbuildPath: 'C:\\VS\\MSBuild\\Current\\Bin\\amd64\\msbuild.exe'},
        {exists: false, msbuildPath: 'C:\\VS\\Missing\\msbuild.exe'},
      ],
    },
  });

  assert.deepEqual(candidates, [
    'D:\\Tooling\\msbuild.exe',
    'C:\\VS\\MSBuild\\Current\\Bin\\amd64\\msbuild.exe',
  ]);
});

test('collectPortableMsbuildFallbackCandidates scans conventional VS install paths when probe output is unavailable', () => {
  const existingPath = 'C:\\Program Files\\Microsoft Visual Studio\\2022\\BuildTools\\MSBuild\\Current\\Bin\\amd64\\msbuild.exe';
  const candidates = collectPortableMsbuildFallbackCandidates({
    env: {
      ProgramFiles: 'C:\\Program Files',
      'ProgramFiles(x86)': 'C:\\Program Files (x86)',
    },
    exists: candidatePath => candidatePath === existingPath,
    probe: {
      msbuildCandidates: [],
    },
  });

  assert.deepEqual(candidates, [existingPath]);
});

test('collectPortableMsbuildFallbackProfiles defaults to restore + no-restore retry strategies', () => {
  const profiles = collectPortableMsbuildFallbackProfiles({env: {}});
  assert.deepEqual(
    profiles.map(profile => profile.id),
    ['restore-build', 'no-restore-host-target'],
  );
  assert(profiles[0].args.includes('/restore'));
  assert(profiles[1].args.includes('/p:Restore=false'));
});

test('collectPortableMsbuildFallbackProfiles allows disabling no-restore retry via env', () => {
  const profiles = collectPortableMsbuildFallbackProfiles({
    env: {OPAPP_WINDOWS_MSBUILD_FALLBACK_TRY_NO_RESTORE: '0'},
  });
  assert.deepEqual(
    profiles.map(profile => profile.id),
    ['restore-build'],
  );
});

test('collectReleaseBuildProbe marks local sdk path inaccessible when directory enumeration fails', () => {
  const probe = collectReleaseBuildProbe({
    env: {
      SystemRoot: 'C:\\Windows',
      ProgramFiles: 'C:\\Program Files',
      'ProgramFiles(x86)': 'C:\\Program Files (x86)',
      LOCALAPPDATA: 'C:\\Users\\ArrayZoneYour\\AppData\\Local',
    },
    spawn: (command, _args, options) => {
      const normalized = String(command).toLowerCase();
      if (normalized.endsWith('cmd.exe')) {
        return {status: 0, error: null, stdout: '', stderr: ''};
      }
      if (normalized.endsWith('vswhere.exe')) {
        if (Array.isArray(options?.stdio) && options.stdio[1] === 'pipe') {
          return {status: null, error: {code: 'EPERM', message: 'capture blocked'}, stdout: '', stderr: ''};
        }
        return {status: 0, error: null, stdout: '', stderr: ''};
      }
      return {status: 0, error: null, stdout: '', stderr: ''};
    },
    exists: targetPath => {
      const normalized = String(targetPath).toLowerCase();
      return (
        normalized.endsWith('cmd.exe') ||
        normalized.endsWith('vswhere.exe') ||
        normalized.includes('microsoft sdks')
      );
    },
    readDir: () => {
      throw new Error('Access is denied.');
    },
  });

  assert.equal(
    probe.localMicrosoftSdkProbe.path,
    'C:\\Users\\ArrayZoneYour\\AppData\\Local\\Microsoft SDKs',
  );
  assert.equal(probe.localMicrosoftSdkProbe.exists, true);
  assert.equal(probe.localMicrosoftSdkProbe.accessible, false);
  assert(probe.localMicrosoftSdkProbe.errorMessage.includes('Access is denied'));
});
