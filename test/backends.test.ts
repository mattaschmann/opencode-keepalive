import { jest } from "@jest/globals";

let mockSpawn: jest.Mock<any>;
let mockExecFileSync: jest.Mock<any>;

beforeEach(() => {
  jest.resetModules();
  mockSpawn = jest.fn<any>().mockReturnValue({ pid: 12345, unref: jest.fn() });
  mockExecFileSync = jest.fn<any>().mockReturnValue(Buffer.from(""));
});

function mockChildProcess() {
  jest.unstable_mockModule("node:child_process", () => ({
    spawn: (...args: any[]) => mockSpawn(...args),
    execFileSync: (...args: any[]) => mockExecFileSync(...args),
  }));
}

describe("linux backend", () => {
  it("acquire() spawns systemd-inhibit with a piped stdin for EOF release", async () => {
    mockChildProcess();
    const { createLinuxBackend } = await import("../src/keepalive/linux.js");
    const backend = createLinuxBackend();

    const pid = await backend.acquire(9999);
    expect(pid).toBe(12345);
    expect(mockSpawn).toHaveBeenCalledWith(
      "systemd-inhibit",
      [
        "--what=idle:sleep",
        "--why=opencode AI job",
        "sh",
        "-c",
        "cat >/dev/null",
      ],
      expect.objectContaining({
        detached: true,
        stdio: ["pipe", "ignore", "ignore"],
      }),
    );
  });

  it("acquire() throws when systemd-inhibit is unavailable", async () => {
    mockExecFileSync = jest.fn<any>().mockImplementation(() => {
      throw new Error("ENOENT");
    });
    mockChildProcess();
    const { createLinuxBackend } = await import("../src/keepalive/linux.js");
    const backend = createLinuxBackend();
    expect(backend.supported()).toBe(false);
    await expect(backend.acquire(9999)).rejects.toThrow(
      "systemd-inhibit not available",
    );
  });
});

describe("windows backend", () => {
  it("acquire() spawns powershell with a piped stdin and hidden window", async () => {
    mockChildProcess();
    const { createWindowsBackend } =
      await import("../src/keepalive/windows.js");
    const backend = createWindowsBackend();

    const pid = await backend.acquire(9999);
    expect(pid).toBe(12345);
    const [cmd, args, opts] = mockSpawn.mock.calls[0] as [
      string,
      string[],
      any,
    ];
    expect(cmd).toBe("powershell.exe");
    expect(args.slice(0, 3)).toEqual([
      "-NoProfile",
      "-NonInteractive",
      "-Command",
    ]);
    expect(args[3]).toContain("SetThreadExecutionState");
    expect(args[3]).toContain("ReadToEnd");
    expect(opts).toMatchObject({
      detached: true,
      stdio: ["pipe", "ignore", "ignore"],
      windowsHide: true,
    });
  });
});
