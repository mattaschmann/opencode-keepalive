export type Platform = 'darwin' | 'wsl2' | 'linux' | 'win32'

export interface LockData {
  activeSessions: string[]
  holderPid: number | null
}

export interface KeepaliveBackend {
  acquire(): Promise<number>
  release(pid: number): Promise<void>
  supported(): boolean
}
