import { createHash } from 'crypto'
import { JsonStore } from '../store/json-store.js'

interface CacheEntry<T> {
  key: string
  value: T
  createdAt: number
  expiresAt: number
  hitCount: number
}

export class Cache<T = unknown> {
  private store = new Map<string, CacheEntry<T>>()
  private persistence: JsonStore<Record<string, CacheEntry<T>>>

  constructor(
    private name: string,
    private maxSize: number,
    persistPath: string,
  ) {
    this.persistence = new JsonStore(persistPath)
  }

  static key(input: string): string {
    return createHash('sha256').update(input).digest('hex').slice(0, 16)
  }

  get(key: string): T | null {
    const entry = this.store.get(key)
    if (!entry) return null
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key)
      return null
    }
    entry.hitCount++
    return entry.value
  }

  set(key: string, value: T, ttlMs: number): void {
    if (this.store.size >= this.maxSize) this.evict()
    this.store.set(key, {
      key,
      value,
      createdAt: Date.now(),
      expiresAt: Date.now() + ttlMs,
      hitCount: 0,
    })
  }

  has(key: string): boolean {
    return this.get(key) !== null
  }

  private evict(): void {
    // Remove expired first
    const now = Date.now()
    for (const [k, v] of this.store) {
      if (now > v.expiresAt) this.store.delete(k)
    }
    // If still over capacity, remove least-hit entries
    if (this.store.size >= this.maxSize) {
      const sorted = [...this.store.entries()].sort(
        (a, b) => a[1].hitCount - b[1].hitCount,
      )
      const toRemove = sorted.slice(0, Math.floor(this.maxSize * 0.2))
      for (const [k] of toRemove) this.store.delete(k)
    }
  }

  async persist(): Promise<void> {
    const data = Object.fromEntries(this.store)
    await this.persistence.write(data)
  }

  async restore(): Promise<void> {
    const data = await this.persistence.read()
    if (!data) return
    const now = Date.now()
    for (const [k, v] of Object.entries(data)) {
      if (now < v.expiresAt) this.store.set(k, v)
    }
  }

  get size(): number {
    return this.store.size
  }

  clear(): void {
    this.store.clear()
  }
}
