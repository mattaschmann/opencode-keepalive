import { SERVICE } from './constants.js'
import { detectPlatform } from './platform.js'
import { load, update, isProcessAlive } from './lock/store.js'
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

function reapDead(): void {
  update((data) => {
    data.activeSessions = data.activeSessions.filter((e) => isProcessAlive(e.pid))
    if (data.activeSessions.length === 0 && data.holderPid !== null) {
      if (!isProcessAlive(data.holderPid)) {
        data.holderPid = null
      }
    }
  })
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

  async function ensureHolder(): Promise<void> {
    if (inflightOp) {
      await inflightOp
      return
    }
    inflightOp = doEnsureHolder()
    try {
      await inflightOp
    } finally {
      inflightOp = null
    }
  }

  async function doEnsureHolder(): Promise<void> {
    reapDead()
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
  }

  async function releaseHolder(): Promise<void> {
    if (inflightOp) {
      await inflightOp
    }
    inflightOp = doReleaseHolder()
    try {
      await inflightOp
    } finally {
      inflightOp = null
    }
  }

  async function doReleaseHolder(): Promise<void> {
    reapDead()
    const lock = load()

    if (lock.activeSessions.length > 0) return

    const pidsToKill = new Set<number>()
    if (ownHolderPid !== null) pidsToKill.add(ownHolderPid)
    if (lock.holderPid !== null && (lock.holderPid === ownHolderPid || !isProcessAlive(lock.holderPid))) {
      pidsToKill.add(lock.holderPid)
    }

    for (const pid of pidsToKill) {
      await be.release(pid)
      log('info', 'wake lock released', { pid })
    }
    ownHolderPid = null
    update((data) => { data.holderPid = null })
  }

  function addSession(sessionID: string): boolean {
    const result = update((data) => {
      if (data.activeSessions.some((e) => e.id === sessionID)) return
      data.activeSessions.push({ id: sessionID, pid: process.pid })
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

  reapDead()
  const ready = ensureHolder()

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
