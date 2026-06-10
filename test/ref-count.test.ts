import { jest } from '@jest/globals'
import { mkdirSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const TEST_DIR = join(tmpdir(), 'opencode-keepalive-refcount-' + process.pid)

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
})

afterAll(() => {
  delete process.env.OPENCODE_KEEPALIVE_CACHE_DIR
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
    detectPlatform: () => 'wsl2',
  }))

  const { default: plugin } = await import('../src/index.js')
  return plugin({ client: mockClient } as any)
}

describe('ref counting', () => {
  it('acquires on first busy session, releases when last goes idle', async () => {
    const hooks = await loadPlugin()

    await hooks.event!({ event: { type: 'session.status', properties: { sessionID: 'a', status: { type: 'busy' } } } })
    expect(mockAcquire).toHaveBeenCalledTimes(1)

    await hooks.event!({ event: { type: 'session.status', properties: { sessionID: 'b', status: { type: 'busy' } } } })
    expect(mockAcquire).toHaveBeenCalledTimes(1)

    await hooks.event!({ event: { type: 'session.status', properties: { sessionID: 'a', status: { type: 'idle' } } } })
    expect(mockRelease).not.toHaveBeenCalled()

    await hooks.event!({ event: { type: 'session.status', properties: { sessionID: 'b', status: { type: 'idle' } } } })
    expect(mockRelease).toHaveBeenCalledTimes(1)
  })

  it('removes session on session.deleted', async () => {
    const hooks = await loadPlugin()

    await hooks.event!({ event: { type: 'session.status', properties: { sessionID: 'x', status: { type: 'busy' } } } })
    await hooks.event!({ event: { type: 'session.deleted', properties: { info: { id: 'x' } } } })
    expect(mockRelease).toHaveBeenCalled()
  })

  it('removes session on session.error', async () => {
    const hooks = await loadPlugin()

    await hooks.event!({ event: { type: 'session.status', properties: { sessionID: 'y', status: { type: 'retry', attempt: 1, message: 'err', next: 0 } } } })
    await hooks.event!({ event: { type: 'session.error', properties: { sessionID: 'y' } } })
    expect(mockRelease).toHaveBeenCalled()
  })

  it('dispose releases and clears sessions', async () => {
    const hooks = await loadPlugin()

    await hooks.event!({ event: { type: 'session.status', properties: { sessionID: 'z', status: { type: 'busy' } } } })
    await hooks.dispose!()
    expect(mockRelease).toHaveBeenCalled()
  })

  it('does not acquire twice for duplicate busy events', async () => {
    const hooks = await loadPlugin()

    await hooks.event!({ event: { type: 'session.status', properties: { sessionID: 'a', status: { type: 'busy' } } } })
    await hooks.event!({ event: { type: 'session.status', properties: { sessionID: 'a', status: { type: 'busy' } } } })
    expect(mockAcquire).toHaveBeenCalledTimes(1)
  })

  it('does not release if session was not tracked', async () => {
    const hooks = await loadPlugin()

    await hooks.event!({ event: { type: 'session.status', properties: { sessionID: 'ghost', status: { type: 'idle' } } } })
    expect(mockRelease).not.toHaveBeenCalled()
  })

  it('concurrent busy events for different sessions only acquire once', async () => {
    const hooks = await loadPlugin()

    await Promise.all([
      hooks.event!({ event: { type: 'session.status', properties: { sessionID: 'c1', status: { type: 'busy' } } } }),
      hooks.event!({ event: { type: 'session.status', properties: { sessionID: 'c2', status: { type: 'busy' } } } }),
    ])
    expect(mockAcquire).toHaveBeenCalledTimes(1)
  })

  it('records session entries with pid in lock file', async () => {
    const hooks = await loadPlugin()

    await hooks.event!({ event: { type: 'session.status', properties: { sessionID: 'sess-abc', status: { type: 'busy' } } } })

    const raw = JSON.parse(readFileSync(join(TEST_DIR, 'lock.json'), 'utf8'))
    expect(raw.activeSessions).toEqual([{ id: 'sess-abc', pid: process.pid }])
  })

  it('does not release holder while another live process holds a session', async () => {
    const { persist } = await import('../src/lock/store.js')
    persist({
      activeSessions: [{ id: 'other-sess', pid: process.pid }],
      holderPid: process.pid,
    })

    const hooks = await loadPlugin()

    await hooks.event!({ event: { type: 'session.status', properties: { sessionID: 'my-sess', status: { type: 'busy' } } } })
    await hooks.event!({ event: { type: 'session.status', properties: { sessionID: 'my-sess', status: { type: 'idle' } } } })

    expect(mockRelease).not.toHaveBeenCalled()
  })

  it('reaps sessions from dead processes and releases holder', async () => {
    const { persist } = await import('../src/lock/store.js')
    persist({
      activeSessions: [{ id: 'orphan-sess', pid: 2147483647 }],
      holderPid: process.pid,
    })

    const hooks = await loadPlugin()

    await hooks.event!({ event: { type: 'session.status', properties: { sessionID: 'live-sess', status: { type: 'busy' } } } })
    await hooks.event!({ event: { type: 'session.status', properties: { sessionID: 'live-sess', status: { type: 'idle' } } } })

    expect(mockRelease).toHaveBeenCalled()
  })
})
