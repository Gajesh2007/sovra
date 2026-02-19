import { readFile, writeFile, rename, mkdir } from 'fs/promises'
import { dirname } from 'path'

export class JsonStore<T> {
  constructor(private path: string) {}

  async read(): Promise<T | null> {
    try {
      const raw = await readFile(this.path, 'utf-8')
      return JSON.parse(raw) as T
    } catch {
      return null
    }
  }

  async write(data: T): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.tmp.${Date.now()}`
    await writeFile(tmp, JSON.stringify(data, null, 2))
    await rename(tmp, this.path)
  }

  async update(fn: (current: T) => T, fallback: T): Promise<T> {
    const current = await this.read()
    const next = fn(current ?? fallback)
    await this.write(next)
    return next
  }
}
