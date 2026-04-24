import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdir, writeFile, readFile, rm, stat, utimes } from 'fs/promises'
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

describe('Janitor — media age sweep', () => {
  let dir: string

  beforeEach(async () => {
    dir = join(tmpdir(), `sovra-janitor-media-${Date.now()}-${Math.random()}`)
    for (const sub of ['images', 'videos', 'voice', 'bid-images']) {
      await mkdir(join(dir, sub), { recursive: true })
    }
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  async function seedFile(sub: string, name: string, ageMs: number) {
    const p = join(dir, sub, name)
    await writeFile(p, Buffer.alloc(100))
    const t = (Date.now() - ageMs) / 1000
    await utimes(p, t, t)
    return p
  }

  it('deletes files older than maxAgeMs across all media subdirs', async () => {
    const DAY = 24 * 3600 * 1000
    const old1 = await seedFile('images', 'old.png', 10 * DAY)
    const old2 = await seedFile('videos', 'old.mp4', 10 * DAY)
    const fresh = await seedFile('voice', 'fresh.mp3', 1 * DAY)

    const janitor = new Janitor({
      dataDir: dir,
      eventLogPath: join(dir, 'events.jsonl'),
      eventLogMaxBytes: 1 << 30,
      eventLogKeepLines: 10,
      mediaMaxAgeMs: 7 * DAY,
      mediaPressureAgeMs: DAY,
      diskPressureThreshold: 2,
      r2Enabled: true,
    })

    const result = await janitor.sweepMediaByAge(7 * DAY)
    expect(result.filesDeleted).toBe(2)

    const { access } = await import('fs/promises')
    await expect(access(old1)).rejects.toThrow()
    await expect(access(old2)).rejects.toThrow()
    await access(fresh) // should not throw
  })

  it('ignores missing subdirs', async () => {
    await rm(join(dir, 'videos'), { recursive: true })
    const janitor = new Janitor({
      dataDir: dir,
      eventLogPath: join(dir, 'events.jsonl'),
      eventLogMaxBytes: 1 << 30,
      eventLogKeepLines: 10,
      mediaMaxAgeMs: 1000,
      mediaPressureAgeMs: 1000,
      diskPressureThreshold: 2,
      r2Enabled: true,
    })
    const result = await janitor.sweepMediaByAge(1000)
    expect(result.filesDeleted).toBe(0)
  })
})

import { JsonStore } from '../../src/store/json-store.js'
import type { Post } from '../../src/types.js'

describe('Janitor — disk pressure', () => {
  let dir: string

  beforeEach(async () => {
    dir = join(tmpdir(), `sovra-janitor-pressure-${Date.now()}-${Math.random()}`)
    for (const sub of ['images', 'videos', 'voice', 'bid-images']) {
      await mkdir(join(dir, sub), { recursive: true })
    }
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  async function seedFile(sub: string, name: string, ageMs: number) {
    const p = join(dir, sub, name)
    await writeFile(p, Buffer.alloc(100))
    const t = (Date.now() - ageMs) / 1000
    await utimes(p, t, t)
    return p
  }

  it('runs aggressive sweep when disk usage exceeds threshold', async () => {
    const DAY = 24 * 3600 * 1000
    const file = await seedFile('images', 'pressure.png', 2 * DAY)

    const janitor = new Janitor({
      dataDir: dir,
      eventLogPath: join(dir, 'events.jsonl'),
      eventLogMaxBytes: 1 << 30,
      eventLogKeepLines: 10,
      mediaMaxAgeMs: 7 * DAY,
      mediaPressureAgeMs: 1 * DAY,
      diskPressureThreshold: 0.5,
      r2Enabled: true,
      getDiskUsage: async () => 0.9,
    })

    await janitor.sweep()
    const { access } = await import('fs/promises')
    await expect(access(file)).rejects.toThrow()
  })

  it('nulls out posts.json URLs for files deleted under pressure when R2 disabled', async () => {
    const DAY = 24 * 3600 * 1000
    const file = await seedFile('images', 'referenced.png', 2 * DAY)
    const postsPath = join(dir, 'posts.json')
    const postsStore = new JsonStore<Post[]>(postsPath)
    await postsStore.write([{
      id: 'p1',
      tweetId: 't1',
      cartoonId: 'c1',
      text: 'x',
      imageUrl: '/images/referenced.png',
      type: 'organic',
      postedAt: Date.now(),
      engagement: { likes: 0, retweets: 0, replies: 0, views: 0, lastChecked: 0 },
    } as Post])

    const janitor = new Janitor({
      dataDir: dir,
      eventLogPath: join(dir, 'events.jsonl'),
      eventLogMaxBytes: 1 << 30,
      eventLogKeepLines: 10,
      mediaMaxAgeMs: 7 * DAY,
      mediaPressureAgeMs: 1 * DAY,
      diskPressureThreshold: 0.5,
      r2Enabled: false,
      postsStore,
      getDiskUsage: async () => 0.9,
    })

    await janitor.sweep()

    const { access } = await import('fs/promises')
    await expect(access(file)).rejects.toThrow()

    const posts = (await postsStore.read()) ?? []
    expect(posts[0].imageUrl).toBeUndefined()
  })

  it('skips age sweep when R2 disabled and no pressure', async () => {
    const DAY = 24 * 3600 * 1000
    const oldFile = await seedFile('images', 'old.png', 30 * DAY)
    const janitor = new Janitor({
      dataDir: dir,
      eventLogPath: join(dir, 'events.jsonl'),
      eventLogMaxBytes: 1 << 30,
      eventLogKeepLines: 10,
      mediaMaxAgeMs: 7 * DAY,
      mediaPressureAgeMs: 1 * DAY,
      diskPressureThreshold: 0.9,
      r2Enabled: false,
      getDiskUsage: async () => 0.1,
    })
    await janitor.sweep()
    const { access } = await import('fs/promises')
    await access(oldFile) // should not throw
  })

  it('nulls out videoUrl as well as imageUrl under pressure when R2 disabled', async () => {
    const DAY = 24 * 3600 * 1000
    const imgFile = await seedFile('images', 'vid-post.png', 2 * DAY)
    const vidFile = await seedFile('videos', 'vid-post.mp4', 2 * DAY)
    const postsPath = join(dir, 'posts.json')
    const postsStore = new JsonStore<Post[]>(postsPath)
    await postsStore.write([{
      id: 'p2',
      tweetId: 't2',
      cartoonId: 'c2',
      text: 'y',
      imageUrl: '/images/vid-post.png',
      videoUrl: '/videos/vid-post.mp4',
      type: 'organic',
      postedAt: Date.now(),
      engagement: { likes: 0, retweets: 0, replies: 0, views: 0, lastChecked: 0 },
    } as Post])

    const janitor = new Janitor({
      dataDir: dir,
      eventLogPath: join(dir, 'events.jsonl'),
      eventLogMaxBytes: 1 << 30,
      eventLogKeepLines: 10,
      mediaMaxAgeMs: 7 * DAY,
      mediaPressureAgeMs: 1 * DAY,
      diskPressureThreshold: 0.5,
      r2Enabled: false,
      postsStore,
      getDiskUsage: async () => 0.9,
    })

    await janitor.sweep()

    const { access } = await import('fs/promises')
    await expect(access(imgFile)).rejects.toThrow()
    await expect(access(vidFile)).rejects.toThrow()

    const posts = (await postsStore.read()) ?? []
    expect(posts[0].imageUrl).toBeUndefined()
    expect(posts[0].videoUrl).toBeUndefined()
  })

  it('does not null URLs from unrelated subdirs sharing a basename', async () => {
    const DAY = 24 * 3600 * 1000
    // Delete /images/shared.png (old) but keep /bid-images/shared.png (fresh)
    await seedFile('images', 'shared.png', 2 * DAY)
    await seedFile('bid-images', 'shared.png', 0) // fresh, won't be deleted
    const postsPath = join(dir, 'posts.json')
    const postsStore = new JsonStore<Post[]>(postsPath)
    await postsStore.write([{
      id: 'p3',
      tweetId: 't3',
      cartoonId: 'c3',
      text: 'z',
      imageUrl: '/bid-images/shared.png',   // different subdir
      type: 'organic',
      postedAt: Date.now(),
      engagement: { likes: 0, retweets: 0, replies: 0, views: 0, lastChecked: 0 },
    } as Post])

    const janitor = new Janitor({
      dataDir: dir,
      eventLogPath: join(dir, 'events.jsonl'),
      eventLogMaxBytes: 1 << 30,
      eventLogKeepLines: 10,
      mediaMaxAgeMs: 7 * DAY,
      mediaPressureAgeMs: 1 * DAY,
      diskPressureThreshold: 0.5,
      r2Enabled: false,
      postsStore,
      getDiskUsage: async () => 0.9,
    })

    await janitor.sweep()

    const posts = (await postsStore.read()) ?? []
    expect(posts[0].imageUrl).toBe('/bid-images/shared.png')
  })
})
