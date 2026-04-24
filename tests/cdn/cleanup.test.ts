import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
import { mkdir, writeFile, rm, access } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

// Allow us to stub `config.r2.enabled` per-test
mock.module('../../src/config/index.js', () => ({
  config: { r2: { enabled: true }, dataDir: '.data' },
}))

import { cleanupLocalIfOnR2 } from '../../src/cdn/cleanup.js'

async function exists(p: string): Promise<boolean> {
  try { await access(p); return true } catch { return false }
}

describe('cleanupLocalIfOnR2', () => {
  let dir: string

  beforeEach(async () => {
    dir = join(tmpdir(), `sovra-cleanup-${Date.now()}-${Math.random()}`)
    await mkdir(dir, { recursive: true })
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('deletes local files when R2 is enabled', async () => {
    const f1 = join(dir, 'a.png')
    const f2 = join(dir, 'b.mp4')
    await writeFile(f1, 'x')
    await writeFile(f2, 'y')

    await cleanupLocalIfOnR2([f1, f2])

    expect(await exists(f1)).toBe(false)
    expect(await exists(f2)).toBe(false)
  })

  it('ignores non-local paths (https URLs)', async () => {
    await cleanupLocalIfOnR2(['https://cdn.example.com/a.png'])
    // No throw = pass
  })

  it('tolerates missing files', async () => {
    await cleanupLocalIfOnR2([join(dir, 'missing.png')])
    // No throw = pass
  })

  it('ignores null/undefined entries', async () => {
    await cleanupLocalIfOnR2([null, undefined, ''])
    // No throw = pass
  })
})
