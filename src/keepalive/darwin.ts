import { spawn, execFileSync } from 'node:child_process'
import type { KeepaliveBackend } from '../types.js'

function hasCaffeinate(): boolean {
  try {
    execFileSync('caffeinate', ['-h'], { stdio: 'pipe', timeout: 3000 })
    return true
  } catch (e: any) {
    if (e?.status !== null && e?.status !== undefined) return true
    return false
  }
}

export function createDarwinBackend(): KeepaliveBackend {
  const available = hasCaffeinate()

  return {
    supported() {
      return available
    },

    async acquire(): Promise<number> {
      if (!available) throw new Error('caffeinate not found')
      const child = spawn('caffeinate', ['-im'], {
        detached: true,
        stdio: 'ignore',
      })
      child.unref()
      if (!child.pid) throw new Error('failed to spawn caffeinate')
      return child.pid
    },

    async release(pid: number): Promise<void> {
      try {
        process.kill(pid)
      } catch {
        /* already dead */
      }
    },
  }
}
