# windows-host

The desktop host lives here.

Current scope:

- React Native Windows 0.82 native host
- Debug launch against the frontend Metro dev server
- Release packaging of a frontend-produced Windows bundle
- Native integration, packaging, and host-side smoke validation
- Direct-run Windows release directory support for `x64\\Release\\OpappWindowsHost.exe`

Useful commands:

- Start Metro in `opapp-frontend`: `pnpm start:companion:windows`
- Launch the Windows host here: `npm run windows`
- Build the Windows host here: `npm run build:windows`

Notes:

- The packaged validation path is exercised from `opapp-desktop` via `npm run verify:windows`.
- The portable validation path is exercised from `opapp-desktop` via `npm run verify:windows:portable`.
- The direct-run executable is supported as a release directory artifact, not as a single standalone `.exe` file.
