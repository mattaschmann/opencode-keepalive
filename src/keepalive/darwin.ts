import { execFileSync } from 'node:child_process'
import { killPid, spawnDetached } from './shared.js'
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
      return spawnDetached('caffeinate', ['-im'])
    },

    async release(pid: number): Promise<void> {
      killPid(pid)
    },
  }
}
