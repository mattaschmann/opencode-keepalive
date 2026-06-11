import { execFileSync } from 'node:child_process'
import { killPid, spawnDetached } from './shared.js'
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
      return spawnDetached(
        psPath,
        ['-NoProfile', '-NonInteractive', '-Command', PS_SCRIPT],
        { windowsHide: true },
      )
    },

    async release(pid: number): Promise<void> {
      killPid(pid)
    },
  }
}
