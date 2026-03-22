# opapp-desktop

`opapp-desktop` is the desktop host repo for OPApp.

It owns:

- Windows and macOS hosts
- desktop platform bridges
- packaging, signing, and release flow

Business structure stays in `opapp-frontend`.

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
