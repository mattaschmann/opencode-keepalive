import { spawn } from 'node:child_process'
import type { SpawnOptions } from 'node:child_process'

export function killPid(pid: number): void {
  try {
    process.kill(pid)
  } catch { /* already dead */ }
}

export function spawnDetached(cmd: string, args: string[], extraOpts: SpawnOptions = {}): number {
  const child = spawn(cmd, args, {
    detached: true,
    stdio: 'ignore',
    ...extraOpts,
  })
  child.unref()
  if (!child.pid) throw new Error(`failed to spawn ${cmd}`)
  return child.pid
}
