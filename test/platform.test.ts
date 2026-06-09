import { jest } from '@jest/globals'

describe('detectPlatform', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    jest.resetModules()
  })

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  it('returns darwin on macOS', async () => {
    jest.unstable_mockModule('node:os', () => ({ platform: () => 'darwin' }))
    delete process.env.WSL_DISTRO_NAME
    const { detectPlatform } = await import('../src/platform.js')
    expect(detectPlatform()).toBe('darwin')
  })

  it('returns win32 on native Windows', async () => {
    jest.unstable_mockModule('node:os', () => ({ platform: () => 'win32' }))
    delete process.env.WSL_DISTRO_NAME
    const { detectPlatform } = await import('../src/platform.js')
    expect(detectPlatform()).toBe('win32')
  })

  it('returns wsl2 on Linux with WSL_DISTRO_NAME set', async () => {
    jest.unstable_mockModule('node:os', () => ({ platform: () => 'linux' }))
    process.env.WSL_DISTRO_NAME = 'Ubuntu'
    const { detectPlatform } = await import('../src/platform.js')
    expect(detectPlatform()).toBe('wsl2')
  })

  it('returns linux on Linux without WSL_DISTRO_NAME', async () => {
    jest.unstable_mockModule('node:os', () => ({ platform: () => 'linux' }))
    delete process.env.WSL_DISTRO_NAME
    const { detectPlatform } = await import('../src/platform.js')
    expect(detectPlatform()).toBe('linux')
  })
})
