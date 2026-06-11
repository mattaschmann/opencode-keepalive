import { execFileSync } from 'node:child_process'
import { killPid, spawnDetached } from './shared.js'
import type { KeepaliveBackend } from '../types.js'

function hasSystemdInhibit(): boolean {
  try {
    execFileSync('systemd-inhibit', ['--version'], { stdio: 'pipe', timeout: 3000 })
    return true
  } catch {
    return false
  }
}

export function createLinuxBackend(): KeepaliveBackend {
  const hasInhibit = hasSystemdInhibit()

  return {
    supported() {
      return hasInhibit
    },

    async acquire(): Promise<number> {
      if (!hasInhibit) throw new Error('systemd-inhibit not available')
      return spawnDetached(
        'systemd-inhibit',
        ['--what=idle:sleep', '--why=opencode AI job', 'sleep', 'infinity'],
      )
    },

    async release(pid: number): Promise<void> {
      killPid(pid)
    },
  }
}
