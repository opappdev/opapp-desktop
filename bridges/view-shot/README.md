# bridge-view-shot-windows

Windows native module implementation contract for a `react-native-view-shot`-style
bridge in OPApp.

## Native Module Name

`OpappViewShot`

Register with `REACT_MODULE(OpappViewShotModule, L"OpappViewShot")`.

## Supported API Surface

### `captureRegion(x: number, y: number, width: number, height: number, optionsJson: string) -> Promise<string>`

Captures a region inside the currently focused OPApp window client area.

The companion frontend wrapper keeps the public `captureRef(...)` API and
implements it on Windows by:

- measuring the target view with `measureInWindow`
- forwarding the measured region to `captureRegion(...)`

Supported options:

- `format`: `png` or `jpg`
- `result`: `tmpfile`, `base64`, or `data-uri`
- `quality`: `0..1` for JPEG output
- `width` / `height`: optional resize target
- `fileName`: optional file stem when `result="tmpfile"`

Current Windows behavior:

- `x`, `y`, `width`, and `height` are interpreted in React layout units relative
  to the focused OPApp window client area.
- The host converts that region to window DPI-scaled screen pixels before
  sampling the visible desktop surface.
- If the OPApp window is fully covered, minimized, or off-screen, the capture is
  not guaranteed to match mobile `react-native-view-shot` semantics.

### `captureScreen(optionsJson: string) -> Promise<string>`

Captures the currently focused OPApp window client area using the same options as
`captureRegion`.

Current Windows behavior:

- The capture target is the current foreground OPApp window client area, not the
  full OS monitor.
- This keeps the API close to `react-native-view-shot` while matching the host's
  multi-window surface model.

### `releaseCapture(uri: string) -> Promise<boolean>`

Deletes a previously generated tmpfile capture if it still lives under the
managed host capture directory.

## Storage

Tmpfile captures are written under:

- `%TEMP%\OPApp\view-shot\`

Only files inside that directory may be deleted through `releaseCapture`.
