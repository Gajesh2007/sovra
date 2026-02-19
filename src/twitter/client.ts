import { TwitterApi } from 'twitter-api-v2'
import { readFile } from 'fs/promises'
import { basename } from 'path'
import { randomUUID } from 'crypto'
import { toCdnUrl } from '../cdn/r2.js'
import { EventBus } from '../console/events.js'
import type { TwitterReadProvider } from './provider.js'
import { JsonStore } from '../store/json-store.js'
import { config } from '../config/index.js'
import { join } from 'path'

export interface LocalPost {
  id: string
  text: string
  imagePath: string | null
  quotedTweetId?: string
  createdAt: number
}

export class TwitterClient {
  /** Read-only client using bearer token (for Grok News only) */
  private reader: TwitterApi
  /** Read-write client using OAuth 1.0a (only when posting enabled) */
  private writer: TwitterApi
  private readProvider: TwitterReadProvider
  /** Local post store (when posting is disabled) */
  private localPosts: JsonStore<LocalPost[]>

  constructor(private events: EventBus, readProvider: TwitterReadProvider) {
    this.reader = new TwitterApi(config.twitter.bearerToken)
    this.writer = new TwitterApi({
      appKey: config.twitter.apiKey,
      appSecret: config.twitter.apiSecret,
      accessToken: config.twitter.accessToken,
      accessSecret: config.twitter.accessSecret,
    })
    this.readProvider = readProvider
    this.localPosts = new JsonStore(join(config.dataDir, 'local-posts.json'))
  }

  get raw(): TwitterApi {
    return this.reader
  }

  get provider(): TwitterReadProvider {
    return this.readProvider
  }

  async postCartoon(opts: {
    text: string
    imagePath: string
    quoteTweetId?: string
  }): Promise<string> {
    this.events.transition('posting')

    if (!config.twitter.postingEnabled) {
      const localId = randomUUID()

      this.events.emit({
        type: 'post',
        tweetId: `local-${localId}`,
        text: opts.text,
        imageUrl: toCdnUrl(opts.imagePath, 'images'),
        ts: Date.now(),
      })
      this.events.monologue(
        `[DRY RUN] Would post: "${opts.text.slice(0, 60)}..."`,
      )
      return `local-${localId}`
    }

    // Actual Twitter posting
    const imageBuffer = await readFile(opts.imagePath)
    const mediaId = await this.writer.v1.uploadMedia(imageBuffer, {
      mimeType: 'image/png',
    })

    const tweetData: Parameters<TwitterApi['v2']['tweet']>[0] = {
      text: opts.text,
      media: { media_ids: [mediaId] },
    }

    if (opts.quoteTweetId) {
      tweetData.quote_tweet_id = opts.quoteTweetId
    }

    const result = await this.writer.v2.tweet(tweetData)
    const tweetId = result.data.id

    this.events.emit({
      type: 'post',
      tweetId,
      text: opts.text,
      imageUrl: toCdnUrl(opts.imagePath, 'images'),
      ts: Date.now(),
    })

    this.events.monologue(`Posted. Tweet ID: ${tweetId}. Let's see how this one does.`)
    return tweetId
  }

  async postVideo(opts: {
    text: string
    videoPath: string
    quoteTweetId?: string
  }): Promise<string> {
    this.events.transition('posting')

    if (!config.twitter.postingEnabled) {
      const localId = randomUUID()
      this.events.emit({
        type: 'post',
        tweetId: `local-${localId}`,
        text: opts.text,
        imageUrl: toCdnUrl(opts.videoPath, 'videos'),
        ts: Date.now(),
      })
      this.events.monologue(`[DRY RUN] Would post video: "${opts.text.slice(0, 60)}..."`)
      return `local-${localId}`
    }

    // Upload video (chunked upload handled by library)
    const videoBuffer = await readFile(opts.videoPath)
    const mediaId = await this.writer.v1.uploadMedia(videoBuffer, {
      mimeType: 'video/mp4',
      type: 'tweet_video',
    })

    // Poll for video processing completion
    let processing = true
    while (processing) {
      const info = await this.writer.v1.mediaInfo(mediaId)
      const state = info.processing_info?.state
      if (state === 'succeeded' || !state) {
        processing = false
      } else if (state === 'failed') {
        throw new Error(`Video processing failed: ${JSON.stringify(info.processing_info)}`)
      } else {
        const waitSecs = info.processing_info?.check_after_secs ?? 5
        await new Promise((r) => setTimeout(r, waitSecs * 1000))
      }
    }

    const tweetData: Parameters<TwitterApi['v2']['tweet']>[0] = {
      text: opts.text,
      media: { media_ids: [mediaId] },
    }

    if (opts.quoteTweetId) {
      tweetData.quote_tweet_id = opts.quoteTweetId
    }

    const result = await this.writer.v2.tweet(tweetData)
    const tweetId = result.data.id

    this.events.emit({
      type: 'post',
      tweetId,
      text: opts.text,
      imageUrl: toCdnUrl(opts.videoPath, 'videos'),
      ts: Date.now(),
    })

    this.events.monologue(`Posted video. Tweet ID: ${tweetId}. Let's see how this one does.`)
    return tweetId
  }

