import { createCipheriv, createDecipheriv, scryptSync, randomBytes } from 'crypto'
import pg from 'pg'
import { readFile, writeFile, readdir, mkdir, stat } from 'fs/promises'
import { join, basename, extname } from 'path'

const ALGORITHM = 'aes-256-gcm'
const SALT = 'sovra-backup-salt-v1'

const MEDIA_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.mp4'])

function deriveKey(mnemonic: string): Buffer {
  return scryptSync(mnemonic, SALT, 32)
}

function encrypt(data: string, key: Buffer): string {
  const iv = randomBytes(16)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  let encrypted = cipher.update(data, 'utf-8', 'hex')
  encrypted += cipher.final('hex')
  const authTag = cipher.getAuthTag()
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`
}

function decrypt(payload: string, key: Buffer): string {
  const [ivHex, authTagHex, encrypted] = payload.split(':')
  const iv = Buffer.from(ivHex, 'hex')
  const authTag = Buffer.from(authTagHex, 'hex')
  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(authTag)
  let decrypted = decipher.update(encrypted, 'hex', 'utf-8')
  decrypted += decipher.final('utf-8')
  return decrypted
}

export class BackupStore {
  private pool: pg.Pool
  private key: Buffer

  constructor(databaseUrl: string, mnemonic: string) {
    this.pool = new pg.Pool({
      connectionString: databaseUrl,
      ssl: { rejectUnauthorized: false },
    })
    this.key = deriveKey(mnemonic)
  }

  async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS sovra_backup (
        file_key TEXT PRIMARY KEY,
        encrypted_data TEXT NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `)
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS sovra_blobs (
        file_key TEXT PRIMARY KEY,
        data BYTEA NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `)
  }

  async backupFile(filePath: string): Promise<void> {
    try {
      const data = await readFile(filePath, 'utf-8')
      const fileKey = basename(filePath)
      const encrypted = encrypt(data, this.key)

      await this.pool.query(
        `INSERT INTO sovra_backup (file_key, encrypted_data, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (file_key) DO UPDATE SET encrypted_data = $2, updated_at = NOW()`,
        [fileKey, encrypted],
      )
    } catch {
      // File doesn't exist or can't be read — skip
    }
  }

  async backupBinary(filePath: string, prefix: string): Promise<void> {
    try {
      const data = await readFile(filePath)
      const fileKey = `${prefix}/${basename(filePath)}`

      await this.pool.query(
        `INSERT INTO sovra_blobs (file_key, data, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (file_key) DO UPDATE SET data = $2, updated_at = NOW()`,
        [fileKey, data],
      )
    } catch {
      // skip
    }
  }

  async restoreFile(filePath: string): Promise<boolean> {
    const fileKey = basename(filePath)
    const result = await this.pool.query(
      'SELECT encrypted_data FROM sovra_backup WHERE file_key = $1',
      [fileKey],
    )

    if (result.rows.length === 0) return false

    try {
      const data = decrypt(result.rows[0].encrypted_data, this.key)
      await mkdir(join(filePath, '..'), { recursive: true })
      await writeFile(filePath, data)
      return true
    } catch {
      return false
    }
  }

  private static SKIP_FILES = new Set([
    'agent-keypair.json',
  ])

  async backupAll(dataDir: string): Promise<number> {
    let count = 0
    try {
      const files = await readdir(dataDir)
      for (const file of files) {
        if (BackupStore.SKIP_FILES.has(file)) continue
        if (file.endsWith('.json') || file.endsWith('.jsonl')) {
          await this.backupFile(join(dataDir, file))
          count++
        }
      }
    } catch {
      // dataDir doesn't exist yet
    }

    for (const subdir of ['images', 'videos', 'voice', 'bid-images']) {
      try {
        const dir = join(dataDir, subdir)
        const files = await readdir(dir)
        for (const file of files) {
          const ext = extname(file).toLowerCase()
          if (!MEDIA_EXTENSIONS.has(ext) && ext !== '.mp3' && ext !== '.wav') continue
          const exists = await this.pool.query(
            'SELECT 1 FROM sovra_blobs WHERE file_key = $1',
            [`${subdir}/${file}`],
          )
          if (exists.rows.length > 0) continue
          await this.backupBinary(join(dir, file), subdir)
          count++
        }
      } catch {
        // subdir doesn't exist
      }
    }

    return count
  }

  async restoreAll(dataDir: string): Promise<number> {
    await mkdir(dataDir, { recursive: true })

    const result = await this.pool.query('SELECT file_key FROM sovra_backup')
    let count = 0
    for (const row of result.rows) {
      const restored = await this.restoreFile(join(dataDir, row.file_key))
      if (restored) count++
    }

    const blobs = await this.pool.query('SELECT file_key, data FROM sovra_blobs')
    for (const row of blobs.rows) {
      try {
        const filePath = join(dataDir, row.file_key)
        await mkdir(join(filePath, '..'), { recursive: true })
        await writeFile(filePath, row.data)
        count++
      } catch {
        // skip
      }
    }

    return count
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}
