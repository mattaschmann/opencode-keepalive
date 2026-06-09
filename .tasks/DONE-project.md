# opencode-espresso — Cross-Platform Sleep Prevention Plugin

> **Project name is a placeholder.** Candidates: `opencode-espresso`, `opencode-redeye`, `opencode-keep-awake`, `opencode-wakeful`. Confirm before publishing (Phase 7).

## Objective

Build an OS-agnostic opencode plugin that prevents the host machine from sleeping while an AI job is actively running, and releases the wake lock once the session goes idle (waiting for user input).

## Success criteria

- [ ] Sleep is prevented while a session status is `busy` or `retry`
- [ ] Sleep is allowed within seconds of a session going `idle`
- [ ] Works on macOS, WSL2, native Linux, and native Windows
- [ ] Parallel sessions do not release the lock prematurely (reference counted)
- [ ] On powercfg-based platforms, the user's original sleep timeout is restored (not a hardcoded value)
- [ ] Published to npm and installable via `opencode.json` `plugin` array

---

## Verified technical reference

> These facts were confirmed against opencode's `types.gen.ts` and plugin docs. Do not re-derive — trust and use.

### Plugin structure
- A plugin is a TS/JS module exporting a `Plugin` function: `async (ctx) => ({ ...hooks })`.
- Context provides: `project`, `directory`, `worktree`, `client` (SDK), `$` (Bun shell API).
- Local global plugins live in `~/.config/opencode/plugins/`; project plugins in `.opencode/plugins/`.
- npm plugins are listed in `opencode.json` under `"plugin": [...]` and auto-installed via Bun.
- Use `client.app.log({ body: { service, level, message, extra } })` for structured logging, NOT `console.log`. Levels: `debug`, `info`, `warn`, `error`.

### Event payload shapes (authoritative)
```ts
type SessionStatus =
  | { type: "idle" }
  | { type: "retry"; attempt: number; message: string; next: number }
  | { type: "busy" }

type EventSessionStatus = {
  type: "session.status"
  properties: { sessionID: string; status: SessionStatus }
}

type EventSessionIdle = {
  type: "session.idle"
  properties: { sessionID: string }
}
```
- **Drive logic off `session.status`.** Access state at `event.properties.status.type`.
- `"busy"` and `"retry"` → keep awake. `"idle"` → allow sleep.
- `event.properties.sessionID` identifies which session (needed for reference counting).
- Do NOT use `session.created`/`session.deleted` as the busy/idle signal — `created` fires once per session, not per AI turn.

### Platform strategy matrix
| Platform | Detect | Acquire lock | Release lock |
|---|---|---|---|
| macOS | `platform() === "darwin"` | spawn `caffeinate -dim`, track PID | kill the PID |
| WSL2 | `platform() === "linux"` AND `process.env.WSL_DISTRO_NAME` set | `powershell.exe -Command "powercfg /change standby-timeout-ac 0"` | restore saved timeout |
| native Linux | `platform() === "linux"` AND no WSL var | long-running `systemd-inhibit` (fallback `xdg-screensaver`), track PID | kill the inhibitor PID |
| native Windows | `platform() === "win32"` | same as WSL2 | same as WSL2 |

### Known risks
- **Issue #12860 (v1.1.53):** `/session/status` HTTP endpoint reportedly returned values not matching docs. Unclear whether the event stream is affected. **Phase 1 logging de-risks this — do it before building anything else.**
- WSL2 → `powershell.exe` assumes interop is enabled (default true). Log a clear warning and no-op if `powershell.exe` is not on PATH.
- `powercfg /change standby-timeout-ac` only touches the AC profile. Consider also setting `standby-timeout-dc` for laptops on battery.

---

## Phase 1 — Skeleton & event discovery
- [ ] Init project: `package.json`, `tsconfig.json`, dependency on `@opencode-ai/plugin` (types only)
- [ ] Create plugin entry exporting a `Plugin` function with an `event` hook
- [ ] Log every event whose `type` starts with `session.` via `client.app.log` (include full `properties`)
- [ ] Install locally into `~/.config/opencode/plugins/` and run a real opencode session
- [ ] Confirm `session.status` fires with `properties.status.type` cycling `busy` → `idle` on this opencode version
- [ ] Record observed behavior in the README (version tested)

