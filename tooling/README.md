# tooling

Desktop repo-specific engineering support lives here.

Key OTA publishing entrypoint:

- `scripts/ota-cloudflare-publish.mjs`: Windows-first Cloudflare publish flow
  (`bundle -> local registry -> index merge -> upload`).

Windows verification entrypoints:

- `npm run verify:windows`: full packaged validation.
- `npm run verify:windows:portable`: full portable validation.
- `npm run verify:windows:ci-fast-fail`: validate-only packaged quick gate for CI.
- `npm run verify:windows:portable:ci-fast-fail`: validate-only portable quick gate for CI.
- `npm run verify:windows:preflight`: packaged preflight probe via verify entrypoint.
- `npm run verify:windows:portable:preflight`: portable preflight probe via verify entrypoint.
- `npm run verify:windows:ci-preflight`: packaged preflight probe with CI-oriented timeout args.
- `npm run verify:windows:portable:ci-preflight`: portable preflight probe with CI-oriented timeout args.
- `npm run smoke:windows:validate`: validate direct release-smoke packaged args only.
- `npm run smoke:windows:portable:validate`: validate direct release-smoke portable args only.
- `npm run smoke:windows:preflight`: packaged release preflight probe only (no bundle/build/launch).
- `npm run smoke:windows:portable:preflight`: portable release preflight probe only.
- `node ./tooling/scripts/windows-release-smoke.mjs --validate-only ...`: validate direct smoke args without running bundle/build/launch.
- `node ./tooling/scripts/windows-release-smoke.mjs --preflight-only ...`: collect release probe diagnostics without running bundle/build/launch.

Windows smoke timeout knobs:

- `--readiness-ms`: timeout for pre-smoke readiness checks.
- `--smoke-ms`: legacy/global timeout fallback for release smoke phases.
- `--startup-ms`: startup-marker wait timeout in `windows-release-smoke.mjs`.
- `--scenario-ms`: scenario success-marker wait timeout after startup markers pass.

Portable fallback override knobs:

- `OPAPP_WINDOWS_MSBUILD_PATH`: explicit `msbuild.exe` candidate for portable fallback.
- `OPAPP_WINDOWS_RELEASE_FORCE_MSBUILD_FALLBACK=1`: ignore local SDK ACL blocker and force a fallback build attempt.
