import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, openSync, closeSync, renameSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { CACHE } from '../constants.js'
import type { LockData, SessionEntry } from '../types.js'

const LOCK_STALE_MS = 5000
const LOCK_RETRY_MS = 20
const LOCK_MAX_RETRIES = 100

export function getLockPath(): string {
  const base = process.env.OPENCODE_KEEPALIVE_CACHE_DIR || join(homedir(), '.cache', CACHE.DIR)
  return join(base, CACHE.FILE)
}

function empty(): LockData {
  return { activeSessions: [], holderPid: null }
}

function isValidSchema(data: unknown): data is { activeSessions: unknown[]; holderPid: unknown } {
  if (!data || typeof data !== 'object') return false
  const d = data as Record<string, unknown>
  if (!Array.isArray(d.activeSessions)) return false
  if (d.activeSessions.length > 0 && typeof d.activeSessions[0] === 'string') return false
  return true
}

function parseEntry(raw: unknown): SessionEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const e = raw as Record<string, unknown>
  if (typeof e.id !== 'string' || typeof e.pid !== 'number') return null
  return { id: e.id, pid: e.pid }
}

export function load(): LockData {
  try {
    const filePath = getLockPath()
    if (!existsSync(filePath)) return empty()
    const raw = readFileSync(filePath, 'utf8')
    const data = JSON.parse(raw)
    if (!isValidSchema(data)) return empty()
    return {
      activeSessions: data.activeSessions
        .map(parseEntry)
        .filter((e): e is SessionEntry => e !== null),
      holderPid: typeof data.holderPid === 'number' ? data.holderPid : null,
    }
  } catch {
    return empty()
  }
}

export function persist(data: LockData): void {
  try {
    const filePath = getLockPath()
    const dir = dirname(filePath)
    mkdirSync(dir, { recursive: true })
    const tmpPath = filePath + '.tmp'
    writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n', 'utf8')
    renameSync(tmpPath, filePath)
  } catch (e) {
    process.stderr.write(`${CACHE.DIR}: failed to persist lock: ${e}\n`)
  }
}

function acquireFsLock(lockFilePath: string): void {
  const sentinelPath = lockFilePath + '.lock'
  const dir = dirname(sentinelPath)
  mkdirSync(dir, { recursive: true })

  for (let i = 0; i < LOCK_MAX_RETRIES; i++) {
    try {
      const fd = openSync(sentinelPath, 'wx')
      closeSync(fd)
      return
    } catch (e: any) {
      if (e.code !== 'EEXIST') throw e
      try {
        const st = statSync(sentinelPath)
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          unlinkSync(sentinelPath)
          continue
        }
      } catch { /* sentinel gone, retry */ }
      const jitter = Math.random() * LOCK_RETRY_MS
      const start = Date.now()
      while (Date.now() - start < LOCK_RETRY_MS + jitter) { /* spin */ }
    }
  }
  try { unlinkSync(sentinelPath) } catch { /* best effort steal */ }
  const fd = openSync(sentinelPath, 'wx')
  closeSync(fd)
}

function releaseFsLock(lockFilePath: string): void {
  try {
    unlinkSync(lockFilePath + '.lock')
  } catch { /* already gone */ }
}

export function update(fn: (data: LockData) => void): LockData {
  const lockFilePath = getLockPath()
  acquireFsLock(lockFilePath)
  try {
    const data = load()
    fn(data)
    persist(data)
    return data
  } finally {
    releaseFsLock(lockFilePath)
  }
}

export function clear(): void {
  try {
    const filePath = getLockPath()
    if (existsSync(filePath)) unlinkSync(filePath)
  } catch {
    /* ignore */
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