  async reply(opts: { text: string; replyToId: string }): Promise<string> {
    if (!config.twitter.postingEnabled) {
      const localId = randomUUID()
      this.events.emit({
        type: 'engage',
        replyTo: opts.replyToId,
        text: opts.text,
        ts: Date.now(),
      })
      this.events.monologue(`[DRY RUN] Would reply: "${opts.text}"`)
      return `local-${localId}`
    }

    const result = await this.writer.v2.reply(opts.text, opts.replyToId)
    const tweetId = result.data.id

    this.events.emit({
      type: 'engage',
      replyTo: opts.replyToId,
      text: opts.text,
      ts: Date.now(),
    })

    return tweetId
  }

  async getMentions(sinceTimestamp?: number): Promise<
    Array<{
      id: string
      text: string
      authorUsername: string
      authorFollowers: number
      metrics: { likes: number; retweets: number; replies: number }
    }>
  > {
    try {
      const res = await this.readProvider.getMentions(
        config.twitter.username,
        sinceTimestamp,
      )

      return res.tweets.map((t) => ({
        id: t.id,
        text: t.text,
        authorUsername: t.author.userName,
        authorFollowers: t.author.followers,
        metrics: {
          likes: t.likeCount,
          retweets: t.retweetCount,
          replies: t.replyCount,
        },
      }))
    } catch {
      return []
    }
  }

  async getHomeTimeline(maxResults = 20): Promise<Array<{
    id: string
    text: string
    authorUsername: string
    authorId: string
    likes: number
    retweets: number
    replies: number
  }>> {
    try {
      const timeline = await this.writer.v2.homeTimeline({
        max_results: maxResults,
        'tweet.fields': ['public_metrics', 'author_id', 'created_at'],
        expansions: ['author_id'],
        'user.fields': ['username'],
      })

      const authors = new Map<string, string>()
      for (const user of timeline.includes?.users ?? []) {
        authors.set(user.id, user.username)
      }

      return (timeline.data?.data ?? []).map(tweet => ({
        id: tweet.id,
        text: tweet.text,
        authorUsername: authors.get(tweet.author_id ?? '') ?? 'unknown',
        authorId: tweet.author_id ?? '',
        likes: tweet.public_metrics?.like_count ?? 0,
        retweets: tweet.public_metrics?.retweet_count ?? 0,
        replies: tweet.public_metrics?.reply_count ?? 0,
      }))
    } catch (err) {
      console.error('[twitter] Home timeline failed:', (err as Error).message)
      return []
    }
  }

  async findTweetAbout(query: string): Promise<string | undefined> {
    // Extract the first ~5 meaningful words for a focused search
    const keywords = query
      .replace(/[^\w\s]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 3)
      .slice(0, 5)
      .join(' ')

    return this.readProvider.findTopTweet(keywords, 500)
  }

  async follow(userId: string): Promise<void> {
    if (!config.twitter.postingEnabled) {
      this.events.monologue(`[DRY RUN] Would follow user ${userId}`)
      return
    }
    const me = await this.writer.v2.me()
    await this.writer.v2.follow(me.data.id, userId)
  }

  async blockUser(userId: string): Promise<void> {
    if (!config.twitter.postingEnabled) {
      this.events.monologue(`[DRY RUN] Would block user ${userId}`)
      return
    }
    const me = await this.writer.v2.me()
    await this.writer.v2.block(me.data.id, userId)
  }

  async unfollow(userId: string): Promise<void> {
    if (!config.twitter.postingEnabled) {
      this.events.monologue(`[DRY RUN] Would unfollow user ${userId}`)
      return
    }
    const me = await this.writer.v2.me()
    await this.writer.v2.unfollow(me.data.id, userId)
  }

  async getFollowingCount(): Promise<number> {
    try {
      const me = await this.writer.v2.me({ 'user.fields': ['public_metrics'] })
      return me.data.public_metrics?.following_count ?? 0
    } catch {
      return 0
    }
  }

  async getFollowing(): Promise<Array<{
    id: string
    username: string
    name: string
    bio: string
    followers: number
  }>> {
    try {
      const me = await this.writer.v2.me()
      const result = await this.writer.v2.following(me.data.id, {
        max_results: 1000,
        'user.fields': ['description', 'public_metrics', 'username'],
      })
      const users: Array<{ id: string; username: string; name: string; bio: string; followers: number }> = []
      for (const user of result.data ?? []) {
        users.push({
          id: user.id,
          username: user.username,
          name: user.name,
          bio: (user as unknown as { description?: string }).description ?? '',
          followers: (user as unknown as { public_metrics?: { followers_count?: number } }).public_metrics?.followers_count ?? 0,
        })
      }
      return users
    } catch {
      return []
    }
  }

  /**
   * Walk up the reply chain from a tweet to build thread context.
   * Returns oldest-first (root → ... → parent), excluding the tweet itself.
   */
  async getThreadContext(tweetId: string, maxDepth = 5): Promise<Array<{
    author: string
    text: string
  }>> {
    const chain: Array<{ author: string; text: string }> = []
    let currentId = tweetId

    for (let i = 0; i < maxDepth; i++) {
      const tweet = await this.readProvider.getTweetById(currentId)
      if (!tweet || !tweet.isReply || !tweet.inReplyToId) break

      const parent = await this.readProvider.getTweetById(tweet.inReplyToId)
      if (!parent) break

      chain.unshift({ author: parent.author.userName, text: parent.text })
      currentId = parent.id
      if (!parent.isReply || !parent.inReplyToId) break
    }

    return chain
  }

  async getLocalPosts(): Promise<LocalPost[]> {
    return (await this.localPosts.read()) ?? []
  }
}
