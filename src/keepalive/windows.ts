import { spawn } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import type { KeepaliveBackend } from '../types.js'

const PS_SCRIPT = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class WakeLock {
    [DllImport("kernel32.dll")]
    public static extern uint SetThreadExecutionState(uint esFlags);
}
"@
# ES_CONTINUOUS (0x80000000) | ES_SYSTEM_REQUIRED (0x00000001)
[WakeLock]::SetThreadExecutionState(0x80000001) | Out-Null
while ($true) { Start-Sleep -Seconds 60 }
`

function findPowershell(): string | null {
  try {
    execFileSync('powershell.exe', ['-Command', 'echo ok'], {
      stdio: 'pipe',
      timeout: 5000,
    })
    return 'powershell.exe'
  } catch {
    return null
  }
}

export function createWindowsBackend(): KeepaliveBackend {
  const psPath = findPowershell()

  return {
    supported() {
      return psPath !== null
    },

    async acquire(): Promise<number> {
      if (!psPath) throw new Error('powershell.exe not found')
      const child = spawn(
        psPath,
        ['-NoProfile', '-NonInteractive', '-Command', PS_SCRIPT],
        {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        }
      )
      child.unref()
      if (!child.pid) throw new Error('failed to spawn powershell ES holder')
      return child.pid
    },

    async release(pid: number): Promise<void> {
      try {
        process.kill(pid)
      } catch {
        /* already dead — fine */
      }
    },
  }
}
