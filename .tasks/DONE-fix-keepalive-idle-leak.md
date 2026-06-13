# fix-keepalive-idle-leak

## Objective

Ensure the wake lock is held only while an agent is actually busy, and is
released within one heartbeat interval after the agent goes idle — even when a
`session.status idle` event is never delivered.

## Background

The happy-path event handler (`src/index.ts:205-217`) correctly gates the wake
lock on `busy`/`idle`. The bug is in the heartbeat safety net:

- `onHeartbeat` calls `touchOwnSessions(data)`, which unconditionally refreshes
  `lastSeen = now` for every session owned by this process.
- `reapDead` only removes sessions whose PID is dead *or* whose `lastSeen` is
  stale — but own sessions were just touched, so they're never stale, and the
  opencode server PID is always alive.
- Therefore any session that went idle but whose `idle` event was dropped (server
  restart mid-turn, aborted turn, missed delivery) is pinned forever, holding the
  wake lock for the entire server lifetime.

The `STALE_SESSION_MS` backstop is effectively dead code for self-owned sessions.

## Fix lever

`client.session.status()` (`GET /session/status`) returns
`Record<sessionID, SessionStatus>` — the same `idle`/`busy`/`retry` discriminator
the event handler uses. The heartbeat should reconcile tracked sessions against
this authoritative source rather than blindly touching them.

**SDK types:**
- `SessionStatus = { type:"idle" } | { type:"busy" } | { type:"retry"; ... }`
- `SessionStatusResponses[200] = { [key: string]: SessionStatus }` 
  (`node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts:396, 1851`)

## Success criteria

- [x] A tracked session the server reports as `idle` (or absent from the map) is
      dropped on the next heartbeat; if `activeSessions` becomes empty, the
      holder is released.
- [x] A session reported as `busy`/`retry` keeps its `lastSeen` refreshed (no
      premature release during long turns).
- [x] A transient `client.session.status()` failure falls back to today's
      touch-all behavior — a network blip cannot drop a busy session.
- [x] Cross-process dead-PID reaping (`reapDead`) and orphan-holder release are
      preserved unchanged.
- [x] `npm run typecheck` and `npm test` pass with no regressions.

## Implementation plan

- [x] **Pass `client` into `createSharedHandler`** — already in closure; no
      change needed.
- [x] **Replace `touchOwnSessions` in `onHeartbeat` with async reconcile:**
  - Call `const statuses = await client.session.status()` (no `directory` param
    needed — returns all sessions for this instance).
  - For each own session (`entry.pid === process.pid`):
    - If `statuses[entry.id]?.type` is `"busy"` or `"retry"` → refresh
      `entry.lastSeen = now` (touch, same as today).
    - If `"idle"` or the id is absent from the map → remove from
      `activeSessions`.
  - On SDK call error: catch, log at `warn` level, fall back to touching all
    own sessions (fail-safe, same as current behavior).
  - After reconcile: if `activeSessions` is non-empty, call `ensureHolder()`
    — it re-acquires a dead/missing holder and is a no-op when the holder is
    alive. If `activeSessions` is empty, call `releaseHolder()`. Both helpers
    already call `reapDead()` internally; do not call it separately.
- [x] **`onHeartbeat` becomes `async`** — wrap the `setInterval` callback so the
      returned promise errors are caught and logged, consistent with fail-quiet
      convention. The timer ref is unchanged (`heartbeatTimer.unref()`).
- [x] **`touchOwnSessions` helper** — kept; call site narrowed to fallback only.
- [x] **Update `test/heartbeat.test.ts`:**
  - Mock `client.session.status` returning `{ [sessionID]: { type: "idle" } }` →
    session removed + holder released after heartbeat tick.
  - Returning `{ [sessionID]: { type: "busy" } }` → session retained, `lastSeen`
    advanced.
  - SDK call throws → session retained (no premature release).
  - Session ID absent from the map → treated as gone, removed.
  - Sessions still busy but holder PID is dead → `ensureHolder` re-acquires on heartbeat.
- [x] Run `npm run typecheck && npm test` — confirm green.

---

## Note (2026-06-13)

The `client.session.status()` heartbeat reconcile added in this task (commit
`227a4db`) was reverted by `.tasks/revert-keepalive-reconcile.md`. A self-test
proved the polling endpoint reports `idle` during tool calls (not just at turn
end), causing the heartbeat to drop the wake lock mid-turn for any tool call
longer than the 30s heartbeat interval. The event-driven model
(busy/retry → acquire, idle/session.idle/deleted/error → release) is sound; the
polling endpoint is not.
