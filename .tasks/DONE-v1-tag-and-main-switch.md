# Tag V1 baseline and switch `main` to V2

Difficulty: 2.0

The V2 port lives on `v2` (`5a6fa7f`) and is the deployed branch — dotfiles
`opencode.jsonc` loads the repo directory, which sits on `v2`. `main`
(`feb62ca`) is still the V1 implementation, kept as a rollback path while
OpenCode 2 settles.

The V1 branch is more than a stylistic fallback here: it is the last version
carrying the cross-process file lock (`src/lock/store.ts`) and its three test
files, all deleted in the V2 rewrite in favour of in-process session tracking.
If V2's persistent-service assumption ever proves wrong, that code is only
recoverable from `main`.

## Decisions

- **Tag `main`'s tip as the last V1-compatible commit.** *Why:* once `main`
  fast-forwards to `v2`, the V1 implementation — including the deleted
  cross-process lock — is only addressable by raw SHA.
- **Switch `main` to V2 now and delete `v2` (2026-11-09, supersedes the
  deferral below).** *Why:* OpenCode 2.2.6 is past the 2.0.x churn; the
  `v1-final` tag is the rollback path. Skip the temporary README branch note;
  instead update the tested-on version (`README.md` lines 9 and 59) to 2.2.6
  after the live check passes.
- **Leave the six open Dependabot PRs (#2-#7, base `main`) alone.** *Why:*
  Dependabot rebases on base change; any `gh` state change needs per-use approval.
- ~~**Defer the `main` switch; keep `v2` deployed.**~~ *Why:* the V2 plugin API may
  still shift in 2.0.x, and this is the most lifecycle-entangled of the ports
  (detached subprocesses, singleton, cleanup contract). Holding `main` at V1
  preserves a one-command rollback that costs nothing.
- **Annotated tag, not lightweight.** *Why:* carries a date and a message
  recording what V1 means here (OpenCode <= 1.18.31, `@opencode-ai/plugin`,
  cross-process file lock).

## Implementation Plan

_Superseded by the 2026-11-09 plan below._

- [ ] Tag `main` @ `feb62ca`: `git tag -a v1-final feb62ca -m "Last OpenCode V1
      (@opencode-ai/plugin) compatible release; retains cross-process file lock"`;
      push with `git push origin v1-final`.
- [ ] Note the tag in `README.md` — one line mapping branch to OpenCode major.
- [ ] Later, when V2 is settled: `git checkout main && git merge --ff-only v2 &&
      git push origin main`, then delete `v2` local + remote.
- [ ] After the switch, drop the branch note from `README.md` and confirm
      `opencode plugin list` still shows `keepalive`, plus one live
      acquire/release check via `pmset -g assertions`.

## Implementation Plan (2026-11-09)

- [x] Tag: `git tag -a v1-final feb62ca -m "Last OpenCode V1 (@opencode-ai/plugin) compatible release; retains cross-process file lock"`, then `git push origin v1-final`.
  - 2026-11-09: done — annotated v1-final at feb62ca pushed to origin
- [x] Run `npm run typecheck` and `npm test` on `v2`.
  - 2026-11-09: done — typecheck clean, 25/25 tests pass
- [x] Live check on OpenCode 2.2.6: `opencode plugin list` shows `keepalive`; `pmset -g assertions` shows the assertion during a session and clears after it finishes.
  - 2026-11-09: partial — plugin listed; `caffeinate` assertion (PreventUserIdleSystemSleep + PreventDiskIdle) held for the busy `opencode serve --service` (pid 3602). 
  - 2026-11-09: done — sampled pmset: lock released at 11:01:12 once sessions idled, re-acquired 11:01:18 (`caffeinate -i -m -w <server pid>`); old server's caffeinate gone after restart
- [x] Update the OpenCode version in `README.md` (lines 9 and 59) to 2.2.6 and commit on `v2`.
  - 2026-11-09: done — README lines 9, 59 -> 2.2.6, commit 1dcd69a
- [x] `git checkout main && git merge --ff-only v2 && git push origin main`.
  - 2026-11-09: done — main ff to 1dcd69a (via fetch . v2:main), pushed
- [x] `git branch -d v2 && git push origin --delete v2`; confirm the deployed checkout is on `main`.
  - 2026-11-09: done — v2 deleted local + remote; checkout is on main
- [x] Update `.tasks/DASHBOARD.md` to reflect completion state.
  - 2026-11-09: done — State set to ready to wrap

## Checkpoint

**Goal:** Tag V1 as `v1-final`, switch `main` to V2, delete `v2`.
**Key decisions:** switch now; `v1-final` is the rollback; Dependabot PRs untouched.
**Done:** all 7 plan items.
**Next:** Run wrap-task
**Blockers:** none
**Criteria:** none
**Key files:** `README.md`, `.tasks/DASHBOARD.md`

## Wrap notes (2026-11-09)

- Review found new high vulns via `@opencode/plugin@2.0.8` (`zod` <4.6.6, `undici`); fixed inline by pinning `@opencode/plugin` to 2.2.6. Audit now shows no new high/critical; remaining (`handlebars` critical, `brace-expansion`, `browserslist`, `js-yaml`) are pre-existing dev deps covered by open Dependabot PRs.
- `AGENTS.md` version note updated to 2.2.6. Typecheck clean, 25/25 tests pass, gitleaks clean.
