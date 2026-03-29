# opapp-desktop

`opapp-desktop` is the desktop host repo for OPApp.

It owns:

- Windows and macOS hosts
- desktop platform bridges
- packaging, signing, and release flow

Business structure stays in `opapp-frontend`.

## Open Source

This repository is licensed under `MPL-2.0`. The root `package.json` keeps
`"private": true` only to prevent accidental npm publication of the workspace
root; it does not mean the source repository itself is closed.

Public source stays in this repository. Personal env files, generated release
artifacts, local OTA/cache state, and optional `tooling/scripts/.private-*`
extensions must stay out of git.

## Git Commit Prep

Before committing desktop changes, run `npm run commit:check` for the
Metro-backed smoke path. If the change touches native host behavior, packaged
startup, window/session restore, or bundle staging, also run
`npm run commit:check:release`.

Keep desktop commits scoped to this repo and use the existing commit subject
style: `desktop: ...`.

## Validation

Use `npm run verify:windows` as the default packaged-app validation. It runs the
frontend typecheck first, then the packaged Windows smoke.

Use `npm run verify:windows:portable` when you want to validate the direct-run
Windows release directory artifact (`x64\\Release\\OpappWindowsHost.exe` plus its
sibling runtime files and `Bundle/`).

Use `npm run smoke:windows:release` when you only need the packaged host smoke.

Use `npm run smoke:windows:portable` when you only need the portable/direct-exe
smoke.

Use `npm run report:windows:release-probe` when you need the release toolchain
blocker diagnosis without running the smoke harness. It reuses the same
preflight probe and suggested next actions as `verify:windows:*:preflight`.

Use `npm run report:windows:release-probe:json` when you want the same release
probe as machine-readable JSON for automation or handoff notes.

Use `npm run report:windows:release-probe:fail` when you want the standalone
probe to exit non-zero whenever it detects a blocking release-toolchain issue.

All three report commands also accept `-- --output=<path>` to write the text or
JSON payload to a file. In restricted sessions, prefer `%TEMP%` or another
known writable directory if repo-root temp folders still hit `EPERM`.

Use `npm run verify:windows:dev:window-capture` or
`npm run smoke:windows:window-capture` when you need to validate the native
`OpappWindowCapture` bridge end to end.

Use `npm run verify:windows:surface-model` or `npm run smoke:windows:surface-model`
only when validating multi-surface or multi-window behavior.

Use `npm run verify:windows:portable:surface-model` or
`npm run smoke:windows:portable:surface-model` only when validating the same
surface model behavior through the direct-run release directory artifact.

All smoke entrypoints clean up the launched Windows host process before
returning.

## Windows Nightly Release

The GitHub Actions workflow at `.github/workflows/windows-nightly.yml` publishes
a prerelease Windows nightly from a pinned public `opapp-frontend` ref plus the
current `opapp-desktop` commit.

Nightly assets are intentionally user-installable or user-runnable:

- `opapp-windows-nightly-x64-portable.zip`: unzip and run
  `OpappWindowsHost.exe` from the extracted folder.
- `opapp-windows-nightly-x64-msix-bundle.zip`: unzip and run `Install.ps1` for
  the packaged MSIX path with bundled dependencies.

Official Windows release builds default their OTA remote base to
`https://r2.opapp.dev`. Only local smoke or targeted rehearsal runs should
override it via launch config or `OPAPP_OTA_REMOTE_URL`.

The pinned frontend checkout lives in
`tooling/config/opapp-frontend-ref.txt`. Override with
`OPAPP_FRONTEND_REF` only when you intentionally want to test a different
frontend commit.

## External Window Capture

Use `npm run capture:windows:window -- ...` to capture an external top-level
window for Windows-only debugging and data intake support.

Current behavior:

- `--region=window` and `--region=client` now default to `Windows.Graphics.Capture`
- `--region=client` is implemented as `window` capture plus client-area crop mapping
- `--region=monitor` still uses desktop pixel copy
- the WGC helper implementation lives in `tooling/dotnet/window-capture-wgc/`
- the current third-party SDK evaluation note also lives there

Example:

- `npm run capture:windows:window -- --process-name=HeavenBurnsRed --region=window --json`

## OTA Cloudflare Publish (Windows First)

Use `npm run ota:publish:cloudflare -- ...` to publish a built bundle through
the Cloudflare-backed OTA path while keeping runtime protocol unchanged
(`index.json`, `bundles`, `versions`, `latestVersion`, `channels`,
`rolloutPercent`).

Default env file:

- workspace root `.env.r2.local` (relative path from `opapp-desktop`: `..\\.env.r2.local`)

Recognized env keys:

- `R2_BUCKET`
- `R2_PUBLIC_BASE_URL`
- `R2_ENDPOINT`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_ACCOUNT_ID`
- `R2_JURISDICTION`

Always required:

- `--channel`
- `--rollout-percent`

Conditionally required:

- `--bundle-id`
- `--platform`
- `--version`
- `--remote-base`
- `--cloudflare-bucket`

When `--build` or `--source-dir` is used, `bundleId` / `version` / `platform`
can be resolved from `bundle-manifest.json`, and `remote-base` /
`cloudflare-bucket` can come from `.env.r2.local`.

Optional flags:

- `--build` (run `opapp-frontend` Windows bundle first)
- `--env-file`
- `--source-dir` (publish build output into local registry before upload)
- `--registry-dir`
- `--cloudflare-prefix` (defaults to URL path in `--remote-base`)
- `--upload-mode` (`r2-s3` by default when R2 credentials are available; otherwise `wrangler`)
- `--r2-endpoint` / `--r2-access-key-id` / `--r2-secret-access-key`
- `--r2-account-id` / `--r2-jurisdiction`
- `--frontend-root`
- `--wrangler-bin` / `--wrangler-config`
- `--skip-upload` / `--dry-run`

Common examples:

- Build the Windows bundle and prepare a publish dry-run using `.env.r2.local`:
  `npm run ota:build:publish:cloudflare -- --channel=stable --rollout-percent=100 --dry-run`
- Publish an existing frontend dist directory with explicit overrides:
  `npm run ota:publish:cloudflare -- --source-dir=..\\opapp-frontend\\.dist\\bundles\\companion-app\\windows --channel=beta --rollout-percent=10 --remote-base=https://r2.opapp.dev --cloudflare-bucket=cross-platform-ota`

## Contributing

Contribution workflow, repo boundaries, and submission expectations live in
[CONTRIBUTING.md](./CONTRIBUTING.md).

Please follow [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)
when collaborating in issues, reviews, and pull requests.

## Security

For responsible disclosure guidance, see
[SECURITY.md](./SECURITY.md).
