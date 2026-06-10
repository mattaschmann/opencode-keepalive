# AGENTS.md - opencode-keepalive

## Project Overview

OpenCode plugin that prevents the host machine from sleeping (system/disk sleep only, not display) while AI sessions are active. Uses SetThreadExecutionState on Windows/WSL2, caffeinate on macOS, systemd-inhibit on Linux. Cross-process reference counting via ~/.cache/opencode-keepalive/lock.json with heartbeat re-spawn of a detached holder process.

## Do

- Use TypeScript for all source files
- Use `@opencode-ai/plugin` for type definitions
- Keep `src/index.ts` as the main entry point; delegate to submodules
- Run `npm run typecheck` and `npm test` before presenting changes
- Fail quiet — log via `client.app.log`, fall back to stderr; never throw from event handlers
- Use `.js` extensions in all relative imports

## Don't

- Add heavy or unnecessary dependencies
- Use default exports for anything other than the main plugin
- Hardcode power plan restore values on Windows
- Make large speculative changes without confirming with the user

## Commands

- `npm run typecheck` - Type check (`tsc --noEmit`)
- `npm test` - Run Jest tests (ESM mode)
- `npm run format` - Format with Prettier

Note: No build step — plugin is shipped as TypeScript source, loaded directly by OpenCode via Bun.

## Project Structure

- `src/index.ts` - Main plugin entry (event hook, ref counting, heartbeat)
- `src/constants.ts` - Service name, cache directory/file constants
- `src/types.ts` - Platform, LockData, KeepaliveBackend types
- `src/platform.ts` - Platform detection (darwin/wsl2/linux/win32)
- `src/lock/store.ts` - Read/write/validate ~/.cache/opencode-keepalive/lock.json
- `src/keepalive/windows.ts` - SetThreadExecutionState via powershell.exe
- `src/keepalive/darwin.ts` - caffeinate backend
- `src/keepalive/linux.ts` - systemd-inhibit backend
- `test/` - Jest test suites

## Testing

- Jest tests use ESM mode with ts-jest
- Test lock store: round-trip, corrupt JSON recovery, type filtering, clear
- Test platform detection: mock node:os per test with resetModules
- Test ref counting: acquire/release transitions, dispose, idempotence
- Run `npm test` and `npm run typecheck` before submitting

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `OPENCODE_KEEPALIVE_CACHE_DIR` | `~/.cache/opencode-keepalive` | Override lock file directory (mainly for testing) |
