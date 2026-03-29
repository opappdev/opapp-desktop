import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import test from 'node:test';
import {
  classifyRunWindowsFailure,
  collectReleaseBuildProbe,
  collectPortableMsbuildFallbackCandidates,
  collectPortableMsbuildFallbackProfiles,
  formatReleaseFailureDiagnostics,
  formatReleaseProbeReport,
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

test('classifyRunWindowsFailure detects unreadable local Microsoft SDK path failures', () => {
  const output =
    'Microsoft.Common.CurrentVersion.targets(93,5): error MSB4184: 无法计算表达式“[Microsoft.Build.Utilities.ToolLocationHelper]::GetPlatformSDKLocation(UAP, 10.0.22621.0)”。对路径“C:\\Users\\ArrayZoneYour\\AppData\\Local\\Microsoft SDKs”的访问被拒绝。';
  const classification = classifyRunWindowsFailure(output);
  assert.equal(classification.code, 'local-sdk-acl-denied');
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
    localMicrosoftSdkAclProbe: {
      path: 'C:\\Users\\ArrayZoneYour\\AppData\\Local\\Microsoft SDKs',
      ok: true,
      status: 0,
      captureBlocked: false,
      owner: 'BUILTIN\\Administrators',
      accessToString: 'BUILTIN\\Administrators Allow FullControl',
    },
    localMicrosoftSdkIcaclsProbe: {
      path: 'C:\\Users\\ArrayZoneYour\\AppData\\Local\\Microsoft SDKs',
      ok: true,
      status: 0,
      captureBlocked: false,
      detail:
        'C:\\Users\\ArrayZoneYour\\AppData\\Local\\Microsoft SDKs BUILTIN\\Administrators:(I)(F)',
    },
  });

  assert(lines.some(line => line.includes('cmd path=C:\\Windows\\System32\\cmd.exe')));
  assert(lines.some(line => line.includes('vswhere path=')));
  assert(lines.some(line => line.includes('msbuild candidates=1 available=1')));
  assert(lines.some(line => line.includes('local sdk path=C:\\Users\\ArrayZoneYour\\AppData\\Local\\Microsoft SDKs')));
  assert(lines.some(line => line.includes('accessible=no')));
  assert(lines.some(line => line.includes('local sdk access-error=Access to the path is denied.')));
  assert(lines.some(line => line.includes('local sdk acl probe=ok(status=0)')));
  assert(lines.some(line => line.includes('local sdk acl owner=BUILTIN\\Administrators')));
  assert(lines.some(line => line.includes('local sdk acl access=BUILTIN\\Administrators Allow FullControl')));
  assert(lines.some(line => line.includes('local sdk icacls probe=ok(status=0)')));
  assert(lines.some(line => line.includes('local sdk icacls detail=C:\\Users\\ArrayZoneYour\\AppData\\Local\\Microsoft SDKs BUILTIN\\Administrators:(I)(F)')));
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
      localMicrosoftSdkAclProbe: {
        path: 'C:\\Users\\ArrayZoneYour\\AppData\\Local\\Microsoft SDKs',
        ok: false,
        status: 1,
        errorCode: 'ACCESS_DENIED',
        errorMessage: 'Get-Acl access denied.',
        captureBlocked: false,
        owner: null,
        accessToString: null,
      },
    },
    result: {status: 1, error: null},
  });

  assert(diagnostics.includes('Failure classification: cmd-spawn-eperm'));
  assert(diagnostics.includes('Suggested next actions:'));
  assert(diagnostics.includes('non-sandbox'));
  assert(diagnostics.includes('Local Microsoft SDKs path is not readable'));
  assert(diagnostics.includes('Automated Get-Acl probe failed (ACCESS_DENIED)'));
  assert(diagnostics.includes("Get-Acl 'C:\\Users\\ArrayZoneYour\\AppData\\Local\\Microsoft SDKs'"));
});

