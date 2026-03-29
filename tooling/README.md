# tooling

Desktop repo-specific engineering support lives here.

Key OTA publishing entrypoint:

- `scripts/ota-cloudflare-publish.mjs`: Windows-first Cloudflare publish flow
  (`optional frontend build -> local registry -> index merge -> upload`).
  Defaults to loading the workspace root `.env.r2.local`, prefers direct R2 S3
  upload when `R2_ENDPOINT` + `R2_ACCESS_KEY_ID` + `R2_SECRET_ACCESS_KEY` are
  available, and keeps Wrangler upload as a compatibility fallback.
- OTA channel pins are now treated as `versions[]`-backed metadata:
  `generateRegistryIndex()` drops `channels.json` entries that point at missing
  versions, publish-side index merge does the same for stale remote pins, and
  updater / Windows host consumers fall back to a listed stable or
  lexicographic latest version instead of chasing a dead artifact path.
- `npm run test:registry:ops`: direct-node assertions for operator-side
  `registry-ops channel --set`, including the guard that rejects channel pins to
  versions that do not exist in the local registry tree.
- `npm run test:ota:updater`: direct-node assertions for OTA updater
  `last-run.json` payload shaping, including rollout/channel context retention
  during `--mode=update` and the guard that `up-to-date` records do not invent a
  staged `version`.

Window capture entrypoints:

- `scripts/windows-capture-window.mjs`: top-level window capture CLI.
  `--region=window` and `--region=client` default to the
  `Windows.Graphics.Capture` helper path; `monitor` stays on desktop pixel copy.
- `dotnet/window-capture-wgc/`: WGC helper project plus the current
  `Vortice.Direct3D11` Windows SDK evaluation note.
- `npm run test:windows-capture:options`: validate the CLI's backend-selection
  defaults and monitor-path guardrails without launching a real capture.

Windows verification entrypoints:

- `npm run verify:windows`: full packaged validation.
- `npm run verify:windows:portable`: full portable validation.
- `npm run verify:windows:raw-release`: shortest raw `run-windows --release` repro from the native host root; skips verify/smoke wrappers and prints upstream React Native Windows / MSBuild output directly.
- `npm run verify:windows:dev:window-capture`: Metro-backed `OpappWindowCapture`
  scenario that opens the lab surface and validates WGC window/client capture.
- `npm run smoke:windows:window-capture`: packaged `OpappWindowCapture`
  scenario with the same end-to-end assertions.
- `npm run verify:windows:ci-fast-fail`: validate-only packaged quick gate for CI.
- `npm run verify:windows:portable:ci-fast-fail`: validate-only portable quick gate for CI.
- `npm run verify:windows:preflight`: packaged preflight probe via verify entrypoint.
- `npm run verify:windows:portable:preflight`: portable preflight probe via verify entrypoint.
- use `npm run verify:windows:raw-release` after preflight has already identified the blocker and you need the unwrapped upstream restore/build failure for the Windows host itself.
- `npm run verify:windows:ci-preflight`: packaged preflight probe with CI-oriented timeout args.
- `npm run verify:windows:portable:ci-preflight`: portable preflight probe with CI-oriented timeout args.
- `npm run verify:windows:public:ci`: Windows-hosted public verification wrapper that spins up a local OTA registry fixture, then runs packaged + portable release verify for the minimal public `launcher-provenance` smoke (launcher startup, staged-bundle bridge, cached OTA catalog visibility, and public diagnostics).
- `scripts/resolve-public-frontend-ref.mjs`: resolves the pinned public
  `opapp-frontend` checkout ref from `tooling/config/opapp-frontend-ref.txt`
  unless `OPAPP_FRONTEND_REF` explicitly overrides it.
- `scripts/windows-nightly-release-assets.mjs`: collects the packaged Windows
  build outputs after public verify, emits a user-runnable portable zip, an
  installable MSIX bundle zip, checksums, and release notes for GitHub nightly
  publishing.
- `npm run report:windows:timing -- --input=<log-path>[,<log-path-2>] [--input=<log-path-3>] [--launch=all|packaged|portable] [--percentile=95] [--headroom-ms=5000] [--allow-verify-only] [--defaults-only] [--output=<report-path>]`: parse and aggregate `timing summary` lines across one or more logs, then print recommended `--startup-ms` / `--scenario-ms`（可选写入文件）。
- `npm run test:windows:release-diagnostics`: single-process diagnostics assertions for environments where `node --test` runner spawning is restricted.
- `npm run test:windows:release-smoke:ota`: direct-node assertions for OTA
  `last-run.json` contract checks inside `windows-release-smoke`, including the
  guards that successful runs must persist resolved `mode` / `bundleId` /
  `channel` / `latestVersion` / `hasUpdate`, that `latestVersion` still matches
  the remote `index.json` channel resolution, that remote `channels` maps are
  preserved when `index.json` exposes them, that `up-to-date` runs must not
  report staged metadata, and that `--ota-expected-status=failed` runs only pass
  when failure records keep the resolved remote metadata they already learned.
