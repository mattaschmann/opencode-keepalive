import { execFileSync } from "node:child_process";
import { killPid, spawnDetached } from "./shared.js";
import type { KeepaliveBackend } from "../types.js";

function hasSystemdInhibit(): boolean {
  try {
    execFileSync("systemd-inhibit", ["--version"], {
      stdio: "pipe",
      timeout: 3000,
    });
    return true;
  } catch {
    return false;
  }
}

export function createLinuxBackend(): KeepaliveBackend {
  const hasInhibit = hasSystemdInhibit();

  return {
    supported() {
      return hasInhibit;
    },

    async acquire(_watchPid: number): Promise<number> {
      if (!hasInhibit) throw new Error("systemd-inhibit not available");
      // The inhibited utility blocks reading stdin until EOF. We keep the write
      // end of the pipe in this process, so when the server dies the pipe
      // closes, `cat` sees EOF, the utility exits, and systemd-inhibit drops the
      // lock. This is more robust than watching a pid and works uniformly.
      return spawnDetached(
        "systemd-inhibit",
        [
          "--what=idle:sleep",
          "--why=opencode AI job",
          "sh",
          "-c",
          "cat >/dev/null",
        ],
        { stdin: "pipe" },
      ).pid;
    },

    async release(pid: number): Promise<void> {
      killPid(pid);
    },
  };
}
