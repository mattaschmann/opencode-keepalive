# verify-keepalive-reconcile

Run this inside the opencode session whose keepalive you want to verify. While
opencode's agent executes these steps its session status is `busy`, so the wake
lock must be held — that makes the test self-verifying. The final step captures
the release that happens when the turn goes `idle`.

## Facts
- Lock file: `~/.cache/opencode-keepalive/lock.json` — `{ activeSessions, holderPid }`
- Wake-lock holder on WSL2: a detached `powershell.exe` process
- Heartbeat interval: 30s default (`OPENCODE_KEEPALIVE_HEARTBEAT_MS`)
- Behavior under test: event-driven release (revert of commit `227a4db`). The
  heartbeat must NOT poll `client.session.status()` and must NOT evict a live
  (busy-turn) session. It still reaps dead-PID/stale sessions, releases orphaned
  holders, and re-acquires a holder that died mid-turn.

## Pass criteria
- [x] Step 1: `holderPid` is set and `activeSessions` non-empty while busy
- [x] Step 2: during a single long tool call (> heartbeat) the SAME `holderPid`
      and `powershell.exe` persist across the heartbeat — lock NOT dropped (this
      is the regression that `227a4db` introduced and the revert fixes)
- [x] Step 3 (optional): killing the holder mid-turn → heartbeat re-acquires a
      fresh holder within ~30s
- [x] Step 4: watcher log shows holder released (null / no powershell) after idle

---

## Steps

### Step 0 — Launch the watcher first
Records lock state for ~90s so it captures both the mid-turn persistence and the
release after this turn ends:

```bash
nohup bash -c '
  log=/tmp/keepalive-verify.log
  echo "=== watcher start $(date +%T) ===" > "$log"
  for i in $(seq 1 45); do
    h=$(grep -o "\"holderPid\": [0-9null]*" ~/.cache/opencode-keepalive/lock.json 2>/dev/null)
    ps=$(pgrep -c powershell.exe 2>/dev/null || echo 0)
    echo "$(date +%T) $h powershell=$ps" >> "$log"
    sleep 2
  done
  echo "=== watcher end $(date +%T) ===" >> "$log"
' >/dev/null 2>&1 &
echo "watcher launched"
```

### Step 1 — Confirm busy holds the lock
```bash
cat ~/.cache/opencode-keepalive/lock.json
pgrep -af powershell.exe | grep -v pgrep
```
Expect: `holderPid` a number, `activeSessions` non-empty, ≥1 `powershell.exe`.
Empty/null here means the keepalive is NOT acquiring during busy → fail.

### Step 2 — Verify a long tool call does NOT drop the lock (the key check)
A single tool call longer than the heartbeat must keep the holder. This is the
exact scenario `227a4db` broke (the poll reported `idle` while blocked on the
tool and evicted the session).
```bash
before=$(grep -o '[0-9]\+' <<<"$(grep holderPid ~/.cache/opencode-keepalive/lock.json)")
echo "holder before long call: $before"
echo "blocking on one 40s tool call (crosses a 30s heartbeat)..."; sleep 40
after=$(grep -o '[0-9]\+' <<<"$(grep holderPid ~/.cache/opencode-keepalive/lock.json)")
echo "holder after: $after"; cat ~/.cache/opencode-keepalive/lock.json
pgrep -af powershell.exe | grep -v pgrep
```
Expect: `after` == `before` (same PID, never evicted) and `powershell.exe` still
running throughout. A `null` holder or a changed PID mid-call → regression, fail.

### Step 3 — (optional) Verify heartbeat re-acquires a dead holder
```bash
old=$(grep -o '[0-9]\+' <<<"$(grep holderPid ~/.cache/opencode-keepalive/lock.json)")
echo "killing holder $old"; kill "$old" 2>/dev/null
sleep 1; echo "after kill:"; pgrep -af powershell.exe | grep -v pgrep || echo "(holder gone)"
echo "staying busy 35s to cross a heartbeat..."; sleep 35
echo "after heartbeat:"; cat ~/.cache/opencode-keepalive/lock.json
pgrep -af powershell.exe | grep -v pgrep
```
Expect: after the wait, `holderPid` is a number **different from `$old`** and a
fresh `powershell.exe` is running — `ensureHolder()` re-acquired while busy.

### Step 4 — End the turn, then read the watcher log
Finish the response so the session goes `idle`. A few seconds later, read:
```bash
cat /tmp/keepalive-verify.log
```
Expect: `holderPid` set + `powershell=1` continuously through the busy period
(including across the Step 2 long call), then `"holderPid": null` +
`powershell=0` shortly after idle — lock released only at turn end.
