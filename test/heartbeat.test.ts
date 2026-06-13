import { jest } from '@jest/globals'
import { mkdirSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const TEST_DIR = join(tmpdir(), 'opencode-keepalive-heartbeat-' + process.pid)

const mockLog = jest.fn<any>().mockReturnValue(Promise.resolve())
let mockSessionStatus: jest.Mock<any>
const mockClient = {
  app: {
    log: mockLog,
  },
  session: {
    status: (...args: any[]) => mockSessionStatus(...args),
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
  mockSessionStatus = jest.fn<any>().mockResolvedValue({ data: {}, error: undefined })
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

  it('heartbeat refreshes lastSeen for own sessions still busy', async () => {
    mockSessionStatus.mockResolvedValue({ data: { 'hb-sess': { type: 'busy' } }, error: undefined })
    const hooks = await loadPlugin()

    await hooks.event!({ event: { type: 'session.status', properties: { sessionID: 'hb-sess', status: { type: 'busy' } } } })

    const { load } = await import('../src/lock/store.js')
    const before = load().activeSessions.find((e) => e.id === 'hb-sess')!.lastSeen

    await sleep(100)

    const after = load().activeSessions.find((e) => e.id === 'hb-sess')!.lastSeen
    expect(after).toBeGreaterThan(before)

    await hooks.dispose!()
  })

  it('heartbeat removes own session when server reports idle and releases holder', async () => {
    mockSessionStatus.mockResolvedValue({ data: { 'idle-sess': { type: 'idle' } }, error: undefined })
    const hooks = await loadPlugin()

    await hooks.event!({ event: { type: 'session.status', properties: { sessionID: 'idle-sess', status: { type: 'busy' } } } })

    const { load } = await import('../src/lock/store.js')
    expect(load().activeSessions.find((e) => e.id === 'idle-sess')).toBeDefined()

    await sleep(100)

    expect(load().activeSessions.find((e) => e.id === 'idle-sess')).toBeUndefined()
    expect(mockRelease).toHaveBeenCalled()

    await hooks.dispose!()
  })

  it('heartbeat removes session absent from server status map', async () => {
    mockSessionStatus.mockResolvedValue({ data: {}, error: undefined })
    const hooks = await loadPlugin()

    await hooks.event!({ event: { type: 'session.status', properties: { sessionID: 'gone-sess', status: { type: 'busy' } } } })

    const { load } = await import('../src/lock/store.js')
    expect(load().activeSessions.find((e) => e.id === 'gone-sess')).toBeDefined()

    await sleep(100)

    expect(load().activeSessions.find((e) => e.id === 'gone-sess')).toBeUndefined()

    await hooks.dispose!()
  })

  it('heartbeat retains session when session.status() throws (fail-safe)', async () => {
    mockSessionStatus.mockRejectedValue(new Error('network blip'))
    const hooks = await loadPlugin()

    await hooks.event!({ event: { type: 'session.status', properties: { sessionID: 'busy-sess', status: { type: 'busy' } } } })

    const { load } = await import('../src/lock/store.js')
    const before = load().activeSessions.find((e) => e.id === 'busy-sess')!.lastSeen

    await sleep(100)

    const after = load().activeSessions.find((e) => e.id === 'busy-sess')
    expect(after).toBeDefined()
    expect(after!.lastSeen).toBeGreaterThan(before)

    await hooks.dispose!()
  })

  it('heartbeat re-acquires holder when holder dies but sessions remain busy', async () => {
    const { spawn: realSpawn } = await import('node:child_process')

    // First acquire returns a real process so we can kill it
    const holder = realSpawn('sleep', ['120'], { detached: true, stdio: 'ignore' })
    holder.unref()
    const holderPid = holder.pid!
    mockAcquire
      .mockResolvedValueOnce(holderPid)
      .mockResolvedValue(process.pid)

    mockSessionStatus.mockResolvedValue({ data: { 'live-sess': { type: 'busy' } }, error: undefined })
    const hooks = await loadPlugin()

    await hooks.event!({ event: { type: 'session.status', properties: { sessionID: 'live-sess', status: { type: 'busy' } } } })
    expect(mockAcquire).toHaveBeenCalledTimes(1)

    // Kill the holder so isProcessAlive returns false
    try { process.kill(holderPid) } catch { /* already dead */ }

    await sleep(150)

    // ensureHolder should have re-acquired
    expect(mockAcquire.mock.calls.length).toBeGreaterThanOrEqual(2)

    await hooks.dispose!()
  })
})