## Phase 2 — macOS path (reference implementation)
- [ ] Implement platform detection helper returning `"darwin" | "wsl2" | "linux" | "win32"`
- [ ] `acquire()`: spawn `caffeinate -dim` via `$`, store the child process/PID
- [ ] `release()`: kill the stored PID (use `.nothrow()` equivalent so a dead PID doesn't crash)
- [ ] Wire `session.status`: `idle` → release, else → acquire
- [ ] Manually verify with `pmset -g assertions` that an assertion appears while busy and clears when idle

## Phase 3 — WSL2 / Windows path
- [ ] On first `acquire()`, read current AC timeout (`powercfg /query` or `/getactivescheme`) and cache it
- [ ] `acquire()`: set `standby-timeout-ac 0` (and optionally `standby-timeout-dc 0`)
- [ ] `release()`: restore the cached original timeout value(s)
- [ ] Detect missing `powershell.exe` on PATH → log warning, no-op gracefully
- [ ] Verify on a Windows host that the power plan changes and reverts correctly

## Phase 4 — Native Linux path
- [ ] `acquire()`: spawn long-running `systemd-inhibit --what=idle:sleep --why="opencode AI job" sleep infinity`, track PID
- [ ] `release()`: kill the inhibitor PID
- [ ] Fallback to `xdg-screensaver reset` loop if `systemd-inhibit` is unavailable
- [ ] Verify with `systemd-inhibit --list` that the lock appears and clears

## Phase 5 — Reference counting (parallel sessions)
- [ ] Track active session IDs in a Set: add on busy/retry, remove on idle
- [ ] `acquire()` only when the Set transitions 0 → 1; `release()` only on 1 → 0
- [ ] Handle `session.deleted` / `session.error` as forced removals from the Set
- [ ] Decide single-process vs cross-process scope; if cross-process needed, use file-based PID tracking (mirror the approach used by the macOS-only `opencode-caffeinate` package)
- [ ] Test with two concurrent sessions: lock holds until BOTH go idle

## Phase 6 — Config & polish
- [ ] Support optional config (e.g. `keepDisplayAwake`, per-platform opt-out, custom DC handling)
- [ ] Ensure idempotent acquire/release (double-acquire and double-release are safe)
- [ ] Add a safety net: release lock on plugin teardown / process exit if reachable
- [ ] Structured logging at `info` for acquire/release, `warn` for unsupported platform

## Phase 7 — Publish
- [ ] Finalize project name (see candidates at top)
- [ ] Write README: what it does, supported platforms, install snippet for `opencode.json`, version tested
- [ ] Add LICENSE
- [ ] Publish to npm
- [ ] Verify clean install: add package name to a fresh `opencode.json` `plugin` array and confirm Bun auto-installs and the plugin loads

---

## Agent notes
- Prefer the `$` Bun shell API from plugin context over raw `child_process`.
- Never hardcode the restore timeout value on powercfg platforms — always save/restore the user's real setting.
- Treat any non-`idle` status as "keep awake."
- When uncertain about live event behavior, fall back to the Phase 1 logging approach rather than assuming.

---

## Implementation Plan (2026-06-08)

Scope: WSL2-verifiable build. Phases 1, 3, 5 from the master plan, with the
WSL2/Windows path as the reference implementation (macOS/Linux deferred).
Windows mechanism: SetThreadExecutionState via detached powershell.exe (not powercfg).
Cross-process ref counting via ~/.cache/opencode-keepalive/lock.json with heartbeat re-spawn.

- [x] Init project: package.json (name "opencode-keepalive"), tsconfig.json, devDep on @opencode-ai/plugin (types only)
- [x] Create plugin entry exporting a Plugin function with an `event` hook
- [x] Log every `session.*` event via client.app.log, including full `properties` (de-risk issue #12860)
- [x] Install locally (opencode.jsonc `"plugin": ["./"]`), run a real session, confirm session.status cycles busy→idle on this opencode version; note version observed
- [x] Add platform detection helper → "darwin" | "wsl2" | "linux" | "win32"
- [x] Implement Windows/WSL2 acquire(): spawn detached `powershell.exe` running a loop that calls SetThreadExecutionState(ES_CONTINUOUS|ES_SYSTEM_REQUIRED); capture its PID
- [x] Implement release(): kill the holder PID (no-throw on dead PID)
- [x] Detect missing powershell.exe on PATH → log warn, no-op gracefully
- [x] Implement cross-process lock file at ~/.cache/opencode-keepalive/lock.json: { activeSessions: string[], holderPid: number }
- [x] Ref counting: add sessionID on busy/retry, remove on idle; acquire on 0→1, release on 1→0; treat session.deleted/session.error as forced removals
- [x] Heartbeat/re-spawn: on each transition, if activeSessions non-empty but holderPid is dead, re-spawn the ES holder and update the file
- [x] Idempotent acquire/release (double-acquire / double-release safe); release on plugin teardown / process exit if reachable
- [x] Structured logging: info on acquire/release, warn on unsupported platform
- [x] Verify on Windows host: open two concurrent sessions; lock holds until BOTH idle; kill the owner process mid-session and confirm a surviving process re-acquires
- [x] Stub macOS (caffeinate) and Linux (systemd-inhibit) acquire/release behind the platform switch, marked deferred/unverified
- [x] Update README: behavior observed, supported platforms, opencode.json install snippet, version tested
- [x] Jest test suite: lock-store round-trip/corrupt recovery, ref-count transitions, platform detection (18 tests passing)
