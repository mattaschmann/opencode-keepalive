import { jest } from '@jest/globals'
import { mkdirSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const TEST_DIR = join(tmpdir(), 'opencode-keepalive-heartbeat-' + process.pid)

const mockLog = jest.fn<any>().mockReturnValue(Promise.resolve())
const mockClient = {
  app: {
    log: mockLog,
  },
}

let mockAcquire: jest.Mock<any>
let mockRelease: jest.Mock<any>
let mockSupported: jest.Mock<any>

beforeAll(() => {
  mkdirSync(TEST_DIR, { recursive: true })
  process.env.OPENCODE_KEEPALIVE_CACHE_DIR = TEST_DIR
  process.env.OPENCODE_KEEPALIVE_STALE_MS = '200'
  process.env.OPENCODE_KEEPALIVE_HEARTBEAT_MS = '50'
})

afterAll(() => {
  delete process.env.OPENCODE_KEEPALIVE_CACHE_DIR
  delete process.env.OPENCODE_KEEPALIVE_STALE_MS
  delete process.env.OPENCODE_KEEPALIVE_HEARTBEAT_MS
  rmSync(TEST_DIR, { recursive: true, force: true })
})

beforeEach(() => {
  mockAcquire = jest.fn<any>().mockResolvedValue(process.pid)
  mockRelease = jest.fn<any>().mockResolvedValue(undefined)
  mockSupported = jest.fn<any>().mockReturnValue(true)
  mockLog.mockClear()
  rmSync(join(TEST_DIR, 'lock.json'), { force: true })
  rmSync(join(TEST_DIR, 'lock.json.lock'), { force: true })
  rmSync(join(TEST_DIR, 'lock.json.tmp'), { force: true })
  jest.resetModules()
  const g = globalThis as any
  delete g[Symbol.for('opencode-keepalive')]
})

async function loadPlugin() {
  jest.unstable_mockModule('../src/keepalive/windows.js', () => ({
    createWindowsBackend: () => ({
      acquire: (...args: any[]) => mockAcquire(...args),
      release: (...args: any[]) => mockRelease(...args),
      supported: (...args: any[]) => mockSupported(...args),
    }),
  }))

  jest.unstable_mockModule('../src/keepalive/darwin.js', () => ({
    createDarwinBackend: () => ({
      acquire: (...args: any[]) => mockAcquire(...args),
      release: (...args: any[]) => mockRelease(...args),
      supported: (...args: any[]) => mockSupported(...args),
    }),
  }))

  jest.unstable_mockModule('../src/keepalive/linux.js', () => ({
    createLinuxBackend: () => ({
      acquire: (...args: any[]) => mockAcquire(...args),
      release: (...args: any[]) => mockRelease(...args),
      supported: (...args: any[]) => mockSupported(...args),
    }),
  }))

  jest.unstable_mockModule('../src/platform.js', () => ({
    detectPlatform: () => 'linux',
  }))

  const { default: plugin } = await import('../src/index.js')
  return plugin({ client: mockClient } as any)
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('heartbeat and stale session reaping', () => {
  it('reaps stale sessions whose lastSeen exceeds STALE_SESSION_MS', async () => {
    const { persist, load } = await import('../src/lock/store.js')

    persist({
      activeSessions: [{ id: 'stale-sess', pid: process.pid, lastSeen: Date.now() - 10_000 }],
      holderPid: null,
    })

    await loadPlugin()

    const lock = load()
    expect(lock.activeSessions.find((e) => e.id === 'stale-sess')).toBeUndefined()
  })

  it('startup releases an orphaned-but-alive holder when sessions are empty', async () => {
    const { spawn: realSpawn } = await import('node:child_process')
    const holder = realSpawn('sleep', ['120'], { detached: true, stdio: 'ignore' })
    holder.unref()

    try {
      const { persist, load } = await import('../src/lock/store.js')

      persist({
        activeSessions: [],
        holderPid: holder.pid!,
      })

      await loadPlugin()

      const lock = load()
      expect(lock.holderPid).toBeNull()
    } finally {
      try { process.kill(holder.pid!) } catch {}
    }
  })

  it('heartbeat refreshes lastSeen for own sessions', async () => {
    const hooks = await loadPlugin()

    await hooks.event!({ event: { type: 'session.status', properties: { sessionID: 'hb-sess', status: { type: 'busy' } } } })

    const { load } = await import('../src/lock/store.js')
    const before = load().activeSessions.find((e) => e.id === 'hb-sess')!.lastSeen

    await sleep(100)

    const after = load().activeSessions.find((e) => e.id === 'hb-sess')!.lastSeen
    expect(after).toBeGreaterThan(before)

    await hooks.dispose!()
  })
})
