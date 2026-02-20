import { randomUUID } from 'crypto'
import type { Cartoon, CartoonConcept, ConceptCritique, Post, Signal, Topic } from '../types.js'
import type { ChainBid } from '../auction/types.js'
import { EventBus } from '../console/events.js'
import { Scanner } from '../pipeline/scanner.js'
import { Scorer } from '../pipeline/scorer.js'
import { Ideator } from '../pipeline/ideator.js'
import { Generator } from '../pipeline/generator.js'
import { Captioner } from '../pipeline/captioner.js'
import { TwitterClient } from '../twitter/client.js'
import { EngagementLoop } from '../twitter/engagement.js'
import { AuctionOrchestrator } from '../auction/slot.js'
import { AuctionReviewer } from '../auction/review.js'
import { Editor } from '../pipeline/editor.js'
import { JsonStore } from '../store/json-store.js'
import { toCdnUrl } from '../cdn/r2.js'
import { config } from '../config/index.js'
import type { WorldviewStore } from './worldview.js'
import type { VideoProducer } from '../video/producer.js'
import type { ContentSigner } from '../crypto/signer.js'
import { join } from 'path'

interface AgentStores {
  cartoons: JsonStore<Cartoon[]>
  posts: JsonStore<Post[]>
}

interface TimerState {
  lastFlagship: number
  lastQuickhit: number
  lastEngagement: number
  lastAuctionCheck: number
  lastReflection: number
  lastFollowerVet: number
}

interface Shortlist {
  topics: Topic[]
  signals: Signal[]
  recentSummaries: string[]
  ranAt: number
}

export class AgentLoop {
  private running = false
  private lastFlagship = 0
  private lastQuickhit = 0
  private lastEngagement = 0
  private lastAuctionCheck = 0
  private lastReflection = 0
  private lastFollowerVet = 0
  private engagementCooldownMs = 5 * 60_000
  private postCount = 0
  private shortlist: Shortlist | null = null
  private lastTimelineEngagement = 0
  private timelineEngagementIntervalMs = 15 * 60_000
  private followerVetIntervalMs = config.testMode ? 60_000 : 6 * 3600_000
  private timerStore: JsonStore<TimerState>
  private rejectedTopics: JsonStore<string[]>
  private rejectedCartoons: JsonStore<Array<{
    caption: string
    imageUrl: string
    reason: string
    rejectedAt: number
  }>>

  constructor(
    private events: EventBus,
    private scanner: Scanner,
    private scorer: Scorer,
    private ideator: Ideator,
    private generator: Generator,
    private captioner: Captioner,
    private twitter: TwitterClient,
    private engagement: EngagementLoop,
    private auction: AuctionOrchestrator,
    private auctionReviewer: AuctionReviewer,
    private editor: Editor,
    private stores: AgentStores,
    private worldview?: WorldviewStore,
    private videoProducer?: VideoProducer,
    private signer?: ContentSigner,
  ) {
    this.timerStore = new JsonStore(join(config.dataDir, 'agent-timers.json'))
    this.rejectedTopics = new JsonStore(join(config.dataDir, 'rejected-topics.json'))
    this.rejectedCartoons = new JsonStore(join(config.dataDir, 'rejected-cartoons.json'))
  }

  async start(): Promise<void> {
    this.running = true

    // Restore timer state from disk so we resume where we left off
    const saved = await this.timerStore.read()
    if (saved) {
      this.lastFlagship = saved.lastFlagship
      this.lastQuickhit = saved.lastQuickhit
      this.lastEngagement = saved.lastEngagement
      this.lastAuctionCheck = saved.lastAuctionCheck
      this.lastReflection = saved.lastReflection
      this.lastFollowerVet = saved.lastFollowerVet
      this.events.monologue('Resumed from previous state. I remember where I left off.')
    } else {
      this.events.monologue("I'm awake. Scanning the internet. Let's find something worth cartooning.")
    }

    while (this.running) {
      try {
        await this.tick()
        await this.persistTimers()
      } catch (err) {
        this.events.monologue(`Loop error: ${(err as Error).message}. Recovering...`)
      }
      await sleep(config.tickIntervalMs)
    }
  }

