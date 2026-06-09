import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { CACHE } from '../constants.js'
import type { LockData } from '../types.js'

export function getLockPath(): string {
  const base = process.env.OPENCODE_KEEPALIVE_CACHE_DIR || join(homedir(), '.cache', CACHE.DIR)
  return join(base, CACHE.FILE)
}

function empty(): LockData {
  return { activeSessions: [], holderPid: null }
}

export function load(): LockData {
  try {
    const filePath = getLockPath()
    if (!existsSync(filePath)) return empty()
    const raw = readFileSync(filePath, 'utf8')
    const data = JSON.parse(raw)
    if (
      !data ||
      typeof data !== 'object' ||
      !Array.isArray(data.activeSessions)
    ) {
      return empty()
    }
    return {
      activeSessions: data.activeSessions.filter(
        (s: unknown) => typeof s === 'string'
      ),
      holderPid:
        typeof data.holderPid === 'number' ? data.holderPid : null,
    }
  } catch {
    return empty()
  }
}

export function persist(data: LockData): void {
  try {
    const filePath = getLockPath()
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8')
  } catch (e) {
    process.stderr.write(`${CACHE.DIR}: failed to persist lock: ${e}\n`)
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
