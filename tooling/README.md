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

Windows smoke timeout knobs:

- `--readiness-ms`: timeout for pre-smoke readiness checks.
- `--smoke-ms`: legacy/global timeout fallback for release smoke phases.
- `--startup-ms`: startup-marker wait timeout in `windows-release-smoke.mjs`.
- `--scenario-ms`: scenario success-marker wait timeout after startup markers pass.
