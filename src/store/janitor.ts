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

const MEDIA_SUBDIRS = ['images', 'videos', 'voice', 'bid-images'] as const

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
  async sweepMediaByAge(_maxAgeMs: number): Promise<SweepResult> {
    throw new Error('not implemented')
  }
  async sweep(): Promise<void> {
    throw new Error('not implemented')
  }
}