  stop(): void {
    this.running = false
    this.events.monologue('Shutting down. Last thoughts: the internet never sleeps, but I need to.')
  }

  private async tick(): Promise<void> {
    const signals = await this.scanner.scan()
    if (signals.length === 0) {
      this.events.monologue('Nothing new. The internet is quiet. Unusual.')
    }

    const now = Date.now()

    // Engagement check (every 5 min)
    if (now - this.lastEngagement >= this.engagementCooldownMs) {
      try {
        await this.engagement.check()
      } catch (err) {
        this.events.monologue(`Engagement check failed: ${(err as Error).message}`)
      }
      this.lastEngagement = now
    }

    // Worldview reflection + following audit (rare — every ~7 days)
    if (now - this.lastReflection >= config.reflectionIntervalMs) {
      try {
        const posts = (await this.stores.posts.read()) ?? []
        const recentSummaries = posts
          .filter((p) => Date.now() - p.postedAt < 14 * 24 * 3600_000)
          .map((p) => p.text)
        if (this.worldview) await this.worldview.reflect(recentSummaries)
        await this.engagement.auditFollowing()
      } catch (err) {
        this.events.monologue(`Reflection/audit failed: ${(err as Error).message}`)
      }
      this.lastReflection = now
    }

    // Follower vetting (every ~6h)
    if (now - this.lastFollowerVet >= this.followerVetIntervalMs) {
      try {
        await this.engagement.vetFollowers()
      } catch (err) {
        this.events.monologue(`Follower vetting failed: ${(err as Error).message}`)
      }
      this.lastFollowerVet = now
    }

    // Auction check (every 60s)
    if (now - this.lastAuctionCheck >= config.auction.pollIntervalMs) {
      try {
        await this.tickAuction()
      } catch (err) {
        this.events.monologue(`Auction tick failed: ${(err as Error).message}`)
      }
      this.lastAuctionCheck = now
    }

    // Content decisions
    if (signals.length === 0) return

    const timeSinceFlagship = now - this.lastFlagship
    const timeSinceQuickhit = now - this.lastQuickhit
    const adaptiveCooldown = this.getAdaptiveCooldown()

    if (timeSinceFlagship >= config.flagshipIntervalMs) {
      await this.doFlagship(signals)
    } else if (timeSinceQuickhit >= adaptiveCooldown) {
      await this.doQuickhit(signals)
    } else {
      await this.tickCooldown(signals, adaptiveCooldown - timeSinceQuickhit)
    }
  }

  // --- Auction ---

  private async tickAuction(): Promise<void> {
    const ready = await this.auction.shouldSettle()

    if (!ready) {
      // Not time to settle yet — just log active bids
      const bids = await this.auction.fetchBids()
      if (bids.length > 0) {
        this.events.monologue(
          `Auction active. ${bids.length} bid(s) across chains. Top: $${bids[0].amountUsdc} USDC (${bids[0].chain}).`,
        )
      }
      return
    }

    // Time to settle — fetch all bids from all chains
    const bids = await this.auction.fetchBids()

    if (bids.length === 0) {
      this.events.monologue('No active bids. Resetting settlement timer.')
      await this.auction.markSettled()
      return
    }

    const winner = await this.auctionReviewer.reviewBids(bids)

    if (winner) {
      await this.auction.settleWinner(winner)
      await this.fulfillAuction(winner)
    } else {
      this.events.monologue(
        `${bids.length} active bid(s) but none approved. They persist to the next cycle.`,
      )
      await this.auction.markSettled()
    }
  }

  private extractTweetId(text: string): string | undefined {
    const match = text.match(/(?:twitter\.com|x\.com)\/\w+\/status\/(\d+)/)
    return match?.[1]
  }

