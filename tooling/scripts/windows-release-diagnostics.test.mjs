import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyRunWindowsFailure,
  collectPortableMsbuildFallbackCandidates,
  formatReleaseFailureDiagnostics,
  formatReleaseProbeForLogs,
  getBlockingReleaseProbeFailure,
  refineReleaseFailureClassification,
} from './windows-release-diagnostics.mjs';

test('classifyRunWindowsFailure detects cmd spawn EPERM failures', () => {
  const output = 'Command failed with error Unknown: spawnSync C:\\WINDOWS\\system32\\cmd.exe EPERM';
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
  });

  assert(lines.some(line => line.includes('cmd path=C:\\Windows\\System32\\cmd.exe')));
  assert(lines.some(line => line.includes('vswhere path=')));
  assert(lines.some(line => line.includes('msbuild candidates=1 available=1')));
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
    },
    result: {status: 1, error: null},
  });

  assert(diagnostics.includes('Failure classification: cmd-spawn-eperm'));
  assert(diagnostics.includes('Suggested next actions:'));
  assert(diagnostics.includes('non-sandbox'));
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
