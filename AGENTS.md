# AGENTS.md - opencode-keepalive

## Project Overview

OpenCode **V2** plugin that prevents the host machine from sleeping (system/disk sleep only, not display) while AI sessions are busy. Uses SetThreadExecutionState on Windows/WSL2, caffeinate on macOS, systemd-inhibit on Linux. State is a single in-process `Set` of busy session IDs (V2 runs one persistent background service that owns all sessions, so no cross-process file lock is needed). Acquires the wake lock on the first `session.execution.started`; releases when the last session finishes via `session.execution.succeeded` / `.failed` / `.interrupted` (or `session.deleted`). NOTE: V2 2.0.8 does **not** emit `session.status`/`session.idle` on the public stream — `session.execution.*` is the busy signal. The inhibitor watches this server process and self-terminates if it is killed — `caffeinate -w <pid>` on macOS, a parent-held stdin pipe (EOF on server death) on Linux/Windows — so a SIGKILLed server cannot orphan the assertion. A `Symbol.for('opencode-keepalive')` singleton shares one handler across duplicate plugin instances in the same process.

## Do

- Use TypeScript for all source files
- Use `@opencode/plugin` (V2) for type definitions; export `Plugin.define({ id, setup })`
- Keep `src/index.ts` as the main entry point; delegate to submodules
- Run `npm run typecheck` and `npm test` before presenting changes
- Fail quiet — log via `src/log.ts` (stderr); never throw from the event loop or cleanup
- Use `.js` extensions in all relative imports

## Don't

- Add heavy or unnecessary dependencies
- Use default exports for anything other than the main plugin
- Hardcode power plan restore values on Windows
- Reintroduce a cross-process file lock or polling heartbeat — the inhibitor's PID/stdin watch is the orphan guard
- Make large speculative changes without confirming with the user

## Commands

- `npm run typecheck` - Type check (`tsc --noEmit`)
- `npm test` - Run Jest tests (ESM mode)
- `npm run format` - Format with Prettier

Note: No build step — plugin is shipped as TypeScript source, loaded directly by OpenCode via Bun.

## Project Structure

- `src/index.ts` - Main plugin entry (`Plugin.define`, event subscription, in-process session set, acquire/release)
- `src/constants.ts` - Service name
- `src/log.ts` - Single logging seam (stderr)
- `src/types.ts` - Platform, KeepaliveBackend types
- `src/platform.ts` - Platform detection (darwin/wsl2/linux/win32)
- `src/keepalive/shared.ts` - Shared helpers (killPid, spawnDetached w/ optional piped stdin)
- `src/keepalive/windows.ts` - SetThreadExecutionState via powershell.exe (stdin-EOF release)
- `src/keepalive/darwin.ts` - caffeinate backend (`-i -m -w <pid>`)
- `src/keepalive/linux.ts` - systemd-inhibit backend (stdin-EOF release)
- `test/` - Jest test suites

## Testing

- Jest tests use ESM mode with ts-jest
- Test ref counting: acquire/release transitions, cleanup, multi-instance dedup (feed `session.execution.*` events through a fake `ctx.event.subscribe`)
- Test backends: assert argv + piped-stdin/watch-pid per platform (`darwin.test.ts`, `backends.test.ts`)
- Test platform detection: mock node:os per test with resetModules
- Run `npm test` and `npm run typecheck` before submitting
