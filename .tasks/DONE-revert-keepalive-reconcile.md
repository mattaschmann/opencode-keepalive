# revert-keepalive-reconcile

## Objective

Revert the unsound `client.session.status()` heartbeat reconcile (commit
`227a4db`) and restore event-driven wake-lock release. Keep the safe,
polling-independent improvements (dead-holder re-acquire on heartbeat) and add
`session.idle` as an extra turn-end release trigger.

## Why (self-test finding)

A self-test inside opencode (`session-ses_13dc.md`) proved the reconcile is a
regression. `client.session.status()` reports a session as `idle` whenever the
model is **blocked waiting on a tool call** — `busy` only means "actively
generating tokens." So during any tool call longer than the 30s heartbeat, the
reconcile evicts the live session and **drops the wake lock during active work**:

```
12:26:40  holder 28621 held          (model generating — OK)
12:26:41  `sleep 35` dispatched       (model blocked on tool)
12:26:46  heartbeat → holderPid=null  (session EVICTED — lock dropped!)
12:26:46–12:27:16  ~30s with NO wake lock during active work
12:27:18  holder 28978 acquired       (sleep ended, model resumed → busy event)
12:27:46  idle → released             (turn end — OK)
```

Key insight: the `session.status` **events** are coarse (busy for the whole
turn, idle at turn-end — the holder correctly stayed held across multiple tool
calls in one turn). The `/session/status` **polling endpoint** is fine-grained
(idle between token generation). Gating keepalive on the polling endpoint is
unsound and a grace period can't fix it (tool calls are unbounded). Not
WSL2-specific.

## Success criteria

- [x] Heartbeat no longer calls `client.session.status()` and never evicts a
      live (busy-turn) session.
- [x] During a long tool call (> heartbeat interval) the holder persists across
      heartbeats; the lock is NOT dropped mid-turn.
- [x] Wake lock still releases at turn end (idle / session.idle / deleted /
      error events) and on dead-PID/orphan cleanup.
- [x] Holder that dies mid-turn is re-acquired on the next heartbeat (kept
      behavior — does not depend on polling).
- [x] `npm run typecheck` and `npm test` pass.

## Implementation plan

- [x] **`src/index.ts` — `onHeartbeat`:** remove the `client.session.status()`
      poll + reconcile filter. Keep `touchOwnSessions(data)` (prevents
      cross-process stale-reaping during long turns), then branch on
      `load().activeSessions.length`: non-empty → `await ensureHolder()` (re-acquires
      a dead holder), empty → `await releaseHolder()`. Both helpers already call
      `reapDead()` + `releaseOrphan()` internally. Keep `async` + the
      `setInterval(() => { onHeartbeat().catch(() => {}) }, HEARTBEAT_MS)` wrapper.
- [x] **`src/index.ts` — event handler:** add a `session.idle` case (distinct
      from `session.status` idle) mirroring the `session.deleted` handler:
      `removeSession(event.properties?.sessionID)` → `releaseHolder()` if empty.
      Idempotent, so receiving both idle signals is harmless.
- [x] **`test/heartbeat.test.ts`:** remove the `session: { status }` mock and
      `mockSessionStatus`; delete the three polling tests (idle-eviction,
      absent-from-map, SDK-failure fallback); drop the now-unneeded
      `mockSessionStatus.mockResolvedValue(...)` lines from the retained
      "refreshes lastSeen" and "re-acquires holder when holder dies" tests (both
      still pass). Add a test: a `session.idle` event removes the session and
      releases the holder.
- [x] **`AGENTS.md`:** rewrite the overview sentence (line 5) to the
      event-driven model — acquire on busy/retry; release on
      idle/session.idle/deleted/error; heartbeat reaps dead-PID/stale sessions,
      releases orphaned holders, and re-acquires a holder that died mid-turn.
      Remove the `session.status()` reconcile description.
- [x] **`.tasks/DONE-fix-keepalive-idle-leak.md`:** append a note that the
      reconcile was reverted (superseded by this task), pointing at the self-test
      finding.
- [x] Run `npm run typecheck && npm test` — confirm green.

## Verification (in opencode)

Re-run `.tasks/verify-keepalive-reconcile.md`, but the meaningful check is now:
during a single `sleep 40` tool call the `holderPid` + `powershell.exe`
**persist across the heartbeat** (the previous failure point), and the holder
releases at turn end. Optional: kill the holder mid-turn → heartbeat re-acquires
within ~30s.
