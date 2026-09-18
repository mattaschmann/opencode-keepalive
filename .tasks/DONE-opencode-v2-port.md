# Port to the OpenCode V2 plugin API

V1 plugin implementations do not run in OpenCode 2. This plugin currently
**fails to load** on the live V2 daily driver (`Expected object at ["default"]`),
so keepalive is inactive until ported to `Plugin.define({ id, setup(ctx) })`.

Gate is cleared (Kiro provider works under V2). Shared how-to with verified
templates and the full event map:
`~/workspace/dotfiles/.tasks/opencode-v2-plugin-port-recipe.md` (see §6 — this is
the most lifecycle-entangled port). This file tracks repo-specific residue.

## What this plugin uses today

- `event({ event })` - session lifecycle (`src/index.ts:48`, `:205`).
- `dispose()` - the only plugin using dispose (`src/index.ts:277`).
- `client.app.log(...)` - logging (`src/index.ts:36`).
- `Symbol.for('opencode-keepalive')` global singleton, `setInterval` heartbeat,
  `process.on('exit')`, detached per-platform subprocesses (caffeinate /
  systemd-inhibit / PowerShell), cross-process file lock.

## V2 mapping (verified — see recipe §2/§3)

| V1 | V2 |
|---|---|
| default fn export | `Plugin.define({ id, setup })` — object, or rejected |
| `event` | `ctx.event.subscribe({ signal })`; `event.data` not `.properties` |
| `dispose` | cleanup function returned by `setup` |
| `client.app.log` | `console.error` (no V2 equivalent) |
| `session.error` | `session.execution.failed` |

## Open question (repo-specific)

- How does the `Symbol.for` cross-process singleton behave under V2's server
  model? V2 runs a persistent background service (`opencode serve --service`);
  re-validate the singleton + file-lock lifecycle against V2's per-location
  plugin instances and cleanup contract.

## Decisions

- **Still needed — V2 has no built-in wake lock.** *Why:* verified five ways
  against opencode v2.0.8: binary strings (no `caffeinate`/`systemd-inhibit`/
  `SetThreadExecutionState`/`IOPMAssertion`; only X509 `inhibitAnyPolicy` +
  `nanosleep`), `otool -L` (no IOKit linked), full V2 config reference (no
  power/sleep field), `opencode plugin list --builtin` (~80 builtins, none),
  and `/openapi.json` (`idle` is only a session-status value). `warming` is
  unrelated (sends model requests to keep provider caches warm). The V1
  third-party `opencode-wakelock` is also dead on V2 (`@opencode-ai/plugin`,
  `engines.opencode >=1.14.0`).
