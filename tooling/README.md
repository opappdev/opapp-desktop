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
- `npm run report:windows:timing -- --input=<log-path>[,<log-path-2>] [--input=<log-path-3>] [--launch=all|packaged|portable] [--percentile=95] [--headroom-ms=5000] [--allow-verify-only] [--defaults-only] [--output=<report-path>]`: parse and aggregate `timing summary` lines across one or more logs, then print recommended `--startup-ms` / `--scenario-ms`（可选写入文件）。
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
- `windows-release-smoke.mjs` now prints per-phase timing utilization and low-headroom hints so real-machine runs can tune `--startup-ms` / `--scenario-ms` with concrete elapsed values.
- `verify-windows.mjs` now logs each scenario duration and an aggregated `scenario timing summary totalMs=...` line after full runs.
- `windows-smoke-timing-report.mjs` converts collected `timing summary scenario=...` logs into percentile-based timeout recommendations (default `P95 + 5000ms`), and when `verify-windows` summary lines are present it also prints a recommended full-run verify timeout.
- when `--launch=all` and marker timing logs include mixed launch modes, the report also prints per-launch (`packaged`/`portable`) startup/scenario timeout recommendations and emits them in JSON as `markerByLaunchMode`.
- when verify logs contain `launchMode=...` markers, the verify-timeout recommendation also respects `--launch=packaged|portable` filtering (while staying backward-compatible with older logs that do not include launch markers).
- when `--launch=all` and mixed verify logs include launch markers, the report also prints per-launch (`packaged`/`portable`) verify-timeout recommendations for side-by-side tuning.
- report output now includes `suggested timeout defaults` rows (and JSON `suggestedDefaults`) that pre-merge readiness/smoke/startup/scenario/verifyTotal values for direct verify default tuning.
- add `--defaults-only` to output only the compact `suggested timeout defaults` view (or JSON `suggestedDefaults`) for scripting.
- when logs contain only `verify-windows` summary lines, add `--allow-verify-only` to emit verify-timeout recommendations while skipping startup/scenario marker budgets.
- Example timing report usage:
  - `npm run report:windows:timing -- --input=%TEMP%\\verify-packaged.log,%TEMP%\\verify-portable.log --launch=all --percentile=95 --headroom-ms=5000`
  - `npm run report:windows:timing -- --input=%TEMP%\\verify-packaged.log --launch=packaged --json --output=%TEMP%\\windows-timing-report.json`
  - `npm run report:windows:timing -- --input=%TEMP%\\verify-ci-preflight.log --allow-verify-only`
  - `npm run report:windows:timing -- --input=%TEMP%\\verify-mixed.log --allow-verify-only --defaults-only --json`

Portable fallback override knobs:

- `OPAPP_WINDOWS_MSBUILD_PATH`: explicit `msbuild.exe` candidate for portable fallback.
- `OPAPP_WINDOWS_RELEASE_FORCE_MSBUILD_FALLBACK=1`: ignore local SDK ACL blocker and force a fallback build attempt.
