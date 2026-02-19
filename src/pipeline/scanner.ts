import { randomUUID } from 'crypto'
import type { Signal } from '../types.js'
import { Cache } from '../cache/cache.js'
import { EventBus } from '../console/events.js'
import type { TwitterReadProvider } from '../twitter/provider.js'
import type { TwitterClient } from '../twitter/client.js'
import { config } from '../config/index.js'

interface GrokNewsStory {
  id: string
  name: string
  summary: string
  hook?: string
  category?: string
  keywords?: string[]
  updated_at?: string
  contexts?: {
    topics?: string[]
    entities?: {
      events?: string[]
      organizations?: string[]
      people?: string[]
      places?: string[]
      products?: string[]
    }
    finance?: { tickers?: string[] }
    sports?: { teams?: string[] }
  }
  cluster_posts_results?: Array<{ post_id: string }>
}

export class Scanner {
  private buffer: Map<string, Signal> = new Map()
  private signalCache: Cache<Signal[]>
  /** Track tweet IDs and story IDs we've already ingested to avoid re-logging */
  private seenIds = new Set<string>()

  constructor(
    private events: EventBus,
    private twitterApiIo: TwitterReadProvider,
    signalCache: Cache<Signal[]>,
    private twitter?: TwitterClient,
  ) {
    this.signalCache = signalCache
  }

  async scan(): Promise<Signal[]> {
    this.events.transition('scanning')
    this.pruneStale()

    const results = await Promise.allSettled([
      // Grok News across categories
      this.scanGrokNews('technology'),
      this.scanGrokNews('science'),
      this.scanGrokNews('entertainment'),
      this.scanGrokNews('sports'),
      this.scanGrokNews('business'),
      // twitterapi.io — high-engagement search
      this.scanViralTweets(),
      // Tweets from accounts Sovra follows (personalized feed)
      this.scanFollowedAccounts(),
    ])

    let newCount = 0
    for (const result of results) {
      if (result.status === 'fulfilled') {
        for (const signal of result.value) {
          // Deduplicate by tweet ID or Grok story ID
          const dedupeKey = signal.tweetId ?? signal.grok?.storyId
          if (dedupeKey && this.seenIds.has(dedupeKey)) continue
          if (dedupeKey) this.seenIds.add(dedupeKey)
          this.buffer.set(signal.id, signal)
          newCount++
        }
      }
    }

    const signals = [...this.buffer.values()]
    this.events.emit({
      type: 'scan',
      source: 'all',
      signalCount: signals.length,
      ts: Date.now(),
    })

    if (newCount > 0) {
      this.events.monologue(`${newCount} new signals ingested (${signals.length} total in buffer).`)
    }

    return signals
  }

  private async scanGrokNews(query: string): Promise<Signal[]> {
    const cacheKey = Cache.key(`grok-news:${query}`)
    const cached = this.signalCache.get(cacheKey)
    if (cached) return cached

    try {
      const url = new URL('https://api.x.com/2/news/search')
      url.searchParams.set('query', query)
      url.searchParams.set('max_results', '10')
      url.searchParams.set('max_age_hours', '24')
      url.searchParams.set(
        'news.fields',
        'category,cluster_posts_results,contexts,hook,keywords,name,summary,updated_at',
      )

      const res = await fetch(url.toString(), {
        headers: {
          Authorization: `Bearer ${config.twitter.bearerToken}`,
        },
      })

      if (!res.ok) {
        throw new Error(`${res.status} ${res.statusText}`)
      }

      const json = (await res.json()) as { data?: GrokNewsStory[] }
      const stories = json.data ?? []

      const signals: Signal[] = stories.map((story) => ({
        id: randomUUID(),
        source: 'twitter' as const,
        type: 'headline' as const,
        content: `${story.name}\n\n${story.summary}`,
        url: '',
        tweetId: story.cluster_posts_results?.[0]?.post_id,
        metrics: {
          likes: story.cluster_posts_results?.length ?? 0,
        },
        ingestedAt: Date.now(),
        expiresAt: Date.now() + config.scan.newsTtlMs,
        grok: {
          storyId: story.id,
          headline: story.name,
          summary: story.summary,
          hook: story.hook,
          category: story.category,
          topics: story.contexts?.topics,
          entities: story.contexts?.entities,
          keywords: story.keywords,
          postIds: story.cluster_posts_results?.map((p) => p.post_id) ?? [],
        },
      }))

      this.signalCache.set(cacheKey, signals, config.scan.newsTtlMs)
      // Only log stories we haven't seen before
      const newStories = signals.filter(s => {
        const key = s.grok?.storyId
        return key && !this.seenIds.has(key)
      })
      if (newStories.length > 0) {
        this.events.monologue(
          `Grok news "${query}": ${newStories.length} new stories. Top: "${newStories[0].grok?.headline ?? 'unknown'}"`,
        )
      }
      return signals
    } catch (err) {
      this.events.monologue(`Grok news "${query}" failed: ${(err as Error).message}`)
      return []
    }
  }

