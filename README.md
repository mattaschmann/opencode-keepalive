# opencode-keepalive

OpenCode **V2** plugin that prevents the host machine from sleeping while AI sessions are active.

## How it works

When any session begins execution (`session.execution.started`), the plugin spawns a background process that holds a system wake lock. When all sessions finish (`session.execution.succeeded` / `.failed` / `.interrupted`, or `session.deleted`), the wake lock is released and the machine can sleep normally.

> Note: OpenCode V2 (2.0.8) does not emit `session.status`/`session.idle` on the public event stream — `session.execution.*` is the busy signal this plugin keys on.

The plugin prevents system/disk sleep only — the display is allowed to sleep on its own schedule.

Because OpenCode V2 runs a single persistent background service that owns every session, state is a plain in-process set of busy session IDs — no cross-process file lock. The wake lock persists until the *last* active session goes idle. The inhibitor also watches the server process and self-terminates if it is killed, so a crashed server can't leave the host awake forever: `caffeinate -w <pid>` on macOS, and a parent-held stdin pipe that reaches EOF on server death on Linux/Windows (this also works across the WSL2 → Windows boundary).

## Supported platforms

| Platform | Mechanism |
|----------|-----------|
| Windows / WSL2 | `SetThreadExecutionState` via detached `powershell.exe`, released on stdin EOF |
| macOS | `caffeinate -i -m -w <server-pid>` |
| Linux | `systemd-inhibit --what=idle:sleep`, released on stdin EOF |

## Install

Clone the repo and reference the directory in your `opencode.jsonc`:

```bash
git clone https://github.com/mattaschmann/opencode-keepalive.git ~/path/to/opencode-keepalive
```

Then in your project's (or global) `opencode.jsonc`:

```jsonc
{
  "plugins": ["~/path/to/opencode-keepalive"]
}
```

## Requirements

- Windows/WSL2: `powershell.exe` must be on PATH (default for WSL2 with interop enabled)
- macOS: `caffeinate` (ships with macOS)
- Linux: `systemd-inhibit` (part of systemd)

If the platform tool is unavailable, the plugin logs a warning and operates as a no-op.

## Development

```sh
npm install
npm run typecheck
npm test
```

No build step — the plugin ships as TypeScript source and is loaded directly by OpenCode via Bun.

## Version tested

- opencode v2.0.8 (macOS/darwin)
- Confirmed: loads as `active` via `opencode api get /api/plugin`
- Confirmed live: `caffeinate -i -m -w <server-pid>` spawns on `session.execution.started` during a real turn (verified via `pmset -g assertions`)
- macOS (darwin): verify via `pmset -g assertions` — `PreventUserIdleSystemSleep` + `PreventDiskIdle` assert on acquire, clear on release

## Privacy

This plugin does not transmit any data over the network. All state is in-process (session IDs and the holder process PID); nothing is persisted to disk. Structured logs include session IDs and event metadata, written only to stderr / opencode's local log files. No telemetry, no external requests.