test('formatReleaseFailureDiagnostics includes local-sdk-acl-denied guidance', () => {
  const diagnostics = formatReleaseFailureDiagnostics({
    args: [],
    classification: {
      code: 'local-sdk-acl-denied',
      summary: 'Local Microsoft SDKs ACL blocks MSBuild SDK resolution',
    },
    command: 'node.exe',
    failureSummary:
      'release preflight blocked execution: Local Microsoft SDKs path is not readable (C:\\Users\\ArrayZoneYour\\AppData\\Local\\Microsoft SDKs): Access is denied.',
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
        errorMessage: 'Access is denied.',
      },
      localMicrosoftSdkAclProbe: {
        path: 'C:\\Users\\ArrayZoneYour\\AppData\\Local\\Microsoft SDKs',
        ok: true,
        status: 0,
        captureBlocked: false,
        owner: 'NT SERVICE\\TrustedInstaller',
        accessToString: 'BUILTIN\\Administrators Allow FullControl',
      },
    },
    result: {status: null, error: {code: 'LOCAL_MICROSOFT_SDKS_UNREADABLE'}},
  });

  assert(diagnostics.includes('Failure classification: local-sdk-acl-denied'));
  assert(diagnostics.includes('ToolLocationHelper cannot read the per-user `Local Microsoft SDKs` directory.'));
  assert(diagnostics.includes('Portable MSBuild fallback does not bypass this class of failure'));
  assert(diagnostics.includes('OPAPP_WINDOWS_RELEASE_SKIP_PREFLIGHT_FAILFAST=1'));
  assert(diagnostics.includes('npm run report:windows:release-probe'));
  assert(diagnostics.includes('npm run report:windows:release-probe:json'));
  assert(diagnostics.includes('Detected Local Microsoft SDKs ACL owner: NT SERVICE\\TrustedInstaller.'));
  assert(diagnostics.includes('Detected Local Microsoft SDKs ACL entries (truncated): BUILTIN\\Administrators Allow FullControl.'));
  assert(diagnostics.includes('If `Get-Acl` is also unauthorized in the current session'));
});

test('formatReleaseFailureDiagnostics adds a PowerShell module hint when Get-Acl cannot load Microsoft.PowerShell.Security', () => {
  const diagnostics = formatReleaseFailureDiagnostics({
    args: [],
    classification: {
      code: 'local-sdk-acl-denied',
      summary: 'Local Microsoft SDKs ACL blocks MSBuild SDK resolution',
    },
    command: 'node.exe',
    failureSummary:
      'release preflight blocked execution: Local Microsoft SDKs path is not readable (C:\\Users\\ArrayZoneYour\\AppData\\Local\\Microsoft SDKs): Access is denied.',
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
        errorMessage: 'Access is denied.',
      },
      localMicrosoftSdkAclProbe: {
        path: 'C:\\Users\\ArrayZoneYour\\AppData\\Local\\Microsoft SDKs',
        ok: false,
        status: 0,
        errorCode: 'GET_ACL_FAILED',
        errorMessage:
          "The 'Get-Acl' command was found in the module 'Microsoft.PowerShell.Security', but the module could not be loaded. For more information, run 'Import-Module Microsoft.PowerShell.Security'.",
        captureBlocked: false,
        owner: null,
        accessToString: null,
      },
      localMicrosoftSdkIcaclsProbe: {
        path: 'C:\\Users\\ArrayZoneYour\\AppData\\Local\\Microsoft SDKs',
        ok: false,
        status: 1,
        errorCode: null,
        errorMessage: 'C:\\Users\\ArrayZoneYour\\AppData\\Local\\Microsoft SDKs: Access is denied.',
        captureBlocked: false,
        detail: null,
      },
    },
    result: {status: null, error: {code: 'LOCAL_MICROSOFT_SDKS_UNREADABLE'}},
  });

  assert(diagnostics.includes('Automated Get-Acl probe failed (GET_ACL_FAILED)'));
  assert(diagnostics.includes('retry `Get-Acl` from Windows PowerShell or an elevated/full-trust session'));
  assert(diagnostics.includes('Direct icacls probe result (1): C:\\Users\\ArrayZoneYour\\AppData\\Local\\Microsoft SDKs: Access is denied.'));
});

test('formatReleaseFailureDiagnostics explains summary-only icacls output', () => {
  const diagnostics = formatReleaseFailureDiagnostics({
    args: [],
    classification: {
      code: 'local-sdk-acl-denied',
      summary: 'Local Microsoft SDKs ACL blocks MSBuild SDK resolution',
    },
    command: 'node.exe',
    failureSummary:
      'release preflight blocked execution: Local Microsoft SDKs path is not readable (C:\\Users\\ArrayZoneYour\\AppData\\Local\\Microsoft SDKs): Access is denied.',
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
        errorMessage: 'Access is denied.',
      },
      localMicrosoftSdkAclProbe: {
        path: 'C:\\Users\\ArrayZoneYour\\AppData\\Local\\Microsoft SDKs',
        ok: false,
        status: 0,
        errorCode: 'GET_ACL_FAILED',
        errorMessage:
          "The 'Get-Acl' command was found in the module 'Microsoft.PowerShell.Security', but the module could not be loaded.",
        captureBlocked: false,
        owner: null,
        accessToString: null,
      },
      localMicrosoftSdkIcaclsProbe: {
        path: 'C:\\Users\\ArrayZoneYour\\AppData\\Local\\Microsoft SDKs',
        ok: false,
        status: 1,
        errorCode: null,
        errorMessage: 'Successfully processed 0 files; Failed processing 1 files',
        captureBlocked: false,
        detail: null,
      },
    },
    result: {status: null, error: {code: 'LOCAL_MICROSOFT_SDKS_UNREADABLE'}},
  });

  assert(diagnostics.includes('Direct icacls probe result (1): Successfully processed 0 files; Failed processing 1 files.'));
  assert(diagnostics.includes('rerun `icacls "C:\\Users\\ArrayZoneYour\\AppData\\Local\\Microsoft SDKs"` interactively'));
});

