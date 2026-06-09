import { spawn, execFileSync } from 'node:child_process'
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
      const child = spawn(
        'systemd-inhibit',
        ['--what=idle:sleep', '--why=opencode AI job', 'sleep', 'infinity'],
        { detached: true, stdio: 'ignore' }
      )
      child.unref()
      if (!child.pid) throw new Error('failed to spawn systemd-inhibit')
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