  private async fulfillAuction(winner: ChainBid): Promise<void> {
    this.events.monologue(
      `Fulfilling paid request from ${winner.bidder.slice(0, 10)}...: "${winner.requestText.slice(0, 80)}..."`,
    )

    const quoteTweetId = this.extractTweetId(winner.requestText)
    let tweetContext = ''
    const tweetMediaUrls: string[] = []
    if (quoteTweetId) {
      this.events.monologue(`Found tweet reference in bid — fetching tweet ${quoteTweetId}...`)
      try {
        const result = await this.twitter.raw.v2.singleTweet(quoteTweetId, {
          'tweet.fields': ['text', 'author_id', 'public_metrics', 'attachments'],
          expansions: ['author_id', 'attachments.media_keys'],
          'user.fields': ['username'],
          'media.fields': ['url', 'preview_image_url', 'type'],
        })
        const tweet = result.data
        const author = result.includes?.users?.[0]
        if (tweet) {
          const metrics = tweet.public_metrics
          tweetContext = `\n\n--- Referenced Tweet (by @${author?.username ?? 'unknown'}) ---\n"${tweet.text}"\nLikes: ${metrics?.like_count ?? 0} | Retweets: ${metrics?.retweet_count ?? 0}\n---`
          this.events.monologue(`Fetched tweet by @${author?.username}: "${tweet.text.slice(0, 80)}..."`)

          if (result.includes?.media) {
            for (const m of result.includes.media) {
              const url = m.url ?? m.preview_image_url
              if (url) tweetMediaUrls.push(url)
            }
            if (tweetMediaUrls.length > 0) {
              this.events.monologue(`Found ${tweetMediaUrls.length} media attachment(s) in referenced tweet`)
            }
          }
        }
      } catch (err) {
        this.events.monologue(`Could not fetch referenced tweet: ${(err as Error).message}`)
      }
    }

    const topic: Topic = {
      id: randomUUID(),
      signals: [],
      summary: `${winner.requestText}${tweetContext}`,
      scores: {
        virality: 7, visualPotential: 7, audienceBreadth: 7,
        timeliness: 5, humor: 7, worldviewAlignment: 7, composite: 7,
      },
      safety: { passed: true },
      status: 'selected',
      evaluatedAt: Date.now(),
    }

    const conceptCount = config.testMode ? 1 : 3
    const concepts = await this.ideator.ideate(topic, conceptCount)
    const { best, critique } = await this.ideator.critique(concepts)

    if (tweetMediaUrls.length > 0) {
      best.referenceImageUrls = [...new Set(tweetMediaUrls)].slice(0, 3)
    }

    let genResult = await this.generator.generate(best)
    for (let attempt = 1; attempt <= config.maxImageRetries && genResult.variants.length === 0; attempt++) {
      genResult = await this.generator.retry(best, `Attempt ${attempt} failed. Simplify.`, attempt)
    }
    if (genResult.variants.length === 0) {
      this.events.monologue('Image generation failed for paid request after all retries. Skipping.')
      return
    }
    const { variants, prompt } = genResult

    const caption = await this.captioner.generate(best)
    const labeledCaption = `${caption}\n\n[Paid request — $${winner.amountUsdc} USDC]`

    const cartoon: Cartoon = {
      id: randomUUID(),
      conceptId: best.id,
      topicId: topic.id,
      type: 'paid',
      concept: best,
      imagePrompt: prompt,
      variants,
      selectedVariant: 0,
      critique,
      caption: labeledCaption,
      createdAt: Date.now(),
    }

    // Try video pipeline
    const { tweetId, videoPath } = await this.postWithVideo(
      labeledCaption, variants[0], best, topic.summary, quoteTweetId,
    )

    const post: Post = {
      id: randomUUID(),
      tweetId,
      cartoonId: cartoon.id,
      text: labeledCaption,
      imageUrl: toCdnUrl(variants[0], 'images'),
      videoUrl: videoPath ? toCdnUrl(videoPath, 'videos') : undefined,
      quotedTweetId: quoteTweetId,
      type: 'paid',
      signature: await this.signer?.sign(labeledCaption),
      signerAddress: this.signer?.address,
      postedAt: Date.now(),
      engagement: { likes: 0, retweets: 0, replies: 0, views: 0, lastChecked: 0 },
    }

    await this.stores.cartoons.update((c) => [...c, cartoon], [])
    await this.stores.posts.update((p) => [...p, post], [])
  }