test('formatReleaseProbeReport renders a success summary when no blocking issue is detected', () => {
  const report = formatReleaseProbeReport({
    command: 'node.exe',
    probe: {
      cmdPath: 'C:\\Windows\\System32\\cmd.exe',
      cmdExists: true,
      cmdProbe: {ok: true, status: 0},
      minimumVisualStudioVersion: null,
      visualStudioVersion: '17.0',
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
        accessible: true,
        errorMessage: null,
      },
    },
    blockingFailure: null,
  });

  assert(report.includes('Windows release preflight probe found no blocking toolchain issue.'));
  assert(report.includes('Release toolchain probe:'));
  assert(report.includes('msbuild candidates=1 available=1'));
});

test('formatReleaseProbeReport uses a preflight-specific intro when a blocker is present', () => {
  const report = formatReleaseProbeReport({
    command: 'node.exe',
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
        errorMessage: 'Access is denied.',
      },
    },
    blockingFailure: {
      code: 'LOCAL_MICROSOFT_SDKS_UNREADABLE',
      reason: 'Local Microsoft SDKs path is not readable (C:\\Users\\ArrayZoneYour\\AppData\\Local\\Microsoft SDKs): Access is denied.',
      classifierHint: 'Local Microsoft SDKs path is not readable (C:\\Users\\ArrayZoneYour\\AppData\\Local\\Microsoft SDKs): Access is denied.',
    },
  });

  assert(report.startsWith('Windows release preflight probe detected a blocking toolchain issue.'));
  assert(!report.includes('Windows release smoke failed while running `run-windows --release`.'));
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

