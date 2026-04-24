import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdir, writeFile, readFile, rm, stat } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { Janitor } from '../../src/store/janitor.js'

describe('Janitor — event log rotation', () => {
  let dir: string

  beforeEach(async () => {
    dir = join(tmpdir(), `sovra-janitor-${Date.now()}-${Math.random()}`)
    await mkdir(dir, { recursive: true })
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('truncates events.jsonl to keepLines when over maxBytes', async () => {
    const logPath = join(dir, 'events.jsonl')
    const lines: string[] = []
    for (let i = 0; i < 20_000; i++) lines.push(JSON.stringify({ i, pad: 'x'.repeat(200) }))
    await writeFile(logPath, lines.join('\n') + '\n')
    const before = (await stat(logPath)).size
    expect(before).toBeGreaterThan(1024 * 1024) // sanity: big enough

    const janitor = new Janitor({
      dataDir: dir,
      eventLogPath: logPath,
      eventLogMaxBytes: 1024 * 1024, // 1 MB threshold for test
      eventLogKeepLines: 100,
      mediaMaxAgeMs: 0,
      mediaPressureAgeMs: 0,
      diskPressureThreshold: 2, // disable pressure
      r2Enabled: true,
    })

    const result = await janitor.rotateEventLog()
    expect(result.rotated).toBe(true)
    const content = await readFile(logPath, 'utf-8')
    const newLines = content.trimEnd().split('\n')
    expect(newLines.length).toBe(100)
    // Last-line preservation
    const last = JSON.parse(newLines[newLines.length - 1])
    expect(last.i).toBe(19999)
  })

  it('skips rotation when under threshold', async () => {
    const logPath = join(dir, 'events.jsonl')
    await writeFile(logPath, 'small\n')
    const janitor = new Janitor({
      dataDir: dir,
      eventLogPath: logPath,
      eventLogMaxBytes: 1024 * 1024,
      eventLogKeepLines: 100,
      mediaMaxAgeMs: 0,
      mediaPressureAgeMs: 0,
      diskPressureThreshold: 2,
      r2Enabled: true,
    })

    const result = await janitor.rotateEventLog()
    expect(result.rotated).toBe(false)
  })

  it('skips rotation when file does not exist', async () => {
    const janitor = new Janitor({
      dataDir: dir,
      eventLogPath: join(dir, 'missing.jsonl'),
      eventLogMaxBytes: 1024,
      eventLogKeepLines: 10,
      mediaMaxAgeMs: 0,
      mediaPressureAgeMs: 0,
      diskPressureThreshold: 2,
      r2Enabled: true,
    })
    const result = await janitor.rotateEventLog()
    expect(result.rotated).toBe(false)
  })
})
