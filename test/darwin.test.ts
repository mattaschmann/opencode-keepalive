import { jest } from '@jest/globals'

let mockSpawn: jest.Mock<any>
let mockExecFileSync: jest.Mock<any>

describe('darwin backend', () => {
  beforeEach(() => {
    jest.resetModules()
    mockSpawn = jest.fn<any>()
    mockExecFileSync = jest.fn<any>()
  })

  async function loadBackend(caffeinateAvailable: boolean) {
    if (caffeinateAvailable) {
      mockExecFileSync.mockImplementation(() => Buffer.from(''))
    } else {
      const err = new Error('ENOENT') as any
      err.code = 'ENOENT'
      err.status = null
      mockExecFileSync.mockImplementation(() => { throw err })
    }

    jest.unstable_mockModule('node:child_process', () => ({
      spawn: (...args: any[]) => mockSpawn(...args),
      execFileSync: (...args: any[]) => mockExecFileSync(...args),
    }))

    const { createDarwinBackend } = await import('../src/keepalive/darwin.js')
    return createDarwinBackend()
  }

  it('supported() returns true when caffeinate is available', async () => {
    const backend = await loadBackend(true)
    expect(backend.supported()).toBe(true)
  })

  it('supported() returns false when caffeinate is not found', async () => {
    const backend = await loadBackend(false)
    expect(backend.supported()).toBe(false)
  })

  it('supported() returns true when caffeinate exits with non-zero (e.g. -h)', async () => {
    const err = new Error('exit 1') as any
    err.status = 1
    mockExecFileSync.mockImplementation(() => { throw err })

    jest.unstable_mockModule('node:child_process', () => ({
      spawn: (...args: any[]) => mockSpawn(...args),
      execFileSync: (...args: any[]) => mockExecFileSync(...args),
    }))

    const { createDarwinBackend } = await import('../src/keepalive/darwin.js')
    const backend = createDarwinBackend()
    expect(backend.supported()).toBe(true)
  })

  it('acquire() spawns caffeinate with -im flags detached', async () => {
    const fakePid = 42424
    mockSpawn.mockReturnValue({ pid: fakePid, unref: jest.fn() })
    const backend = await loadBackend(true)
    const pid = await backend.acquire()
    expect(pid).toBe(fakePid)
    expect(mockSpawn).toHaveBeenCalledWith(
      'caffeinate',
      ['-im'],
      expect.objectContaining({ detached: true, stdio: 'ignore' })
    )
  })

  it('acquire() throws when caffeinate is not available', async () => {
    const backend = await loadBackend(false)
    await expect(backend.acquire()).rejects.toThrow('caffeinate not found')
  })

  it('acquire() throws when spawn returns no pid', async () => {
    mockSpawn.mockReturnValue({ pid: undefined, unref: jest.fn() })
    const backend = await loadBackend(true)
    await expect(backend.acquire()).rejects.toThrow('failed to spawn caffeinate')
  })

  it('release() does not throw for a dead pid', async () => {
    const backend = await loadBackend(true)
    await expect(backend.release(2147483647)).resolves.toBeUndefined()
  })
})