test('getBlockingReleaseProbeFailure reports unreadable local sdk path as blocking', () => {
  const blockingFailure = getBlockingReleaseProbeFailure({
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
      errorMessage: 'Access is denied.',
    },
  });

  assert(blockingFailure);
  assert.equal(blockingFailure.code, 'LOCAL_MICROSOFT_SDKS_UNREADABLE');
  assert(blockingFailure.reason.includes('Local Microsoft SDKs path is not readable'));
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

test('collectReleaseBuildProbe skips ACL detail probes when local sdk path is readable', () => {
  const probe = collectReleaseBuildProbe({
    env: {
      SystemRoot: 'C:\\Windows',
      ProgramFiles: 'C:\\Program Files',
      'ProgramFiles(x86)': 'C:\\Program Files (x86)',
      LOCALAPPDATA: 'C:\\Users\\ArrayZoneYour\\AppData\\Local',
    },
    spawn: command => {
      const normalized = String(command).toLowerCase();
      if (normalized.endsWith('cmd.exe')) {
        return {status: 0, error: null, stdout: '', stderr: ''};
      }
      if (normalized.endsWith('vswhere.exe')) {
        return {status: 0, error: null, stdout: '[]', stderr: ''};
      }
      throw new Error('ACL detail probes should be skipped when the SDK directory is readable.');
    },
    exists: targetPath => {
      const normalized = String(targetPath).toLowerCase();
      return (
        normalized.endsWith('cmd.exe') ||
        normalized.endsWith('vswhere.exe') ||
        normalized.includes('microsoft sdks')
      );
    },
    readDir: () => [],
  });

  assert.equal(probe.localMicrosoftSdkProbe.path, 'C:\\Users\\ArrayZoneYour\\AppData\\Local\\Microsoft SDKs');
  assert.equal(probe.localMicrosoftSdkProbe.exists, true);
  assert.equal(probe.localMicrosoftSdkProbe.accessible, true);
  assert.equal(probe.localMicrosoftSdkAclProbe, null);
  assert.equal(probe.localMicrosoftSdkIcaclsProbe, null);
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
        const commandText = String(_args?.[_args.length - 1] ?? '');
        if (Array.isArray(options?.stdio) && options.stdio[1] === 'pipe' && commandText.includes('icacls "')) {
          return {
            status: null,
            error: {code: 'EPERM', message: 'capture blocked'},
            stdout: '',
            stderr: '',
          };
        }
        const redirectedOutputMatch = commandText.match(/>\s*"([^"]+)"\s*2>&1$/);
        if (redirectedOutputMatch?.[1] && commandText.includes('icacls "')) {
          writeFileSync(
            redirectedOutputMatch[1],
            'C:\\Users\\ArrayZoneYour\\AppData\\Local\\Microsoft SDKs: Access is denied.\n' +
              'Successfully processed 0 files; Failed processing 1 files\n',
            'utf8',
          );
          return {
            status: 1,
            error: null,
            stdout: '',
            stderr: '',
          };
        }
        return {status: 0, error: null, stdout: '', stderr: ''};
      }
      if (normalized.endsWith('vswhere.exe')) {
        if (Array.isArray(options?.stdio) && options.stdio[1] === 'pipe') {
          return {status: null, error: {code: 'EPERM', message: 'capture blocked'}, stdout: '', stderr: ''};
        }
        return {status: 0, error: null, stdout: '', stderr: ''};
      }
      if (normalized.endsWith('powershell.exe')) {
        const commandText = String(_args?.[_args.length - 1] ?? '');
        const outputPathMatch = commandText.match(/Set-Content -LiteralPath '([^']+)' -Encoding utf8/);
        if (outputPathMatch?.[1] && commandText.includes('Get-Acl')) {
          writeFileSync(
            outputPathMatch[1],
            JSON.stringify({
              Path: 'Microsoft.PowerShell.Core\\FileSystem::C:\\Users\\ArrayZoneYour\\AppData\\Local\\Microsoft SDKs',
              Owner: 'NT SERVICE\\TrustedInstaller',
              AccessToString: 'BUILTIN\\Administrators Allow FullControl',
            }),
            'utf8',
          );
        }
        return {
          status: 0,
          error: null,
          stdout: '',
          stderr: '',
        };
      }
      return {status: 0, error: null, stdout: '', stderr: ''};
    },
    exists: targetPath => {
      const normalized = String(targetPath).toLowerCase();
      return (
        normalized.endsWith('cmd.exe') ||
        normalized.endsWith('vswhere.exe') ||
        normalized.endsWith('powershell.exe') ||
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
  assert.equal(probe.localMicrosoftSdkAclProbe.path, 'Microsoft.PowerShell.Core\\FileSystem::C:\\Users\\ArrayZoneYour\\AppData\\Local\\Microsoft SDKs');
  assert.equal(probe.localMicrosoftSdkAclProbe.owner, 'NT SERVICE\\TrustedInstaller');
  assert.equal(probe.localMicrosoftSdkAclProbe.accessToString, 'BUILTIN\\Administrators Allow FullControl');
  assert.equal(probe.localMicrosoftSdkIcaclsProbe.path, 'C:\\Users\\ArrayZoneYour\\AppData\\Local\\Microsoft SDKs');
  assert.equal(probe.localMicrosoftSdkIcaclsProbe.ok, false);
  assert.equal(probe.localMicrosoftSdkIcaclsProbe.status, 1);
  assert.equal(probe.localMicrosoftSdkIcaclsProbe.errorMessage, 'C:\\Users\\ArrayZoneYour\\AppData\\Local\\Microsoft SDKs: Access is denied.');
});

test('collectReleaseBuildProbe recovers vswhere installs via temp-file redirect when pipe capture is blocked', () => {
  const probe = collectReleaseBuildProbe({
    env: {
      SystemRoot: 'C:\\Windows',
      ProgramFiles: 'C:\\Program Files',
      'ProgramFiles(x86)': 'C:\\Program Files (x86)',
      LOCALAPPDATA: 'C:\\Users\\ArrayZoneYour\\AppData\\Local',
    },
    spawn: (command, args, options) => {
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
      if (normalized.endsWith('powershell.exe')) {
        const commandText = String(args?.[args.length - 1] ?? '');
        const outputPathMatch = commandText.match(/Set-Content -LiteralPath '([^']+)' -Encoding utf8/);
        if (outputPathMatch?.[1] && commandText.includes('$vswhereArgs')) {
          writeFileSync(
            outputPathMatch[1],
            JSON.stringify([
              {
                installationPath: 'C:\\VS',
                installationVersion: '17.11.2',
                displayName: 'VS Build Tools',
              },
            ]),
            'utf8',
          );
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
        normalized.endsWith('powershell.exe') ||
        normalized === 'c:\\vs\\msbuild\\current\\bin\\amd64\\msbuild.exe'
      );
    },
    readDir: () => ['placeholder'],
  });

  assert.equal(probe.vswhereProbe.ok, true);
  assert.equal(probe.vswhereProbe.captureBlocked, false);
  assert(probe.vswhereProbe.errorMessage.includes('temp file'));
  assert.equal(probe.msbuildCandidatesUnknown, false);
  assert.equal(probe.msbuildCandidates.length, 1);
  assert.equal(probe.msbuildCandidates[0].msbuildPath, 'C:\\VS\\MSBuild\\Current\\Bin\\amd64\\msbuild.exe');
  assert.equal(probe.msbuildCandidates[0].exists, true);
});
