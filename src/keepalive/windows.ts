import { execFileSync } from "node:child_process";
import { killPid, spawnDetached } from "./shared.js";
import type { KeepaliveBackend } from "../types.js";

// SetThreadExecutionState holds the assertion for as long as this PowerShell
// process runs. Instead of an infinite loop, block on stdin until EOF: the
// parent (this process) holds the write end, so when the server dies the pipe
// closes, [Console]::In.ReadToEnd() returns, and the assertion is dropped. A
// piped stdin closes across the WSL2 → Windows boundary even though a Linux pid
// is invisible to a Windows `Get-Process`, so this works for WSL2 too.
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
[void][Console]::In.ReadToEnd()
`;

function findPowershell(): string | null {
  try {
    execFileSync("powershell.exe", ["-Command", "echo ok"], {
      stdio: "pipe",
      timeout: 5000,
    });
    return "powershell.exe";
  } catch {
    return null;
  }
}

export function createWindowsBackend(): KeepaliveBackend {
  const psPath = findPowershell();

  return {
    supported() {
      return psPath !== null;
    },

    async acquire(_watchPid: number): Promise<number> {
      if (!psPath) throw new Error("powershell.exe not found");
      return spawnDetached(
        psPath,
        ["-NoProfile", "-NonInteractive", "-Command", PS_SCRIPT],
        { stdin: "pipe", windowsHide: true },
      ).pid;
    },

    async release(pid: number): Promise<void> {
      killPid(pid);
    },
  };
}