- **Port to `Plugin.define({ id: "keepalive", setup })`.** *Why:* V2's loader
  predicate rejects a function default export (current live error: "Plugin must
  export a default definition with an id and an effect or setup function").
- **Replace the cross-process file lock with an in-process session `Set`.**
  *Why:* V2 runs one persistent background service owning all sessions, so the
  N-process coordination that `src/lock/store.ts` solved no longer exists. The
  existing `Symbol.for('opencode-keepalive')` singleton already covers multiple
  plugin instances within that one process.
- **Make the inhibitor self-terminating instead of heartbeat-reaped.** *Why:*
  the only thing the file lock genuinely bought was orphan recovery — a
  SIGKILLed server leaves a detached inhibitor alive forever and the host never
  sleeps again. Watching the parent moves that guarantee from polling into the
  OS. Mechanisms:
  - darwin: `caffeinate -i -m -w <server pid>` (verified via man page: `-w`
    holds the assertion until the watched pid exits; ignored only when a utility
    arg is passed, and we pass none).
  - linux: `systemd-inhibit --what=idle:sleep --why=… sh -c 'cat >/dev/null'`
    with the server's stdin piped in; EOF on server death releases it.
  - win32 / wsl2: PowerShell reads stdin to EOF instead of `while ($true)`. The
    stdin-EOF variant is what makes WSL2 work — a Windows-side `Get-Process`
    can't see a Linux pid, but an inherited pipe closes across the boundary.
- **Drive state from `session.status` only; use `session.deleted` +
  `session.execution.failed` as safety releases.** *Why:* verified against the
  installed `@opencode/schema`: `session.idle` is marked `// deprecated` and is
  redundant with `status.type === "idle"`. `session.deleted` payload is
  `{ sessionID }` (V1 read `properties.info.id` — a path change, not just a
  container rename). `session.error` → `session.execution.failed` with
  `{ sessionID, error }`.
- **Drive state from `session.execution.*` (CORRECTED 2026-09-19).** *Why:* the
  recipe/schema claimed `session.status` (busy/idle) survives V2, but a live
  trace of the 2.0.8 public stream shows **no `session.status` and no
  `session.idle` are ever emitted** — the busy lifecycle is
  `session.execution.started` (→acquire) then `session.execution.succeeded` /
  `.failed` / `.interrupted` (→release), all carrying `{ sessionID }` (Failed
  adds `error`, Interrupted adds `reason`). `session.deleted` (`{ sessionID }`)
  kept as a safety release. The original `session.status` state machine loaded
  `active` but never acquired.
- **Event loop must not swallow handler errors.** *Why:* the initial port
  wrapped the whole `for await` in one `try/catch`, so a thrown handler error
  would end the subscription for the process lifetime. The catch now sits inside
  the loop and logs, keeping the subscription alive.
- **Centralize logging in `src/log.ts` wrapping `console.error`.** *Why:*
  `client.app.log` has no V2 equivalent; one module keeps a single logging seam
  instead of scattering `console.error`.
- **Keep `process.on('exit')` sync cleanup.** *Why:* cheap belt-and-braces for
  the normal-exit path; the PID watch covers the abnormal one.

## Checkpoint

**Goal:** Port opencode-keepalive from the V1 plugin API to V2 (`Plugin.define`),
replacing the cross-process file lock with an in-process session set and a
self-terminating (PID/stdin-watching) inhibitor.
**Key decisions:** in-process `Set` (no file lock); inhibitor watches server via
`caffeinate -w` / stdin-EOF; drive from `session.execution.started` (busy) +
`session.execution.succeeded`/`.failed`/`.interrupted` + `session.deleted`
(release) — `session.status` proved never-emitted on 2.0.8 (see Decisions
2026-09-19 correction); log via `src/log.ts` → stderr; keep `process.on('exit')`
cleanup.
**Done:** all 9 plan items complete
**Next:** run `wrap-task`
**Blockers:** none
**Key files:** src/index.ts, src/keepalive/{shared,darwin,linux,windows}.ts,
src/types.ts, src/lock/store.ts (to delete), test/*.
**Ported target of @opencode/plugin:** 2.0.8 (matches installed opencode).

## Implementation Plan

- [x] `package.json`: add `@opencode/plugin@2.0.8` as a dependency, add
      `"exports": { ".": "./src/index.ts" }`, drop the `opencode.{type,hooks}`
      manifest and the `@opencode-ai/plugin` peer dep.
  - 2026-09-19: done — added `@opencode/plugin@2.0.8` dep + `exports`, removed V1 peer dep and `opencode` manifest; probe confirms `Plugin.define`/`ctx.event.subscribe`/`event.data` typecheck clean.
- [x] Add `src/log.ts`; delete `src/lock/store.ts` and remove
      `STALE_SESSION_MS`/`HEARTBEAT_MS`.
  - 2026-09-19: done — added `src/log.ts` (stderr seam); deleted `src/lock/store.ts` + empty `src/lock/`; trimmed `constants.ts` to `SERVICE`; dropped `SessionEntry`/`LockData` from `types.ts` and extended `KeepaliveBackend.acquire(watchPid)`.
- [x] Extend `KeepaliveBackend.acquire` to take a watch pid; update
      `spawnDetached` in `keepalive/shared.ts` to support a piped stdin.
  - 2026-09-19: done — `acquire(watchPid)` in types; `spawnDetached` now takes `{ stdin: 'ignore'|'pipe' }` and returns `{ pid, child }` so the pipe write end stays parent-held for EOF-on-exit.
- [x] Rewrite the three backends for the self-terminating mechanisms above.
  - 2026-09-19: done — darwin `caffeinate -i -m -w <pid>`; linux `systemd-inhibit … sh -c 'cat >/dev/null'` with piped stdin (EOF release); windows/wsl2 PowerShell `[Console]::In.ReadToEnd()` with piped stdin.
- [x] Rewrite `src/index.ts` around `Plugin.define` + `ctx.event.subscribe({
      signal })` + cleanup return, with an in-process `Set<string>` of busy
      sessions and acquire/release on empty↔non-empty transitions.
  - 2026-09-19: done — `Plugin.define({ id:'keepalive', setup })`; Symbol.for singleton with ref-counted attach/cleanup; in-process `busySessions` Set; drives on `session.execution.started` (add) + `session.execution.succeeded`/`.failed`/`.interrupted`/`session.deleted` (remove) — see the 2026-09-19 correction above (the initial `session.status` state machine loaded `active` but never fired); inhibitor watches `process.pid`; kept `process.on('exit')`. Source typechecks; only test files error (step 6).
- [x] Delete `test/cross-process.test.ts`, `test/lock-store.test.ts`,
      `test/heartbeat.test.ts`; rewrite `test/ref-count.test.ts` and
      `test/idempotent.test.ts` for the `setup` shape; keep `platform.test.ts`
      and update `darwin.test.ts` for the new `-w` argv.
  - 2026-09-19: done — deleted the 3 lock/heartbeat suites; rewrote ref-count + idempotent around `plugin.setup(ctx)` with a push-driven fake `event.subscribe`; darwin asserts `-i -m -w <pid>`.
- [x] Add a backend test asserting each platform passes the watch pid / piped
      stdin.
  - 2026-09-19: done — `test/backends.test.ts` asserts linux/windows piped stdin (`stdio:['pipe','ignore','ignore']`) + argv; darwin covers the `-w` watch pid. All 5 suites / 24 tests pass.
- [x] `npm run typecheck && npm test`, then `opencode service restart` and
      confirm `opencode api get /api/plugin` reports `keepalive` as `active`.
  - 2026-09-19: done — typecheck clean, 24 tests pass; after `service restart` the live daemon reports `keepalive -> {status: active}` (was `failed`). Confirmed active alongside kiro-cli + ping.
- [x] Update `AGENTS.md` (drop removed env vars + lock-file architecture) and
      `README.md`.
  - 2026-09-19: done — AGENTS.md rewritten for V2 (in-process set, PID/stdin orphan guard, `src/log.ts`, new file map) and env-var table removed; README updated (V2, `plugins` key, self-terminating inhibitor, no disk state, v2.0.8 tested).
