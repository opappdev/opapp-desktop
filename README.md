# opapp-desktop

`opapp-desktop` is the desktop host repo for OPApp.

It owns:

- Windows and macOS hosts
- desktop platform bridges
- packaging, signing, and release flow

Business structure stays in `opapp-frontend`.

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

Use `npm run verify:windows:surface-model` or `npm run smoke:windows:surface-model`
only when validating multi-surface or multi-window behavior.

Use `npm run verify:windows:portable:surface-model` or
`npm run smoke:windows:portable:surface-model` only when validating the same
surface model behavior through the direct-run release directory artifact.

All smoke entrypoints clean up the launched Windows host process before
returning.

## OTA Cloudflare Publish (Windows First)

Use `npm run ota:publish:cloudflare -- ...` to publish a built bundle through
the Cloudflare-backed OTA path while keeping runtime protocol unchanged
(`index.json`, `bundles`, `versions`, `latestVersion`, `channels`,
`rolloutPercent`).

Required flags:

- `--bundle-id`
- `--platform`
- `--version`
- `--remote-base`
- `--channel`
- `--rollout-percent`
- `--cloudflare-bucket`

Optional flags:

- `--source-dir` (publish build output into local registry before upload)
- `--registry-dir`
- `--cloudflare-prefix` (defaults to URL path in `--remote-base`)
- `--wrangler-bin` / `--wrangler-config`
- `--skip-upload` / `--dry-run`
