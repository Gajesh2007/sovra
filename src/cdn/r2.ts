import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3'
import { readFile, access } from 'fs/promises'
import { basename, join } from 'path'
import { config } from '../config/index.js'
import type { JsonStore } from '../store/json-store.js'
import type { Post } from '../types.js'

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
}

export type MediaPrefix = 'images' | 'videos' | 'voice' | 'bid-images'

let client: S3Client | null = null

function getClient(): S3Client {
  if (!client) {
    client = new S3Client({
      region: 'auto',
      endpoint: `https://${config.r2.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: config.r2.accessKeyId,
        secretAccessKey: config.r2.secretAccessKey,
      },
    })
  }
  return client
}

/**
 * Upload a local file to R2. Returns CDN URL on success, null on failure.
 */
export async function uploadToR2(
  localPath: string,
  prefix: MediaPrefix,
): Promise<string | null> {
  if (!config.r2.enabled) return null

  try {
    const filename = basename(localPath)
    const key = `${prefix}/${filename}`
    const ext = '.' + (filename.split('.').pop()?.toLowerCase() ?? '')
    const body = await readFile(localPath)

    await getClient().send(new PutObjectCommand({
      Bucket: config.r2.bucketName,
      Key: key,
      Body: body,
      ContentType: MIME[ext] ?? 'application/octet-stream',
      CacheControl: 'public, max-age=31536000, immutable',
    }))

    console.log(`[r2] Uploaded ${key} (${body.length} bytes)`)
    return `${config.r2.publicUrl}/${key}`
  } catch (err) {
    console.error(`[r2] Upload failed for ${localPath}:`, (err as Error).message)
    return null
  }
}

/**
 * Upload a buffer directly to R2 (for bid-image uploads).
 */
export async function uploadBufferToR2(
  buffer: Buffer,
  filename: string,
  prefix: MediaPrefix,
): Promise<string | null> {
  if (!config.r2.enabled) return null

  try {
    const key = `${prefix}/${filename}`
    const ext = '.' + (filename.split('.').pop()?.toLowerCase() ?? '')

    await getClient().send(new PutObjectCommand({
      Bucket: config.r2.bucketName,
      Key: key,
      Body: buffer,
      ContentType: MIME[ext] ?? 'application/octet-stream',
      CacheControl: 'public, max-age=31536000, immutable',
    }))

    console.log(`[r2] Uploaded ${key} (${buffer.length} bytes)`)
    return `${config.r2.publicUrl}/${key}`
  } catch (err) {
    console.error(`[r2] Buffer upload failed for ${filename}:`, (err as Error).message)
    return null
  }
}

/**
 * Resolve a local path or existing URL to a CDN URL.
 * Handles backward compatibility for old posts with local paths.
 */
export function toCdnUrl(localPathOrUrl: string, prefix: MediaPrefix): string {
  if (localPathOrUrl.startsWith('https://')) return localPathOrUrl

  const filename = basename(localPathOrUrl)
  if (config.r2.enabled) return `${config.r2.publicUrl}/${prefix}/${filename}`
  return `/${prefix}/${filename}`
}

/**
 * Check if an object exists in R2.
 */
async function existsInR2(key: string): Promise<boolean> {
  try {
    await getClient().send(new HeadObjectCommand({
      Bucket: config.r2.bucketName,
      Key: key,
    }))
    return true
  } catch {
    return false
  }
}

/**
 * Migrate old posts from local paths to R2 CDN URLs.
 * For each post with a local imageUrl/videoUrl, uploads the file to R2
 * (if not already there) and updates the post record.
 */
async function fileExists(path: string): Promise<boolean> {
  try { await access(path); return true } catch { return false }
}

async function migrateUrl(
  url: string,
  prefix: MediaPrefix,
): Promise<string | null> {
  const filename = basename(url)
  const key = `${prefix}/${filename}`

  if (await existsInR2(key)) {
    return `${config.r2.publicUrl}/${key}`
  }

  const localPath = join(config.dataDir, prefix, filename)
  if (await fileExists(localPath)) {
    return (await uploadToR2(localPath, prefix)) ?? `${config.r2.publicUrl}/${key}`
  }

  // File lost locally and not in R2 — adopt CDN URL to stop retrying
  return `${config.r2.publicUrl}/${key}`
}

export async function migratePostsToCdn(postsStore: JsonStore<Post[]>): Promise<void> {
  if (!config.r2.enabled) return

  const posts = (await postsStore.read()) ?? []
  let migrated = 0

  for (const post of posts) {
    let changed = false

    if (post.imageUrl && !post.imageUrl.startsWith('https://')) {
      const cdnUrl = await migrateUrl(post.imageUrl, 'images')
      if (cdnUrl) { post.imageUrl = cdnUrl; changed = true }
    }

    if (post.videoUrl && !post.videoUrl.startsWith('https://')) {
      const cdnUrl = await migrateUrl(post.videoUrl, 'videos')
      if (cdnUrl) { post.videoUrl = cdnUrl; changed = true }
    }

    if (changed) migrated++
  }

  if (migrated > 0) {
    await postsStore.update(() => posts, [])
    console.log(`[r2] Migrated ${migrated} posts to CDN URLs`)
  }
}
