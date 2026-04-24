import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdir, writeFile, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { auditDataDir } from '../../src/store/disk-audit.js'

describe('auditDataDir', () => {
  let dir: string

  beforeEach(async () => {
    dir = join(tmpdir(), `sovra-audit-${Date.now()}-${Math.random()}`)
    await mkdir(join(dir, 'images'), { recursive: true })
    await mkdir(join(dir, 'videos'), { recursive: true })
    await writeFile(join(dir, 'images', 'a.png'), Buffer.alloc(1024))
    await writeFile(join(dir, 'images', 'b.png'), Buffer.alloc(2048))
    await writeFile(join(dir, 'videos', 'c.mp4'), Buffer.alloc(4096))
    await writeFile(join(dir, 'events.jsonl'), Buffer.alloc(512))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('reports total bytes and per-subdir bytes', async () => {
    const report = await auditDataDir(dir)
    expect(report.totalBytes).toBe(1024 + 2048 + 4096 + 512)
    expect(report.subdirs.images).toBe(1024 + 2048)
    expect(report.subdirs.videos).toBe(4096)
  })

  it('returns top files sorted by size desc', async () => {
    const report = await auditDataDir(dir)
    expect(report.topFiles.length).toBeGreaterThan(0)
    expect(report.topFiles[0].bytes).toBe(4096)
    expect(report.topFiles[0].path.endsWith('c.mp4')).toBe(true)
  })

  it('handles missing data directory gracefully', async () => {
    const report = await auditDataDir(join(dir, 'does-not-exist'))
    expect(report.totalBytes).toBe(0)
    expect(report.topFiles).toEqual([])
  })
})
