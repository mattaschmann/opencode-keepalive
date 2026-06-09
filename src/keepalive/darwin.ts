import { spawn } from 'node:child_process'
import type { KeepaliveBackend } from '../types.js'

export function createDarwinBackend(): KeepaliveBackend {
  return {
    supported() {
      return true
    },

    async acquire(): Promise<number> {
      const child = spawn('caffeinate', ['-dim'], {
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
