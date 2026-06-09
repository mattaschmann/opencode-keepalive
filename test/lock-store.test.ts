import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { load, persist, clear, isProcessAlive } from '../src/lock/store.js'

const TEST_DIR = join(tmpdir(), 'opencode-keepalive-test-' + process.pid)

beforeAll(() => {
  mkdirSync(TEST_DIR, { recursive: true })
  process.env.OPENCODE_KEEPALIVE_CACHE_DIR = TEST_DIR
})

afterAll(() => {
  delete process.env.OPENCODE_KEEPALIVE_CACHE_DIR
  rmSync(TEST_DIR, { recursive: true, force: true })
})

afterEach(() => {
  rmSync(join(TEST_DIR, 'lock.json'), { force: true })
})

describe('lock/store', () => {
  it('returns empty lock when no file exists', () => {
    const data = load()
    expect(data).toEqual({ activeSessions: [], holderPid: null })
  })

  it('persists and loads data round-trip', () => {
    const data = { activeSessions: ['sess-1', 'sess-2'], holderPid: 12345 }
    persist(data)
    const loaded = load()
    expect(loaded).toEqual(data)
  })

  it('recovers from corrupt JSON', () => {
    writeFileSync(join(TEST_DIR, 'lock.json'), '{{not json', 'utf8')
    const data = load()
    expect(data).toEqual({ activeSessions: [], holderPid: null })
  })

  it('filters non-string session IDs', () => {
    writeFileSync(
      join(TEST_DIR, 'lock.json'),
      JSON.stringify({ activeSessions: ['valid', 123, null], holderPid: 99 }),
      'utf8'
    )
    const data = load()
    expect(data.activeSessions).toEqual(['valid'])
    expect(data.holderPid).toBe(99)
  })

  it('handles null holderPid gracefully', () => {
    writeFileSync(
      join(TEST_DIR, 'lock.json'),
      JSON.stringify({ activeSessions: [], holderPid: 'not-a-number' }),
      'utf8'
    )
    const data = load()
    expect(data.holderPid).toBeNull()
  })

  it('clear removes the lock file', () => {
    persist({ activeSessions: ['x'], holderPid: 1 })
    expect(existsSync(join(TEST_DIR, 'lock.json'))).toBe(true)
    clear()
    expect(existsSync(join(TEST_DIR, 'lock.json'))).toBe(false)
  })

  it('isProcessAlive returns true for own PID', () => {
    expect(isProcessAlive(process.pid)).toBe(true)
  })

  it('isProcessAlive returns false for non-existent PID', () => {
    expect(isProcessAlive(2147483647)).toBe(false)
  })
})