- `npm run smoke:windows:validate`: validate direct release-smoke packaged args only.
- `npm run smoke:windows:portable:validate`: validate direct release-smoke portable args only.
- `npm run smoke:windows:preflight`: packaged release preflight probe only (no bundle/build/launch).
- `npm run smoke:windows:portable:preflight`: portable release preflight probe only.
- `node ./tooling/scripts/windows-release-smoke.mjs --validate-only ...`: validate direct smoke args without running bundle/build/launch.
- `node ./tooling/scripts/windows-release-smoke.mjs --preflight-only ...`: collect release probe diagnostics without running bundle/build/launch.
- preflight now fails fast with `local-sdk-acl-denied` when `C:\Users\<user>\AppData\Local\Microsoft SDKs` exists but is unreadable; this surfaces the real MSBuild blocker before bundle/build/deploy.
- if you intentionally need the full upstream MSBuild failure after that diagnosis, rerun once with `OPAPP_WINDOWS_RELEASE_SKIP_PREFLIGHT_FAILFAST=1`.
- if `Get-Acl 'C:\Users\<user>\AppData\Local\Microsoft SDKs'` is also unauthorized in the current session, inspect/fix that directory from an elevated or less-restricted Windows session before retrying verify.
- release smoke now rejects OTA `last-run.json` records that report a staged
  `version` while status is still `up-to-date`; only real staged updates may
  populate that field.
- release smoke now also compares successful OTA `last-run.json` `channels`
  metadata against the downloaded remote `index.json` bundle entry when that
  entry exposes a `channels` map.
- release smoke accepts `--ota-expected-status=success|updated|up-to-date|failed`;
  `failed` lets a real packaged/native failure sample validate its `last-run.json`
  diagnostics contract without first pretending the run succeeded.
- real failure-sample example:
  `npm run verify:windows -- --ota-remote=http://127.0.0.1:8787 --ota-expected-status=failed`
- `npm run ota:fixture:native-failure -- --mode=<mode> [--out-dir=<dir>]` creates a
  static OTA registry tree for native `failed`-status rehearsals. Supported
  remote-only modes currently cover `download-manifest-404`,
  `manifest-parse`, `manifest-missing-entry-file`, `download-entry-file-404`,
  `checksum-invalid-metadata`, `checksum-unsupported-algorithm`, and
  `checksum-mismatch`.
- Generated fixture directories are meant to be served over localhost (or any
  static HTTPS host) and paired with `--ota-expected-status=failed`; snapshot /
  apply failures still require local host/cache perturbation rather than a pure
  remote fixture.

Windows smoke timeout knobs:

- `--readiness-ms`: timeout for pre-smoke readiness checks.
- `--smoke-ms`: legacy/global timeout fallback for release smoke phases.
- `--startup-ms`: startup-marker wait timeout in `windows-release-smoke.mjs`.
- `--scenario-ms`: scenario success-marker wait timeout after startup markers pass.
- `--timeout-defaults=<path-to-json>`: load `suggestedDefaults` from `windows-smoke-timing-report --json` output and auto-apply launch-specific readiness/smoke/startup/scenario defaults (explicit timeout flags still win).
- `--timeout-defaults` resolves `suggestedDefaults` by current launch mode first (`packaged`/`portable`), then falls back to `launch=all`; missing matches or duplicate `--timeout-defaults` args fail fast.
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
  - `npm run verify:windows -- --timeout-defaults=%TEMP%\\windows-timing-report.json`
  - `npm run verify:windows:portable -- --timeout-defaults=%TEMP%\\windows-timing-report.json`
  - `node ./tooling/scripts/windows-release-smoke.mjs --launch=portable --timeout-defaults=%TEMP%\\windows-timing-report.json --validate-only`
  - `npm run report:windows:timing -- --input=%TEMP%\\verify-ci-preflight.log --allow-verify-only`
  - `npm run report:windows:timing -- --input=%TEMP%\\verify-mixed.log --allow-verify-only --defaults-only --json`

Portable fallback override knobs:

- `OPAPP_WINDOWS_MSBUILD_PATH`: explicit `msbuild.exe` candidate for portable fallback.
- `OPAPP_WINDOWS_RELEASE_FORCE_MSBUILD_FALLBACK=1`: ignore local SDK ACL blocker and force a fallback build attempt.
- `OPAPP_WINDOWS_RELEASE_SKIP_PREFLIGHT_FAILFAST=1`: keep running past preflight blockers to capture raw upstream MSBuild output when diagnosing environment issues.
