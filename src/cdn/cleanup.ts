import { unlink } from 'fs/promises'
import { config } from '../config/index.js'

/**
 * Delete local media files after they have been persisted to R2.
 * No-op when R2 is disabled (files are still served via fastify static routes).
 * Accepts a mixed list of local paths, CDN URLs, null, or undefined — only
 * local paths trigger an unlink.
 */
export async function cleanupLocalIfOnR2(
  paths: Array<string | null | undefined>,
): Promise<void> {
  if (!config.r2.enabled) return

  await Promise.all(
    paths.map(async (p) => {
      if (!p) return
      if (p.startsWith('http://') || p.startsWith('https://')) return
      try {
        await unlink(p)
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code !== 'ENOENT') {
          console.warn(`[cleanup] Failed to unlink ${p}: ${(err as Error).message}`)
        }
      }
    }),
  )
}
