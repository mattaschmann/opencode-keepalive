import { execFileSync } from "node:child_process";
import { killPid, spawnDetached } from "./shared.js";
import type { KeepaliveBackend } from "../types.js";

function hasCaffeinate(): boolean {
  try {
    execFileSync("caffeinate", ["-h"], { stdio: "pipe", timeout: 3000 });
    return true;
  } catch (e: any) {
    if (e?.status !== null && e?.status !== undefined) return true;
    return false;
  }
}

export function createDarwinBackend(): KeepaliveBackend {
  const available = hasCaffeinate();

  return {
    supported() {
      return available;
    },

    async acquire(watchPid: number): Promise<number> {
      if (!available) throw new Error("caffeinate not found");
      // -i prevent idle sleep, -m prevent disk sleep, -w watch the server pid:
      // the assertion is released automatically when it exits, so a SIGKILLed
      // server cannot orphan the inhibitor.
      return spawnDetached("caffeinate", ["-i", "-m", "-w", String(watchPid)])
        .pid;
    },

    async release(pid: number): Promise<void> {
      killPid(pid);
    },
  };
}
