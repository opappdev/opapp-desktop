# bridge-terminal-windows

Windows native module contract for the agent terminal/process runtime bridge
used by `@opapp/framework-agent-runtime`.

## Native Module Name

`OpappAgentTerminal`

## Workspace Scope

Terminal sessions launch inside the persisted trusted workspace root:

- `%LOCALAPPDATA%\OPApp\agent-runtime\workspace-target.json`

`cwd` is resolved as a relative path under that trusted workspace root. The
native bridge must reject missing roots, path traversal, and non-directory
targets.

## Methods

### `openSession(requestJson: string) -> Promise<string>`

Launches one terminal/process session and resolves a generated `sessionId`.

Expected JSON request shape:

```json
{
  "command": "git status",
  "cwd": "opapp-frontend",
  "env": {
    "FOO": "bar"
  },
  "shell": "powershell"
}
```

Rules:

- `command` is required.
- `cwd` is optional and relative to the trusted workspace root.
- `env` is optional and is merged onto the inherited process environment.
- `shell` currently supports `powershell` (default) and `cmd`.

### `cancelSession(sessionId: string) -> Promise<void>`

Cancels a running session. The native implementation should terminate the full
process tree rather than only the immediate shell process.

### `writeSessionInput(sessionId: string, text: string) -> Promise<void>`

Writes raw UTF-8 text to the session stdin pipe.

### `addListener(eventName: string)` / `removeListeners(count: number)`

No-op React Native event-emitter methods required for `NativeEventEmitter`.

## Native Event Contract

Events are emitted on `RCTDeviceEventEmitter` with event name
`opapp.agentTerminal`.

Normal event payload:

```json
{
  "sessionId": "terminal-1",
  "type": "event",
  "event": "stdout",
  "text": "working tree clean\n",
  "cwd": "D:/code/opappdev/opapp-frontend",
  "command": "git status",
  "createdAt": "2026-04-02T12:00:01.000Z"
}
```

Exit event payload adds `exitCode`.

Supported `event` values align with the agent runtime model:

- `started`
- `stdout`
- `stderr`
- `stdin`
- `exit`

## Security Notes

- Reject sessions when no trusted workspace root is configured.
- Reject `cwd` values that escape the trusted workspace root.
- Merge env overrides onto the inherited process environment rather than
  replacing `PATH` and related defaults.
- Route cancellation through a job object so child processes are torn down too.
- Use background threads for launch, pipe reads, and exit waits.
