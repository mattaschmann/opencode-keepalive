import { jest } from '@jest/globals'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn, type ChildProcess } from 'node:child_process'

const TEST_DIR = join(tmpdir(), 'opencode-keepalive-crossproc-' + process.pid)

const mockLog = jest.fn<any>().mockReturnValue(Promise.resolve())
const mockClient = {
  app: {
    log: mockLog,
  },
}

let mockAcquire: jest.Mock<any>
let mockRelease: jest.Mock<any>
let mockSupported: jest.Mock<any>

let holderProcess: ChildProcess | null = null

beforeAll(() => {
  mkdirSync(TEST_DIR, { recursive: true })
  process.env.OPENCODE_KEEPALIVE_CACHE_DIR = TEST_DIR
})

afterAll(() => {
  delete process.env.OPENCODE_KEEPALIVE_CACHE_DIR
  rmSync(TEST_DIR, { recursive: true, force: true })
})

beforeEach(() => {
  mockRelease = jest.fn<any>().mockResolvedValue(undefined)
  mockSupported = jest.fn<any>().mockReturnValue(true)
  mockLog.mockClear()
  rmSync(join(TEST_DIR, 'lock.json'), { force: true })
  rmSync(join(TEST_DIR, 'lock.json.lock'), { force: true })
  rmSync(join(TEST_DIR, 'lock.json.tmp'), { force: true })
  jest.resetModules()
  const g = globalThis as any
  delete g[Symbol.for('opencode-keepalive')]

  holderProcess = spawn('sleep', ['120'], { detached: true, stdio: 'ignore' })
  holderProcess.unref()

  mockAcquire = jest.fn<any>().mockResolvedValue(holderProcess!.pid!)
})

afterEach(() => {
  if (holderProcess?.pid) {
    try { process.kill(holderProcess.pid) } catch {}
  }
  holderProcess = null
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

describe('cross-process ref counting', () => {
  it('releases holder spawned by another process when last session drains', async () => {
    const { persist } = await import('../src/lock/store.js')
    const FOREIGN_PID = 2147483646

    persist({
      activeSessions: [{ id: 'foreign-sess', pid: FOREIGN_PID }],
      holderPid: holderProcess!.pid!,
    })

    const hooks = await loadPlugin()

    await hooks.event!({ event: { type: 'session.status', properties: { sessionID: 'my-sess', status: { type: 'busy' } } } })
    expect(mockAcquire).not.toHaveBeenCalled()

    await hooks.event!({ event: { type: 'session.status', properties: { sessionID: 'my-sess', status: { type: 'idle' } } } })

    expect(mockRelease).toHaveBeenCalledWith(holderProcess!.pid!)
  })

  it('does not orphan holder when non-owning instance drains all sessions via dispose', async () => {
    const { persist, load } = await import('../src/lock/store.js')

    persist({
      activeSessions: [{ id: 'local-sess', pid: process.pid }],
      holderPid: holderProcess!.pid!,
    })

    mockAcquire.mockResolvedValue(holderProcess!.pid!)

    const hooks = await loadPlugin()

    await hooks.event!({ event: { type: 'session.status', properties: { sessionID: 'local-sess', status: { type: 'busy' } } } })
    await hooks.dispose!()

    expect(mockRelease).toHaveBeenCalledWith(holderProcess!.pid!)
    const lock = load()
    expect(lock.holderPid).toBeNull()
    expect(lock.activeSessions).toHaveLength(0)
  })
})
