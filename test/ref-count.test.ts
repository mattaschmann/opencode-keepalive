import { jest } from "@jest/globals";

let mockAcquire: jest.Mock<any>;
let mockRelease: jest.Mock<any>;
let mockSupported: jest.Mock<any>;

beforeEach(() => {
  mockAcquire = jest.fn<any>().mockResolvedValue(process.pid);
  mockRelease = jest.fn<any>().mockResolvedValue(undefined);
  mockSupported = jest.fn<any>().mockReturnValue(true);
  jest.resetModules();
  const g = globalThis as any;
  delete g[Symbol.for("opencode-keepalive")];
});

/**
 * A push-driven async iterable standing in for `ctx.event.subscribe`. The test
 * drives events with `emit`; the setup loop awaits each `handle` before the
 * next `emit` resolves, so assertions can run between events.
 */
function makeEventStream() {
  const queue: any[] = [];
  let resolveNext: ((v: IteratorResult<any>) => void) | null = null;
  let done = false;

  const iterator: AsyncIterator<any> = {
    next() {
      if (queue.length > 0)
        return Promise.resolve({ value: queue.shift(), done: false });
      if (done) return Promise.resolve({ value: undefined, done: true });
      return new Promise((resolve) => {
        resolveNext = resolve;
      });
    },
  };

  return {
    subscribe: (_opts?: any): AsyncIterable<any> => ({
      [Symbol.asyncIterator]: () => iterator,
    }),
    async emit(event: any) {
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r({ value: event, done: false });
      } else {
        queue.push(event);
      }
      // Let the setup loop's handle() run to completion.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
    },
  };
}

async function loadPlugin() {
  jest.unstable_mockModule("../src/keepalive/windows.js", () => ({
    createWindowsBackend: () => ({
      acquire: (...args: any[]) => mockAcquire(...args),
      release: (...args: any[]) => mockRelease(...args),
      supported: (...args: any[]) => mockSupported(...args),
    }),
  }));
  jest.unstable_mockModule("../src/keepalive/darwin.js", () => ({
    createDarwinBackend: () => ({
      acquire: (...args: any[]) => mockAcquire(...args),
      release: (...args: any[]) => mockRelease(...args),
      supported: (...args: any[]) => mockSupported(...args),
    }),
  }));
  jest.unstable_mockModule("../src/keepalive/linux.js", () => ({
    createLinuxBackend: () => ({
      acquire: (...args: any[]) => mockAcquire(...args),
      release: (...args: any[]) => mockRelease(...args),
      supported: (...args: any[]) => mockSupported(...args),
    }),
  }));
  jest.unstable_mockModule("../src/platform.js", () => ({
    detectPlatform: () => "darwin",
  }));

  const { default: plugin } = await import("../src/index.js");
  const stream = makeEventStream();
  const cleanup = await plugin.setup({
    event: { subscribe: stream.subscribe },
  } as any);
  return { emit: stream.emit, cleanup: cleanup as () => Promise<void> };
}

const busy = (sessionID: string) => ({
  type: "session.execution.started",
  data: { sessionID },
});
const done = (sessionID: string) => ({
  type: "session.execution.succeeded",
  data: { sessionID },
});

describe("ref counting", () => {
  it("acquires on first busy session, releases when last finishes", async () => {
    const { emit } = await loadPlugin();

    await emit(busy("a"));
    expect(mockAcquire).toHaveBeenCalledTimes(1);

    await emit(busy("b"));
    expect(mockAcquire).toHaveBeenCalledTimes(1);

    await emit(done("a"));
    expect(mockRelease).not.toHaveBeenCalled();

    await emit(done("b"));
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it("acquires with the server pid as the watch pid", async () => {
    const { emit } = await loadPlugin();
    await emit(busy("a"));
    expect(mockAcquire).toHaveBeenCalledWith(process.pid);
  });

  it("removes session on session.deleted", async () => {
    const { emit } = await loadPlugin();
    await emit(busy("x"));
    await emit({ type: "session.deleted", data: { sessionID: "x" } });
    expect(mockRelease).toHaveBeenCalled();
  });

  it("removes session on session.execution.failed", async () => {
    const { emit } = await loadPlugin();
    await emit(busy("y"));
    await emit({
      type: "session.execution.failed",
      data: { sessionID: "y", error: { name: "x" } },
    });
    expect(mockRelease).toHaveBeenCalled();
  });

  it("removes session on session.execution.interrupted", async () => {
    const { emit } = await loadPlugin();
    await emit(busy("i"));
    await emit({
      type: "session.execution.interrupted",
      data: { sessionID: "i", reason: "user" },
    });
    expect(mockRelease).toHaveBeenCalled();
  });

  it("cleanup releases and clears sessions", async () => {
    const { emit, cleanup } = await loadPlugin();
    await emit(busy("z"));
    await cleanup();
    expect(mockRelease).toHaveBeenCalled();
  });

  it("does not acquire twice for duplicate busy events", async () => {
    const { emit } = await loadPlugin();
    await emit(busy("a"));
    await emit(busy("a"));
    expect(mockAcquire).toHaveBeenCalledTimes(1);
  });

  it("does not release if session was not tracked", async () => {
    const { emit } = await loadPlugin();
    await emit(done("ghost"));
    expect(mockRelease).not.toHaveBeenCalled();
  });
});