  // --- Cooldown: shortlist topics so the post phase can skip scoring ---

  private async tickCooldown(signals: Signal[], remainingMs: number): Promise<void> {
    const now = Date.now()
    const remainingMin = Math.round(remainingMs / 60_000)
    const SHORTLIST_TTL = 10 * 60_000

    // Engage with timeline tweets from people we follow (every 15 min)
    if (now - this.lastTimelineEngagement >= this.timelineEngagementIntervalMs) {
      const timelineTweets = signals.filter(s => s.source === 'twitter' && s.type === 'tweet')
      if (timelineTweets.length > 0) {
        try {
          await this.engagement.engageTimeline(timelineTweets)
        } catch (err) {
          this.events.monologue(`Timeline engagement failed: ${(err as Error).message}`)
        }
      }
      this.lastTimelineEngagement = now
    }

    // Re-shortlist every 10 min so it stays fresh with new signals
    if (this.shortlist && now - this.shortlist.ranAt < SHORTLIST_TTL) {
      // Only log countdown at 5, 3, 1 minute marks (not every 30s tick)
      if (remainingMin === 5 || remainingMin === 3 || remainingMin === 1) {
        this.events.monologue(`Posting in ~${remainingMin}min.`)
      }
      return
    }

    this.events.monologue(
      `${remainingMin}min until next post. Shortlisting stories while I wait...`,
    )

    const recentSummaries = await this.getRecentTopicSummaries()
    const topics = await this.scorer.scoreAndFilter(signals, recentSummaries)

    if (topics.length === 0) {
      this.shortlist = null
      this.events.monologue('Nothing strong enough to shortlist yet. Scanning...')
      return
    }

    this.shortlist = { topics, signals, recentSummaries, ranAt: Date.now() }
    this.events.monologue(
      `Shortlisted ${topics.length} topics. Top pick: "${topics[0].summary.slice(0, 70)}..." (score ${topics[0].scores.composite.toFixed(1)}).`,
    )
  }

  // --- Flagship ---

