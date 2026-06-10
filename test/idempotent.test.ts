import { jest } from '@jest/globals'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const TEST_DIR = join(tmpdir(), 'opencode-keepalive-idempotent-' + process.pid)

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
  const g = globalThis as any
  delete g[Symbol.for('opencode-keepalive')]
})

function setupMocks() {
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
    detectPlatform: () => 'darwin',
  }))
}

describe('shared handler across duplicate plugin() calls', () => {
  it('events from either instance reach the shared handler', async () => {
    jest.resetModules()
    setupMocks()

    const { default: plugin } = await import('../src/index.js')

    const hooks1 = await plugin({ client: mockClient } as any)
    const hooks2 = await plugin({ client: mockClient } as any)

    await hooks1.event!({ event: { type: 'session.status', properties: { sessionID: 'a', status: { type: 'busy' } } } })
    expect(mockAcquire).toHaveBeenCalledTimes(1)

    await hooks2.event!({ event: { type: 'session.status', properties: { sessionID: 'b', status: { type: 'busy' } } } })
    expect(mockAcquire).toHaveBeenCalledTimes(1)
  })

  it('duplicate busy events through different instances are deduplicated', async () => {
    jest.resetModules()
    setupMocks()

    const { default: plugin } = await import('../src/index.js')

    const hooks1 = await plugin({ client: mockClient } as any)
    const hooks2 = await plugin({ client: mockClient } as any)

    await hooks1.event!({ event: { type: 'session.status', properties: { sessionID: 'same', status: { type: 'busy' } } } })
    await hooks2.event!({ event: { type: 'session.status', properties: { sessionID: 'same', status: { type: 'busy' } } } })
    expect(mockAcquire).toHaveBeenCalledTimes(1)
  })

  it('dispose is idempotent across instances', async () => {
    jest.resetModules()
    setupMocks()

    const { default: plugin } = await import('../src/index.js')

    const hooks1 = await plugin({ client: mockClient } as any)
    const hooks2 = await plugin({ client: mockClient } as any)

    await hooks1.event!({ event: { type: 'session.status', properties: { sessionID: 'x', status: { type: 'busy' } } } })

    await hooks1.dispose!()
    expect(mockRelease).toHaveBeenCalledTimes(1)

    await hooks2.dispose!()
    expect(mockRelease).toHaveBeenCalledTimes(1)
  })
})
