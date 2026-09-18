export type Platform = "darwin" | "wsl2" | "linux" | "win32";

export interface KeepaliveBackend {
  /**
   * Start the inhibitor. The inhibitor watches `watchPid` (the OpenCode server
   * process) and self-terminates when it exits, so a SIGKILLed server cannot
   * leave an orphaned assertion holding the host awake forever.
   */
  acquire(watchPid: number): Promise<number>;
  release(pid: number): Promise<void>;
  supported(): boolean;
}
