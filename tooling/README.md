# tooling

Desktop repo-specific engineering support lives here.

Key OTA publishing entrypoint:

- `scripts/ota-cloudflare-publish.mjs`: Windows-first Cloudflare publish flow
  (`bundle -> local registry -> index merge -> upload`).