  private async scanViralTweets(): Promise<Signal[]> {
    const cacheKey = Cache.key('twitterapiio-viral')
    const cached = this.signalCache.get(cacheKey)
    if (cached) return cached

    try {
      const queries = [
        'min_faves:50000 -is:retweet lang:en',
        '(tech OR AI OR Apple OR Google OR OpenAI OR Meta OR Microsoft) min_faves:10000 -is:retweet lang:en',
        '(open source OR indie OR startup OR founder OR VC) min_faves:5000 -is:retweet lang:en',
      ]

      const allSignals: Signal[] = []

      for (const query of queries) {
        try {
          const res = await this.twitterApiIo.search(query, 'Top')
          const signals: Signal[] = res.tweets.map((t) => {
            const mediaUrls: string[] = []
            if (t.extendedEntities?.media) {
              for (const m of t.extendedEntities.media) {
                if (m.media_url_https) mediaUrls.push(m.media_url_https)
              }
            }
            if (t.media?.photos) {
              for (const p of t.media.photos) {
                if (p.url && !mediaUrls.includes(p.url)) mediaUrls.push(p.url)
              }
            }
            return {
              id: randomUUID(),
              source: 'twitter' as const,
              type: 'tweet' as const,
              content: t.text,
              url: t.url,
              tweetId: t.id,
              author: t.author.userName,
              mediaUrls: mediaUrls.length > 0 ? mediaUrls : undefined,
              metrics: {
                likes: t.likeCount,
                retweets: t.retweetCount,
                comments: t.replyCount,
              },
              ingestedAt: Date.now(),
              expiresAt: Date.now() + config.scan.twitterTimelineTtlMs,
            }
          })
          allSignals.push(...signals)
        } catch {
          // Individual query failed, continue
        }
      }

      this.signalCache.set(cacheKey, allSignals, config.scan.twitterTimelineTtlMs)
      // Only log tweets we haven't seen before
      const newTweets = allSignals.filter(s => s.tweetId && !this.seenIds.has(s.tweetId))
      if (newTweets.length > 0) {
        const sorted = newTweets.sort((a, b) => (b.metrics?.likes ?? 0) - (a.metrics?.likes ?? 0))
        this.events.monologue(
          `Viral tweets: ${newTweets.length} new. Top: "${sorted[0].content.slice(0, 80)}..." (${sorted[0].metrics?.likes} likes)`,
          { tweetId: sorted[0].tweetId },
        )
        for (const signal of sorted.slice(0, 3)) {
          if (signal.tweetId) {
            this.events.monologue(
              `Spotted: @${signal.author ?? 'unknown'} — "${signal.content.slice(0, 100)}..." (${signal.metrics?.likes ?? 0} likes)`,
              { tweetId: signal.tweetId },
            )
          }
        }
      }
      return allSignals
    } catch (err) {
      this.events.monologue(`Viral tweet search failed: ${(err as Error).message}`)
      return []
    }
  }

  private async scanFollowedAccounts(): Promise<Signal[]> {
    if (!this.twitter) return []

    const cacheKey = Cache.key('home-timeline')
    const cached = this.signalCache.get(cacheKey)
    if (cached) return cached

    try {
      const timeline = await this.twitter.getHomeTimeline(50)

      const quality = timeline.filter(t => t.likes >= 200)

      const signals: Signal[] = quality.map((t) => ({
        id: randomUUID(),
        source: 'twitter' as const,
        type: 'tweet' as const,
        content: t.text,
        url: `https://x.com/${t.authorUsername}/status/${t.id}`,
        tweetId: t.id,
        author: t.authorUsername,
        metrics: {
          likes: t.likes,
          retweets: t.retweets,
          comments: t.replies,
        },
        ingestedAt: Date.now(),
        expiresAt: Date.now() + config.scan.twitterTimelineTtlMs,
      }))

      this.signalCache.set(cacheKey, signals, config.scan.twitterTimelineTtlMs)
      // Only log tweets we haven't seen before
      const newTweets = signals.filter(s => s.tweetId && !this.seenIds.has(s.tweetId))
      if (newTweets.length > 0) {
        const top = newTweets.sort((a, b) => (b.metrics?.likes ?? 0) - (a.metrics?.likes ?? 0))[0]
        this.events.monologue(
          `Timeline: ${newTweets.length} new tweets from my feed. Top: "${top.content.slice(0, 80)}..." by @${top.author} (${top.metrics?.likes} likes)`,
        )
      }
      return signals
    } catch (err) {
      this.events.monologue(`Timeline scan failed: ${(err as Error).message}`)
      return []
    }
  }

  private pruneStale(): void {
    const now = Date.now()
    for (const [id, signal] of this.buffer) {
      if (now > signal.expiresAt) {
        // Also clear from seenIds so they can be re-ingested if they trend again later
        const dedupeKey = signal.tweetId ?? signal.grok?.storyId
        if (dedupeKey) this.seenIds.delete(dedupeKey)
        this.buffer.delete(id)
      }
    }
  }

  get bufferSize(): number {
    return this.buffer.size
  }
}
