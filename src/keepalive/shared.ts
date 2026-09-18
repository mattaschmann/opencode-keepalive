import { spawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";

export function killPid(pid: number): void {
  try {
    process.kill(pid);
  } catch {
    /* already dead */
  }
}

export interface SpawnResult {
  pid: number;
  child: ChildProcess;
}

/**
 * Spawn a detached inhibitor. `stdin: 'pipe'` keeps a parent-held write end
 * open so the child sees EOF (and exits) when this process dies — the
 * cross-boundary orphan guard used by the Linux/Windows backends. `stdin:
 * 'ignore'` is used when the child self-terminates by other means (e.g.
 * `caffeinate -w`).
 */
export function spawnDetached(
  cmd: string,
  args: string[],
  opts: { stdin?: "ignore" | "pipe" } & SpawnOptions = {},
): SpawnResult {
  const { stdin = "ignore", ...extraOpts } = opts;
  const child = spawn(cmd, args, {
    detached: true,
    stdio: [stdin, "ignore", "ignore"],
    ...extraOpts,
  });
  // Detach from the event loop, but when stdin is a pipe keep the write end
  // referenced so its EOF-on-exit semantics survive; unref only the process.
  child.unref();
  if (!child.pid) throw new Error(`failed to spawn ${cmd}`);
  return { pid: child.pid, child };
}
