import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { load, persist, clear, isProcessAlive, update } from '../src/lock/store.js'

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
  rmSync(join(TEST_DIR, 'lock.json.lock'), { force: true })
  rmSync(join(TEST_DIR, 'lock.json.tmp'), { force: true })
})

describe('lock/store', () => {
  it('returns empty lock when no file exists', () => {
    const data = load()
    expect(data).toEqual({ activeSessions: [], holderPid: null })
  })

  it('persists and loads data round-trip', () => {
    const now = Date.now()
    const data = { activeSessions: [{ id: 'sess-1', pid: 100, lastSeen: now }, { id: 'sess-2', pid: 200, lastSeen: now }], holderPid: 12345 }
    persist(data)
    const loaded = load()
    expect(loaded).toEqual(data)
  })

  it('recovers from corrupt JSON', () => {
    writeFileSync(join(TEST_DIR, 'lock.json'), '{{not json', 'utf8')
    const data = load()
    expect(data).toEqual({ activeSessions: [], holderPid: null })
  })

  it('discards legacy string[] schema', () => {
    writeFileSync(
      join(TEST_DIR, 'lock.json'),
      JSON.stringify({ activeSessions: ['sess-1', 'sess-2'], holderPid: 99 }),
      'utf8'
    )
    const data = load()
    expect(data).toEqual({ activeSessions: [], holderPid: null })
  })

  it('filters invalid session entries', () => {
    writeFileSync(
      join(TEST_DIR, 'lock.json'),
      JSON.stringify({ activeSessions: [{ id: 'valid', pid: 1 }, { id: 123, pid: 2 }, null, { id: 'ok', pid: 'bad' }], holderPid: 99 }),
      'utf8'
    )
    const data = load()
    expect(data.activeSessions).toHaveLength(1)
    expect(data.activeSessions[0]!.id).toBe('valid')
    expect(data.activeSessions[0]!.pid).toBe(1)
    expect(typeof data.activeSessions[0]!.lastSeen).toBe('number')
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
    persist({ activeSessions: [{ id: 'x', pid: 1, lastSeen: Date.now() }], holderPid: 1 })
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

  it('update atomically modifies lock data', () => {
    const now = Date.now()
    persist({ activeSessions: [{ id: 'a', pid: process.pid, lastSeen: now }], holderPid: null })
    const result = update((data) => {
      data.activeSessions.push({ id: 'b', pid: process.pid, lastSeen: now })
    })
    expect(result.activeSessions).toEqual([
      { id: 'a', pid: process.pid, lastSeen: now },
      { id: 'b', pid: process.pid, lastSeen: now },
    ])
    const reloaded = load()
    expect(reloaded.activeSessions).toEqual(result.activeSessions)
  })

  it('concurrent updates do not lose entries', async () => {
    persist({ activeSessions: [], holderPid: null })

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        new Promise<void>((resolve) => {
          setTimeout(() => {
            update((data) => {
              data.activeSessions.push({ id: `s${i}`, pid: process.pid, lastSeen: Date.now() })
            })
            resolve()
          }, i * 2)
        })
      )
    )

    const final = load()
    expect(final.activeSessions).toHaveLength(10)
  })

  it('persist is atomic (no torn reads via rename)', () => {
    const now = Date.now()
    const data = { activeSessions: [{ id: 'x', pid: 1, lastSeen: now }], holderPid: 42 }
    persist(data)
    expect(existsSync(join(TEST_DIR, 'lock.json.tmp'))).toBe(false)
    const loaded = load()
    expect(loaded).toEqual(data)
  })

  it('loads old lock files without lastSeen (back-compat)', () => {
    writeFileSync(
      join(TEST_DIR, 'lock.json'),
      JSON.stringify({ activeSessions: [{ id: 'old', pid: 1 }], holderPid: null }),
      'utf8'
    )
    const data = load()
    expect(data.activeSessions).toHaveLength(1)
    expect(data.activeSessions[0]!.id).toBe('old')
    expect(data.activeSessions[0]!.pid).toBe(1)
    expect(typeof data.activeSessions[0]!.lastSeen).toBe('number')
  })
})
