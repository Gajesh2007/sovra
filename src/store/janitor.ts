import { readFile, writeFile, stat, rename, unlink, readdir } from 'fs/promises'
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

  // Filled in Task 5 + Task 6:
  async sweepMediaByAge(maxAgeMs: number): Promise<SweepResult> {
    const now = this.opts.now?.() ?? Date.now()
    let filesDeleted = 0
    let bytesReclaimed = 0

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
          if (now - s.mtimeMs > maxAgeMs) {
            await unlink(full)
            filesDeleted++
            bytesReclaimed += s.size
          }
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code
          if (code !== 'ENOENT') {
            console.warn(`[janitor] stat/unlink ${full}: ${(err as Error).message}`)
          }
        }
      }
    }

    if (filesDeleted > 0) {
      console.log(`[janitor] age sweep (>${maxAgeMs}ms) deleted ${filesDeleted} files (${bytesReclaimed} bytes)`)
    }
    return { filesDeleted, bytesReclaimed }
  }
  async sweep(): Promise<void> {
    throw new Error('not implemented')
  }
}
