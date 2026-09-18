// opencode-keepalive — prevents host system/disk sleep (not display) while an
// OpenCode session is busy. V2 runs one persistent background service that owns
// all sessions, so state is a single in-process Set; the per-platform inhibitor
// watches this server process and self-terminates if it is killed (orphan
// guard). A Symbol.for singleton shares one handler across multiple plugin
// instances loaded into the same process.
import { Plugin } from "@opencode/plugin";
import { detectPlatform } from "./platform.js";
import { log } from "./log.js";
import { createWindowsBackend } from "./keepalive/windows.js";
import { createDarwinBackend } from "./keepalive/darwin.js";
import { createLinuxBackend } from "./keepalive/linux.js";
import type { KeepaliveBackend } from "./types.js";

const KEY = Symbol.for("opencode-keepalive");

interface SharedHandler {
  /** Route one server event into the wake-lock state machine. */
  handle(event: { type: string; data?: any }): Promise<void>;
  /** Attach a setup instance; returns its cleanup. Last cleanup releases. */
  attach(): () => Promise<void>;
}

function getBackend(): KeepaliveBackend | null {
  switch (detectPlatform()) {
    case "wsl2":
    case "win32":
      return createWindowsBackend();
    case "darwin":
      return createDarwinBackend();
    case "linux":
      return createLinuxBackend();
    default:
      return null;
  }
}

function createSharedHandler(): SharedHandler {
  const platform = detectPlatform();
  const backend = getBackend();

  if (!backend || !backend.supported()) {
    log("warn", `unsupported or unavailable platform: ${platform}`);
    let noopRefs = 0;
    return {
      async handle() {},
      attach() {
        noopRefs++;
        return async () => {
          noopRefs--;
        };
      },
    };
  }

  log("info", `plugin loaded, platform: ${platform}`);

  const be = backend;
  const busySessions = new Set<string>();
  let holderPid: number | null = null;
  let inflightOp: Promise<void> | null = null;
  let refs = 0;
  let exitHandlerInstalled = false;

  async function runExclusive(fn: () => Promise<void>): Promise<void> {
    if (inflightOp) await inflightOp;
    inflightOp = fn();
    try {
      await inflightOp;
    } finally {
      inflightOp = null;
    }
  }

  async function ensureHolder(): Promise<void> {
    return runExclusive(async () => {
      if (busySessions.size === 0) return;
      if (holderPid !== null) return;
      try {
        // Watch this server process; the inhibitor releases if we die.
        holderPid = await be.acquire(process.pid);
        log("info", "wake lock acquired", { pid: holderPid });
      } catch (e) {
        log("error", `failed to acquire wake lock: ${e}`);
      }
    });
  }

  async function releaseHolder(): Promise<void> {
    return runExclusive(async () => {
      if (busySessions.size > 0) return;
      if (holderPid === null) return;
      const pid = holderPid;
      await be.release(pid);
      holderPid = null;
      log("info", "wake lock released", { pid });
    });
  }

  function syncCleanup(): void {
    if (holderPid !== null) {
      try {
        process.kill(holderPid);
      } catch {
        /* dead */
      }
      holderPid = null;
    }
  }

  function installExitHandler(): void {
    if (exitHandlerInstalled) return;
    exitHandlerInstalled = true;
    process.on("exit", syncCleanup);
  }

  async function addSession(sessionID: string): Promise<void> {
    if (busySessions.has(sessionID)) return;
    const wasEmpty = busySessions.size === 0;
    busySessions.add(sessionID);
    if (wasEmpty) await ensureHolder();
  }

  async function removeSession(sessionID: string): Promise<void> {
    if (!busySessions.delete(sessionID)) return;
    if (busySessions.size === 0) await releaseHolder();
  }

  return {
    async handle(event) {
      // V2 (2.0.8) drives the busy lifecycle through session.execution.*, not
      // session.status (which is not emitted on the public stream). started =>
      // busy; succeeded/failed/interrupted => done.
      const sessionID: string | undefined = event.data?.sessionID;
      if (!sessionID) return;

      if (event.type === "session.execution.started") {
        await addSession(sessionID);
        return;
      }

      if (
        event.type === "session.execution.succeeded" ||
        event.type === "session.execution.failed" ||
        event.type === "session.execution.interrupted" ||
        event.type === "session.deleted"
      ) {
        await removeSession(sessionID);
      }
    },

    attach() {
      refs++;
      installExitHandler();
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        refs--;
        if (refs === 0) {
          busySessions.clear();
          await releaseHolder();
        }
      };
    },
  };
}

function getShared(): SharedHandler {
  const g = globalThis as any;
  if (!g[KEY]) g[KEY] = createSharedHandler();
  return g[KEY] as SharedHandler;
}

export default Plugin.define({
  id: "keepalive",
  setup(ctx) {
    const shared = getShared();
    const cleanupRef = shared.attach();
    const controller = new AbortController();

    void (async () => {
      for await (const event of ctx.event.subscribe({
        signal: controller.signal,
      })) {
        try {
          await shared.handle(event as { type: string; data?: any });
        } catch (e) {
          // A handler error must not kill the subscription for the rest of the
          // process lifetime.
          log("error", `event handler failed: ${e}`);
        }
      }
    })().catch(() => {
      /* subscription aborted on cleanup */
    });

    return async () => {
      controller.abort();
      await cleanupRef();
    };
  },
});
