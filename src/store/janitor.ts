import { readFile, writeFile, stat, rename, unlink, readdir, statfs } from 'fs/promises'
import { join } from 'path'
import type { JsonStore } from './json-store.js'
import type { Post } from '../types.js'

export interface JanitorOptions {
  dataDir: string
  eventLogPath: string
  eventLogMaxBytes: number
  eventLogKeepLines: number
  mediaMaxAgeMs: number
  mediaPressureAgeMs: number
  diskPressureThreshold: number
  r2Enabled: boolean
  postsStore?: JsonStore<Post[]>
  now?: () => number
  getDiskUsage?: (dataDir: string) => Promise<number>
}

export interface RotateResult {
  rotated: boolean
  bytesBefore?: number
  bytesAfter?: number
  linesKept?: number
}

export interface SweepResult {
  filesDeleted: number
  bytesReclaimed: number
}

export const MEDIA_SUBDIRS = ['images', 'videos', 'voice', 'bid-images'] as const

export class Janitor {
  constructor(private opts: JanitorOptions) {}

  async rotateEventLog(): Promise<RotateResult> {
    const { eventLogPath, eventLogMaxBytes, eventLogKeepLines } = this.opts
    let size: number
    try {
      size = (await stat(eventLogPath)).size
    } catch {
      return { rotated: false }
    }
    if (size <= eventLogMaxBytes) return { rotated: false }

    // Read-then-rename races with EventBus `appendFile` on the same path:
    // events written between the read and the rename are lost. Accepted because
    // rotations are hourly, the window is ~10s of ms, and lost events are debug
    // telemetry, not business data. Do not add a lock here without reason.
    const raw = await readFile(eventLogPath, 'utf-8')
    const lines = raw.trimEnd().split('\n')
    const kept = lines.slice(-eventLogKeepLines)
    const nextContent = kept.join('\n') + '\n'

    const tmp = `${eventLogPath}.rotate.${Date.now()}`
    await writeFile(tmp, nextContent)
    await rename(tmp, eventLogPath)

    const after = (await stat(eventLogPath)).size
    console.log(
      `[janitor] rotated events.jsonl: ${size} → ${after} bytes, kept ${kept.length} lines`,
    )
    return { rotated: true, bytesBefore: size, bytesAfter: after, linesKept: kept.length }
  }

  private async *forEachExpiredMedia(
    maxAgeMs: number,
  ): AsyncGenerator<{ path: string; size: number }> {
    const now = this.opts.now?.() ?? Date.now()
    for (const sub of MEDIA_SUBDIRS) {
      const subDir = join(this.opts.dataDir, sub)
      let entries
      try {
        entries = await readdir(subDir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (!entry.isFile()) continue
        const full = join(subDir, entry.name)
        try {
          const s = await stat(full)
          if (now - s.mtimeMs > maxAgeMs) yield { path: full, size: s.size }
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code
          if (code !== 'ENOENT') {
            console.warn(`[janitor] stat ${full}: ${(err as Error).message}`)
          }
        }
      }
    }
  }

  // Filled in Task 5 + Task 6:
  async sweepMediaByAge(maxAgeMs: number): Promise<SweepResult> {
    let filesDeleted = 0
    let bytesReclaimed = 0
    for await (const { path, size } of this.forEachExpiredMedia(maxAgeMs)) {
      try {
        await unlink(path)
        filesDeleted++
        bytesReclaimed += size
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code !== 'ENOENT') {
          console.warn(`[janitor] unlink ${path}: ${(err as Error).message}`)
        }
      }
    }
    if (filesDeleted > 0) {
      console.log(`[janitor] age sweep (>${maxAgeMs}ms) deleted ${filesDeleted} files (${bytesReclaimed} bytes)`)
    }
    return { filesDeleted, bytesReclaimed }
  }
  async sweep(): Promise<void> {
    await this.rotateEventLog().catch((err) => {
      console.warn(`[janitor] rotateEventLog failed: ${(err as Error).message}`)
    })

    // (a) normal age sweep — only when R2 is authoritative
    if (this.opts.r2Enabled) {
      await this.sweepMediaByAge(this.opts.mediaMaxAgeMs).catch((err) => {
        console.warn(`[janitor] age sweep failed: ${(err as Error).message}`)
      })
    }

    // (b) disk pressure
    const usage = await this.safeGetDiskUsage()
    if (usage === null) return
    if (usage <= this.opts.diskPressureThreshold) return

    console.warn(`[janitor] disk pressure ${usage.toFixed(2)} > ${this.opts.diskPressureThreshold} — aggressive sweep`)
    const deleted = await this.aggressiveSweep()
    if (!this.opts.r2Enabled && this.opts.postsStore && deleted.length > 0) {
      await this.nullOutDeletedUrls(deleted).catch((err) => {
        console.warn(`[janitor] posts.json null-out failed: ${(err as Error).message}`)
      })
    }
  }

  private async safeGetDiskUsage(): Promise<number | null> {
    if (!this.opts.getDiskUsage) return null
    try {
      return await this.opts.getDiskUsage(this.opts.dataDir)
    } catch (err) {
      console.warn(`[janitor] getDiskUsage failed: ${(err as Error).message}`)
      return null
    }
  }

  private async aggressiveSweep(): Promise<string[]> {
    const deleted: string[] = []
    for await (const { path } of this.forEachExpiredMedia(this.opts.mediaPressureAgeMs)) {
      try {
        await unlink(path)
        deleted.push(path)
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code !== 'ENOENT') {
          console.warn(`[janitor] pressure unlink ${path}: ${(err as Error).message}`)
        }
      }
    }
    if (deleted.length > 0) {
      console.warn(`[janitor] pressure sweep deleted ${deleted.length} files`)
    }
    return deleted
  }

  private async nullOutDeletedUrls(deletedPaths: string[]): Promise<void> {
    if (!this.opts.postsStore) return
    // Match on the last two path segments (<subdir>/<basename>) to avoid
    // basename collisions across subdirs. URLs in posts.json are shaped like
    // '/images/<filename>' or 'https://cdn/.../images/<filename>' — both end
    // with the same <subdir>/<basename> suffix as the on-disk paths.
    const suffixes = new Set(
      deletedPaths.map((p) => {
        const parts = p.split('/').filter(Boolean)
        return parts.slice(-2).join('/')
      }),
    )
    const hasSuffix = (url: string) => {
      const parts = url.split('/').filter(Boolean)
      return suffixes.has(parts.slice(-2).join('/'))
    }

    await this.opts.postsStore.update((posts) => {
      return posts.map((post) => {
        let changed = false
        const next = { ...post }
        if (next.imageUrl && hasSuffix(next.imageUrl)) {
          delete (next as { imageUrl?: string }).imageUrl
          changed = true
        }
        if (next.videoUrl && hasSuffix(next.videoUrl)) {
          delete (next as { videoUrl?: string }).videoUrl
          changed = true
        }
        return changed ? next : post
      })
    }, [])
  }
}

export async function getDiskUsageStatfs(dataDir: string): Promise<number> {
  const s = await statfs(dataDir)
  if (s.blocks === 0) return 0
  const free = s.bavail * s.bsize
  const total = s.blocks * s.bsize
  return (total - free) / total
}
