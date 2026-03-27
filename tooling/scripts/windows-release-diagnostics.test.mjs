import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyRunWindowsFailure,
  formatReleaseFailureDiagnostics,
  formatReleaseProbeForLogs,
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
