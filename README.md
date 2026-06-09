# opencode-keepalive

OpenCode plugin that prevents the host machine from sleeping while AI sessions are active.

## How it works

When any session enters `busy` or `retry` status, the plugin spawns a background process that holds a system wake lock. When all sessions return to `idle` (or are deleted/errored), the wake lock is released and the machine can sleep normally.

Cross-process reference counting ensures that multiple opencode instances sharing the same machine won't release the lock prematurely — the wake lock persists until the *last* active session goes idle.

## Supported platforms

| Platform | Mechanism |
|----------|-----------|
| Windows / WSL2 | `SetThreadExecutionState` via detached `powershell.exe` |
| macOS | `caffeinate -dim` |
| Linux | `systemd-inhibit --what=idle:sleep` |

## Install

Clone the repo and reference the directory in your `opencode.jsonc`:

```bash
git clone https://github.com/mattaschmann/opencode-keepalive.git ~/path/to/opencode-keepalive
```

Then in your project's (or global) `opencode.jsonc`:

```jsonc
{
  "plugin": ["~/path/to/opencode-keepalive"]
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

- opencode v1.16.2 on WSL2 (Windows host)
- Confirmed: `session.status` events fire with `busy`→`idle` transitions
- Confirmed: cross-process ref counting holds lock across concurrent sessions
- Confirmed: cancelled sessions release correctly

## Privacy

This plugin does not transmit any data over the network. All state is stored locally in `~/.cache/opencode-keepalive/lock.json` (session IDs and the holder process PID). Debug-level structured logs include session IDs and event metadata, written only to opencode's local log files. No telemetry, no external requests.
