# bridge-window-capture-windows

Windows native module contract for external top-level window capture in OPApp.

## Native Module Name

`OpappWindowCapture`

Register with `REACT_MODULE(OpappWindowCaptureModule, L"OpappWindowCapture")`.

## Planned API Surface

### `listVisibleWindows(selectorJson: string) -> Promise<string>`

Returns a JSON array string describing visible top-level windows that match the
selector.

Selector payload should stay aligned with the existing CLI:

- `foreground?: boolean`
- `handle?: number`
- `processName?: string`
- `titleContains?: string`
- `titleExact?: string`
- `className?: string`

Each returned item should include at least:

- `handle`
- `handleHex`
- `processId`
- `processName`
- `title`
- `className`
- `isForeground`
- `isMinimized`
- `windowRect`
- `clientRect`
- `monitorRect`

### `captureWindow(selectorJson: string, optionsJson: string) -> Promise<string>`

Returns a JSON object string describing one completed capture.

Options payload should stay aligned with the existing CLI:

- `activate?: boolean`
- `activationDelayMs?: number`
- `backend?: "auto" | "copy-screen" | "wgc"`
- `region?: "client" | "window" | "monitor"`
- `format?: "png" | "jpg"`
- `timeoutMs?: number`
- `includeCursor?: boolean`
- `outputPath?: string`

Current semantic target:

- `backend=auto` prefers `wgc` for `client` / `window`
- `backend=auto` keeps `copy-screen` for `monitor`
- `region=client` on the WGC path means `window` capture plus client-area crop

The returned JSON object should preserve the same operator-facing fields exposed
by the CLI where practical:

- `outputPath`
- `format`
- `region`
- `backend`
- `requestedBackend`
- `selectedWindow`
- `captureRect`
- `captureSize`
- `sourceItemSize`
- `cropBounds`

## Design Notes

- The bridge contract should stay close to the existing CLI so tooling and
  product surfaces do not drift into different selector / option dialects.
- If the implementation keeps using an external helper for WGC, the bridge
  should still normalize output into the same JSON shape instead of leaking
  subprocess-specific details to JS callers.
