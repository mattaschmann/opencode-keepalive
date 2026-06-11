export type Platform = 'darwin' | 'wsl2' | 'linux' | 'win32'

export interface SessionEntry {
  id: string
  pid: number
  lastSeen: number
}

export interface LockData {
  activeSessions: SessionEntry[]
  holderPid: number | null
}

export interface KeepaliveBackend {
  acquire(): Promise<number>
  release(pid: number): Promise<void>
  supported(): boolean
}
