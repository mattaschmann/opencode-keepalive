import { SERVICE } from './constants.js'
import { detectPlatform } from './platform.js'
import { load, update, isProcessAlive, STALE_SESSION_MS, HEARTBEAT_MS } from './lock/store.js'
import { createWindowsBackend } from './keepalive/windows.js'
import { createDarwinBackend } from './keepalive/darwin.js'
import { createLinuxBackend } from './keepalive/linux.js'
import type { KeepaliveBackend } from './types.js'

type LogFn = (level: 'debug' | 'info' | 'warn' | 'error', message: string, extra?: Record<string, unknown>) => void

const KEY = Symbol.for('opencode-keepalive')

interface SharedHandler {
  event(args: { event: any }): Promise<void>
  dispose(): Promise<void>
  ready: Promise<void>
}

function getBackend(): KeepaliveBackend | null {
  const platform = detectPlatform()
  switch (platform) {
    case 'wsl2':
    case 'win32':
      return createWindowsBackend()
    case 'darwin':
      return createDarwinBackend()
    case 'linux':
      return createLinuxBackend()
    default:
      return null
  }
}

function createSharedHandler(client: any): SharedHandler {
  const log: LogFn = (level, message, extra) => {
    client.app.log({ body: { service: SERVICE, level, message, extra } }).catch(() => {
      process.stderr.write(`${SERVICE}: [${level}] ${message}\n`)
    })
  }

  const backend = getBackend()
  const platform = detectPlatform()

  if (!backend || !backend.supported()) {
    log('warn', `unsupported or unavailable platform: ${platform}`)
    return {
      ready: Promise.resolve(),
      async event({ event }: { event: any }) {
        if (event.type.startsWith('session.')) {
          log('debug', `event: ${event.type}`, { properties: event.properties })
        }
      },
      async dispose() {},
    }
  }

  log('info', `plugin loaded, platform: ${platform}`)

  const be = backend!
  let ownHolderPid: number | null = null
  let inflightOp: Promise<void> | null = null
  let disposed = false
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null

  function touchOwnSessions(data: { activeSessions: { id: string; pid: number; lastSeen: number }[] }): void {
    const now = Date.now()
    for (const entry of data.activeSessions) {
      if (entry.pid === process.pid) entry.lastSeen = now
    }
  }

  function reapDead(): number | null {
    let orphanedHolder: number | null = null
    update((data) => {
      const now = Date.now()
      data.activeSessions = data.activeSessions.filter((e) =>
        isProcessAlive(e.pid) && (now - e.lastSeen < STALE_SESSION_MS),
      )
      if (data.activeSessions.length === 0 && data.holderPid !== null) {
        orphanedHolder = data.holderPid
        data.holderPid = null
        ownHolderPid = null
      }
    })
    return orphanedHolder
  }

  async function releaseOrphan(pid: number | null): Promise<void> {
    if (pid === null) return
    await be.release(pid)
    log('info', 'wake lock released (orphan)', { pid })
  }

  async function runExclusive(fn: () => Promise<void>): Promise<void> {
    if (inflightOp) await inflightOp
    inflightOp = fn()
    try {
      await inflightOp
    } finally {
      inflightOp = null
    }
  }

  async function ensureHolder(): Promise<void> {
    return runExclusive(async () => {
      await releaseOrphan(reapDead())
      const lock = load()
      if (lock.activeSessions.length === 0) return

      if (ownHolderPid !== null && isProcessAlive(ownHolderPid)) return
      if (lock.holderPid !== null && lock.holderPid !== ownHolderPid && isProcessAlive(lock.holderPid)) {
        ownHolderPid = lock.holderPid
        return
      }

      try {
        const pid = await be.acquire()
        ownHolderPid = pid
        update((data) => { data.holderPid = pid })
        log('info', 'wake lock acquired', { pid })
      } catch (e) {
        log('error', `failed to acquire wake lock: ${e}`)
      }
    })
  }

  async function releaseHolder(): Promise<void> {
    return runExclusive(async () => {
      await releaseOrphan(reapDead())
      const lock = load()
      if (lock.activeSessions.length > 0) return

      const pidsToKill = new Set<number>()
      if (ownHolderPid !== null) pidsToKill.add(ownHolderPid)
      if (lock.holderPid !== null) pidsToKill.add(lock.holderPid)

      for (const pid of pidsToKill) {
        await be.release(pid)
        log('info', 'wake lock released', { pid })
      }
      ownHolderPid = null
      update((data) => { data.holderPid = null })
    })
  }

  function addSession(sessionID: string): boolean {
    const result = update((data) => {
      if (data.activeSessions.some((e) => e.id === sessionID)) {
        touchOwnSessions(data)
        return
      }
      data.activeSessions.push({ id: sessionID, pid: process.pid, lastSeen: Date.now() })
    })
    return result.activeSessions.length === 1 &&
      result.activeSessions[0]!.id === sessionID
  }

  function removeSession(sessionID: string): boolean {
    const result = update((data) => {
      const idx = data.activeSessions.findIndex((e) => e.id === sessionID)
      if (idx !== -1) data.activeSessions.splice(idx, 1)
    })
    return result.activeSessions.length === 0
  }

  async function onHeartbeat(): Promise<void> {
    try {
      const result = await client.session.status()
      const statuses: Record<string, { type: string }> | undefined = result?.data
      if (!statuses) {
        update((data) => { touchOwnSessions(data) })
      } else {
        const now = Date.now()
        update((data) => {
          data.activeSessions = data.activeSessions.filter((entry) => {
            if (entry.pid !== process.pid) return true
            const s = statuses[entry.id]
            if (!s || s.type === 'idle') return false
            entry.lastSeen = now
            return true
          })
        })
      }
    } catch {
      update((data) => { touchOwnSessions(data) })
    }

    const lock = load()
    if (lock.activeSessions.length > 0) {
      await ensureHolder()
    } else {
      await releaseHolder()
    }
  }

  function syncCleanup(): void {
    try {
      update((data) => {
        data.activeSessions = data.activeSessions.filter((e) => e.pid !== process.pid)
        if (data.activeSessions.length === 0 && data.holderPid !== null) {
          try { process.kill(data.holderPid) } catch { /* dead */ }
          data.holderPid = null
          ownHolderPid = null
        }
      })
    } catch { /* best effort */ }
  }

  function installExitHandlers(): void {
    process.on('exit', syncCleanup)
  }

  installExitHandlers()
  heartbeatTimer = setInterval(() => { onHeartbeat().catch(() => {}) }, HEARTBEAT_MS)
  heartbeatTimer.unref()
  const ready = (async () => {
    await releaseOrphan(reapDead())
    await ensureHolder()
  })()

  return {
    ready,

    async event({ event }: { event: any }) {
      if (event.type.startsWith('session.')) {
        log('debug', `event: ${event.type}`, { properties: event.properties })
      }

      if (event.type === 'session.status') {
        const { sessionID, status } = event.properties
        const statusType: string = status?.type

        if (statusType === 'busy' || statusType === 'retry') {
          const isFirst = addSession(sessionID)
          if (isFirst) await ensureHolder()
        } else if (statusType === 'idle') {
          const nowEmpty = removeSession(sessionID)
          if (nowEmpty) {
            await releaseHolder()
          }
        }
      }

      if (event.type === 'session.deleted') {
        const sessionID = event.properties?.info?.id
        if (sessionID) {
          const nowEmpty = removeSession(sessionID)
          if (nowEmpty) await releaseHolder()
        }
      }

      if (event.type === 'session.error') {
        const sessionID = event.properties?.sessionID
        if (sessionID) {
          const nowEmpty = removeSession(sessionID)
          if (nowEmpty) await releaseHolder()
        }
      }
    },

    async dispose() {
      if (disposed) return
      disposed = true
      if (heartbeatTimer) clearInterval(heartbeatTimer)
      update((data) => {
        data.activeSessions = data.activeSessions.filter((e) => e.pid !== process.pid)
      })
      const lock = load()
      if (lock.activeSessions.length === 0) {
        await releaseHolder()
      }
    },
  }
}

const plugin = async ({ client }: { client: any }) => {
  const g = globalThis as any
  if (!g[KEY]) {
    g[KEY] = createSharedHandler(client)
  }
  const shared: SharedHandler = g[KEY]
  await shared.ready

  return {
    async event(args: { event: any }) {
      await shared.event(args)
    },
    async dispose() {
      await shared.dispose()
    },
  }
}

export default plugin
export { plugin }