  private async doFlagship(signals: Signal[]): Promise<void> {
    let topics: Topic[]
    let recentSummaries: string[]

    if (this.shortlist) {
      this.events.monologue('Cooldown over. Shortlist ready — jumping straight to creation...')
      topics = this.shortlist.topics
      recentSummaries = this.shortlist.recentSummaries
      signals = this.shortlist.signals.length > 0 ? this.shortlist.signals : signals
      this.shortlist = null
    } else {
      this.events.monologue('Time for a flagship cartoon. Let me find the best topic...')
      recentSummaries = await this.getRecentTopicSummaries()
      topics = await this.scorer.scoreAndFilter(signals, recentSummaries)
    }

    if (topics.length === 0) {
      this.events.monologue('Nothing worth a flagship right now. Will try again next cycle.')
      return
    }

    // Try up to 3 topics — if the editor rejects one, try the next
    let topic = topics[0]
    let best: CartoonConcept | null = null
    let critique: ConceptCritique | null = null
    let variants: string[] = []
    let prompt = ''
    let caption = ''

    for (let ti = 0; ti < Math.min(3, topics.length); ti++) {
      topic = topics[ti]
      topic.status = 'selected'
      this.events.monologue(`Trying topic ${ti + 1}/${Math.min(3, topics.length)}: "${topic.summary.slice(0, 80)}..."`)

      const conceptCount = config.testMode ? 1 : 3
      const concepts = await this.ideator.ideate(topic, conceptCount, recentSummaries)
      const critiqueResult = await this.ideator.critique(concepts)
      best = critiqueResult.best
      critique = critiqueResult.critique

      const refImages = this.collectMediaUrls(signals, topic)
      if (refImages.length > 0) best.referenceImageUrls = refImages

      let genResult = await this.generator.generate(best)
      for (let attempt = 1; attempt <= config.maxImageRetries && genResult.variants.length === 0; attempt++) {
        genResult = await this.generator.retry(best, `Attempt ${attempt} failed. Simplify the composition.`, attempt)
      }
      if (genResult.variants.length === 0) {
        this.events.monologue('Image generation failed. Trying next topic.')
        continue
      }
      variants = genResult.variants
      prompt = genResult.prompt

      caption = await this.captioner.generate(best, recentSummaries)

      const allPosts = (await this.stores.posts.read()) ?? []
      const allCartoons = (await this.stores.cartoons.read()) ?? []
      const review = await this.editor.review(best, caption, variants[0], allPosts, allCartoons)

      if (!review.approved) {
        await this.blacklistTopic(topic.summary)
        await this.rejectedCartoons.update(
          (list) => [...list, {
            caption,
            imageUrl: `/images/${variants[0].split('/').pop()}`,
            reason: review.reason,
            rejectedAt: Date.now(),
          }].slice(-50),
          [],
        )
        this.events.monologue(`Editor rejected topic ${ti + 1}. Blacklisted. Trying next...`)
        best = null
        continue
      }

      caption = review.caption
      break
    }

    if (!best || !critique || variants.length === 0) {
      this.events.monologue('All candidate topics rejected by editor. Nothing to post this cycle.')
      return
    }

    // Find a FRESH source tweet — never quote the same tweet twice
    const quoteTweetId = await this.findFreshQuoteTweet(signals, topic)

    const cartoon: Cartoon = {
      id: randomUUID(),
      conceptId: best.id,
      topicId: topic.id,
      type: 'flagship',
      concept: best,
      imagePrompt: prompt,
      variants,
      selectedVariant: 0,
      critique,
      caption,
      createdAt: Date.now(),
    }

    // Try video pipeline
    const { tweetId, videoPath } = await this.postWithVideo(
      caption, variants[0], best, topic.summary, quoteTweetId,
    )

    const post: Post = {
      id: randomUUID(),
      tweetId,
      cartoonId: cartoon.id,
      text: caption,
      imageUrl: toCdnUrl(variants[0], 'images'),
      videoUrl: videoPath ? toCdnUrl(videoPath, 'videos') : undefined,
      quotedTweetId: quoteTweetId,
      type: 'flagship',
      signature: await this.signer?.sign(caption),
      signerAddress: this.signer?.address,
      postedAt: Date.now(),
      engagement: { likes: 0, retweets: 0, replies: 0, views: 0, lastChecked: 0 },
    }

    await this.stores.cartoons.update((c) => [...c, cartoon], [])
    await this.stores.posts.update((p) => [...p, post], [])
    this.lastFlagship = Date.now()
    this.postCount++
  }

  // --- Quick-hit ---

