# distribution

Packaging, signing, release, and artifact-consumption concerns live here.

This layer does not own business logic, frontend app entry code, or bundle generation.
Generated artifacts may be staged here locally, but binary outputs should not be committed to git.

Current Windows release entrypoints live under `tooling/scripts/`:

- `windows-nightly-release-assets.mjs` for nightly/test-signed packaging
- `windows-official-release-assets.mjs` for CA-signed tagged releases
- `windows-signing.mjs` for shared MSIX signing/export helpers
