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
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
    },
  };
}

function setupMocks() {
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
}

const busy = (sessionID: string) => ({
  type: "session.execution.started",
  data: { sessionID },
});

async function loadTwoInstances() {
  const { default: plugin } = await import("../src/index.js");
  const s1 = makeEventStream();
  const s2 = makeEventStream();
  const c1 = (await plugin.setup({
    event: { subscribe: s1.subscribe },
  } as any)) as () => Promise<void>;
  const c2 = (await plugin.setup({
    event: { subscribe: s2.subscribe },
  } as any)) as () => Promise<void>;
  return { emit1: s1.emit, emit2: s2.emit, c1, c2 };
}

describe("shared handler across duplicate setup() calls", () => {
  it("events from either instance reach the shared handler", async () => {
    setupMocks();
    const { emit1, emit2 } = await loadTwoInstances();

    await emit1(busy("a"));
    expect(mockAcquire).toHaveBeenCalledTimes(1);

    await emit2(busy("b"));
    expect(mockAcquire).toHaveBeenCalledTimes(1);
  });

  it("duplicate busy events through different instances are deduplicated", async () => {
    setupMocks();
    const { emit1, emit2 } = await loadTwoInstances();

    await emit1(busy("same"));
    await emit2(busy("same"));
    expect(mockAcquire).toHaveBeenCalledTimes(1);
  });

  it("cleanup releases only when the last instance detaches", async () => {
    setupMocks();
    const { emit1, c1, c2 } = await loadTwoInstances();

    await emit1(busy("x"));
    expect(mockAcquire).toHaveBeenCalledTimes(1);

    await c1();
    expect(mockRelease).not.toHaveBeenCalled();

    await c2();
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });
});
