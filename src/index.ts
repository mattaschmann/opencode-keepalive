import { SERVICE } from './constants.js'
import { detectPlatform } from './platform.js'
import { load, persist, isProcessAlive } from './lock/store.js'
import { createWindowsBackend } from './keepalive/windows.js'
import { createDarwinBackend } from './keepalive/darwin.js'
import { createLinuxBackend } from './keepalive/linux.js'
import type { KeepaliveBackend } from './types.js'

type LogFn = (level: 'debug' | 'info' | 'warn' | 'error', message: string, extra?: Record<string, unknown>) => void

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

const plugin = async ({ client }: { client: any }) => {
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
      async event({ event }: { event: any }) {
        if (event.type.startsWith('session.')) {
          log('debug', `event: ${event.type}`, { properties: event.properties })
        }
      },
    }
  }

  log('info', `plugin loaded, platform: ${platform}`)

  const be = backend!
  let ownHolderPid: number | null = null

  async function ensureHolder(): Promise<void> {
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
      lock.holderPid = pid
      persist(lock)
      log('info', 'wake lock acquired', { pid })
    } catch (e) {
      log('error', `failed to acquire wake lock: ${e}`)
    }
  }

  async function releaseHolder(): Promise<void> {
    const lock = load()
    const pidToKill = ownHolderPid ?? lock.holderPid
    if (pidToKill !== null) {
      await be.release(pidToKill)
      log('info', 'wake lock released', { pid: pidToKill })
    }
    ownHolderPid = null
    lock.holderPid = null
    persist(lock)
  }

  function addSession(sessionID: string): boolean {
    const lock = load()
    if (lock.activeSessions.includes(sessionID)) return false
    lock.activeSessions.push(sessionID)
    persist(lock)
    return lock.activeSessions.length === 1
  }

  function removeSession(sessionID: string): boolean {
    const lock = load()
    const idx = lock.activeSessions.indexOf(sessionID)
    if (idx === -1) return false
    lock.activeSessions.splice(idx, 1)
    persist(lock)
    return lock.activeSessions.length === 0
  }

  // On load, check if a previous holder is orphaned and re-spawn
  await ensureHolder()

  return {
    async dispose() {
      const lock = load()
      lock.activeSessions = []
      persist(lock)
      await releaseHolder()
    },

    async event({ event }: { event: any }) {
      if (event.type.startsWith('session.')) {
        log('debug', `event: ${event.type}`, { properties: event.properties })
      }

      if (event.type === 'session.status') {
        const { sessionID, status } = event.properties
        const statusType: string = status?.type

        if (statusType === 'busy' || statusType === 'retry') {
          addSession(sessionID)
          await ensureHolder()
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
  }
}

export default plugin
export { plugin }