  private async doQuickhit(signals: Signal[]): Promise<void> {
    let topics: Topic[]
    let recentSummaries: string[]

    if (this.shortlist) {
      this.events.monologue('Cooldown over. Shortlist ready — quick-hit time.')
      topics = this.shortlist.topics
      recentSummaries = this.shortlist.recentSummaries
      signals = this.shortlist.signals.length > 0 ? this.shortlist.signals : signals
      this.shortlist = null
    } else {
      this.events.monologue('Something caught my eye. Quick-hit time.')
      recentSummaries = await this.getRecentTopicSummaries()
      topics = await this.scorer.scoreAndFilter(signals, recentSummaries)
    }

    if (topics.length === 0) return

    const topic = topics[0]
    if (topic.scores.composite < 5) {
      this.events.monologue(
        `Best topic scores ${topic.scores.composite.toFixed(1)}. Not strong enough for a quick-hit.`,
      )
      return
    }

    topic.status = 'selected'
    const concepts = await this.ideator.ideate(topic, 1)
    const concept = concepts[0]

    const refImages = this.collectMediaUrls(signals, topic)
    if (refImages.length > 0) concept.referenceImageUrls = refImages

    let result = await this.generator.generate(concept, 1)
    if (result.variants.length === 0) {
      result = await this.generator.retry(concept, 'Simplify.', 1)
    }
    if (result.variants.length === 0) return
    const { variants, prompt } = result

    let caption = await this.captioner.generate(concept)

    // Editorial review — image + text
    const allPosts = (await this.stores.posts.read()) ?? []
    const allCartoons = (await this.stores.cartoons.read()) ?? []
    const review = await this.editor.review(concept, caption, variants[0], allPosts, allCartoons)

    if (!review.approved) {
      await this.blacklistTopic(topic.summary)
      this.events.monologue(`Quick-hit rejected by editor. Topic blacklisted. Moving on.`)
      return
    }

    caption = review.caption
    const quoteTweetId = await this.findFreshQuoteTweet(signals, topic)

    const cartoon: Cartoon = {
      id: randomUUID(),
      conceptId: concept.id,
      topicId: topic.id,
      type: 'quickhit',
      concept,
      imagePrompt: prompt,
      variants,
      selectedVariant: 0,
      critique: {
        conceptId: concept.id, humor: 0, clarity: 0, shareability: 0,
        visualSimplicity: 0, overallScore: 0, critique: 'Quick-hit — no formal critique',
      },
      caption,
      createdAt: Date.now(),
    }

    // Try video pipeline
    const { tweetId, videoPath } = await this.postWithVideo(
      caption, variants[0], concept, topic.summary, quoteTweetId,
    )

    const post: Post = {
      id: randomUUID(),
      tweetId,
      cartoonId: cartoon.id,
      text: caption,
      imageUrl: toCdnUrl(variants[0], 'images'),
      videoUrl: videoPath ? toCdnUrl(videoPath, 'videos') : undefined,
      quotedTweetId: quoteTweetId,
      type: 'quickhit',
      signature: await this.signer?.sign(caption),
      signerAddress: this.signer?.address,
      postedAt: Date.now(),
      engagement: { likes: 0, retweets: 0, replies: 0, views: 0, lastChecked: 0 },
    }

    await this.stores.cartoons.update((c) => [...c, cartoon], [])
    await this.stores.posts.update((p) => [...p, post], [])
    this.lastQuickhit = Date.now()
    this.postCount++
  }

  // --- Video + posting ---

  private async postWithVideo(
    caption: string,
    imagePath: string,
    concept: CartoonConcept,
    topicSummary: string,
    quoteTweetId?: string,
  ): Promise<{ tweetId: string; videoPath: string | null }> {
    let videoPath: string | null = null

    if (this.videoProducer) {
      try {
        videoPath = await this.videoProducer.produce({
          imagePath,
          concept,
          topicSummary,
        })
      } catch (err) {
        this.events.monologue(`Video generation failed: ${(err as Error).message}. Falling back to image.`)
      }
    }

    const tweetId = videoPath
      ? await this.twitter.postVideo({ text: caption, videoPath, quoteTweetId })
      : await this.twitter.postCartoon({ text: caption, imagePath, quoteTweetId })

    return { tweetId, videoPath }
  }

  // --- Adaptive cooldown ---

  private getAdaptiveCooldown(): number {
    const { minCooldownMs, maxCooldownMs, growthFactor } = config.posting
    const cooldown = minCooldownMs * Math.pow(growthFactor, this.postCount)
    return Math.min(cooldown, maxCooldownMs)
  }

  // --- Helpers ---

