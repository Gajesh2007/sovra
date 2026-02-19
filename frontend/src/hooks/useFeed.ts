import { useState, useEffect } from 'react'
import type { LocalPost } from '../types'

export function useFeed() {
  const [posts, setPosts] = useState<LocalPost[]>([])

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch('/api/feed')
        const data: LocalPost[] = await res.json()
        setPosts(data)
      } catch {}
    }

    load()
    const interval = setInterval(load, 15_000)
    return () => clearInterval(interval)
  }, [])

  return posts
}