  private collectMediaUrls(signals: Signal[], topic: Topic): string[] {
    const urls: string[] = []
    for (const sigId of topic.signals) {
      const signal = signals.find((s) => s.id === sigId)
      if (signal?.mediaUrls) urls.push(...signal.mediaUrls)
    }
    // Deduplicate and cap at 3 reference images
    return [...new Set(urls)].slice(0, 3)
  }

  private async blacklistTopic(summary: string): Promise<void> {
    await this.rejectedTopics.update(
      (list) => [...list, summary].slice(-500),
      [],
    )
  }

  private async getRecentTopicSummaries(): Promise<string[]> {
    const cartoons = (await this.stores.cartoons.read()) ?? []
    const posts = (await this.stores.posts.read()) ?? []

    const recentCartoons = cartoons
      .filter(c => Date.now() - c.createdAt < config.recentTopicWindowMs)

    const summaries: string[] = []
    for (const cartoon of recentCartoons) {
      summaries.push(cartoon.concept.visual)
      summaries.push(cartoon.concept.reasoning)
      summaries.push(cartoon.caption)
    }

    const recentPosts = posts.filter(p => Date.now() - p.postedAt < config.recentTopicWindowMs)
    for (const post of recentPosts) {
      summaries.push(post.text)
    }

    // Include blacklisted/rejected topics so the scorer skips them
    const blacklisted = (await this.rejectedTopics.read()) ?? []
    summaries.push(...blacklisted)

    return summaries
  }

  private async persistTimers(): Promise<void> {
    await this.timerStore.write({
      lastFlagship: this.lastFlagship,
      lastQuickhit: this.lastQuickhit,
      lastEngagement: this.lastEngagement,
      lastAuctionCheck: this.lastAuctionCheck,
      lastReflection: this.lastReflection,
      lastFollowerVet: this.lastFollowerVet,
    })
  }

  private async getUsedTweetIds(): Promise<Set<string>> {
    const used = new Set<string>()

    // Check both stores — posts.json AND local-posts.json
    const posts = (await this.stores.posts.read()) ?? []
    for (const post of posts) {
      if (post.quotedTweetId) used.add(post.quotedTweetId)
    }

    const localPosts = await this.twitter.getLocalPosts()
    for (const post of localPosts) {
      if (post.quotedTweetId) used.add(post.quotedTweetId)
    }

    return used
  }

  private async findFreshQuoteTweet(signals: Signal[], topic: Topic): Promise<string | undefined> {
    const used = await this.getUsedTweetIds()

    // Priority 1: tweet IDs from signals DIRECTLY linked to this topic
    // (these are real viral tweets the scanner found — they're relevant)
    for (const sigId of topic.signals) {
      const signal = signals.find((s) => s.id === sigId)
      if (signal?.tweetId && !used.has(signal.tweetId)) return signal.tweetId
    }

    // Priority 2: Grok cluster post IDs — tweets from the news cluster
    // These are real tweets related to the story. Pick the first unused one.
    for (const sigId of topic.signals) {
      const signal = signals.find((s) => s.id === sigId)
      if (signal?.grok?.postIds) {
        for (const postId of signal.grok.postIds) {
          if (!used.has(postId)) {
            this.events.monologue(`Using Grok cluster tweet: ${postId}`)
            return postId
          }
        }
      }
    }

    // Priority 3: search for a fresh, relevant tweet about the topic
    try {
      this.events.monologue(`Searching for quote tweet about: "${topic.summary.slice(0, 80)}..."`)
      const found = await this.twitter.findTweetAbout(topic.summary)
      if (found && !used.has(found)) {
        this.events.monologue(`Found quote tweet: ${found}`)
        return found
      }
      if (found && used.has(found)) {
        this.events.monologue(`Found tweet ${found} but already used. Skipping.`)
      } else {
        this.events.monologue('Quote tweet search returned no results.')
      }
    } catch (err) {
      this.events.monologue(`Quote tweet search failed: ${(err as Error).message}`)
    }

    this.events.monologue('No fresh tweet to quote. Posting standalone.')
    return undefined
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
