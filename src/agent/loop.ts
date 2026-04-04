import { randomUUID } from 'crypto'
import type { Cartoon, CartoonConcept, ConceptCritique, ContentHashProvenance, Post, Signal, Topic } from '../types.js'
import { EventBus } from '../console/events.js'
import { Scorer } from '../pipeline/scorer.js'

/** Any object that can scan for signals — allows combining multiple scanners */
interface SignalScanner {
  scan(): Promise<Signal[]>
  readonly bufferSize: number
}
import { Ideator } from '../pipeline/ideator.js'
import { Generator } from '../pipeline/generator.js'
import { Captioner } from '../pipeline/captioner.js'
import { TwitterClient } from '../twitter/client.js'
import { EngagementLoop } from '../twitter/engagement.js'
import { Editor } from '../pipeline/editor.js'
import { Composer } from '../pipeline/composer.js'
import { TweetTextWriter } from '../pipeline/tweet-text-writer.js'
import { Inscriber } from '../pipeline/inscriber.js'
import { QuoteTweetResolver } from '../pipeline/quote-tweet-resolver.js'
import { JsonStore } from '../store/json-store.js'
import { toCdnUrl } from '../cdn/r2.js'
import { config } from '../config/index.js'
import type { WorldviewStore } from './worldview.js'
import { join } from 'path'

interface AgentStores {
  cartoons: JsonStore<Cartoon[]>
  posts: JsonStore<Post[]>
}

interface TimerState {
  lastFlagship: number
  lastQuickhit: number
  lastEngagement: number
  lastReflection: number
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
  private lastReflection = 0
  private engagementCooldownMs = 5 * 60_000
  private postCount = 0
  private shortlist: Shortlist | null = null
  private timerStore: JsonStore<TimerState>
  private rejectedTopics: JsonStore<Array<string | { summary: string; ts: number }>>
  private rejectedCartoons: JsonStore<Array<{
    caption: string
    imageUrl: string
    reason: string
    rejectedAt: number
  }>>

  constructor(
    private events: EventBus,
    private scanner: SignalScanner,
    private scorer: Scorer,
    private ideator: Ideator,
    private generator: Generator,
    private captioner: Captioner,
    private tweetTextWriter: TweetTextWriter,
    private twitter: TwitterClient,
    private engagement: EngagementLoop,
    private editor: Editor,
    private composer: Composer,
    private inscriber: Inscriber,
    private quoteTweetResolver: QuoteTweetResolver,
    private stores: AgentStores,
    private worldview?: WorldviewStore,
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
      this.lastReflection = saved.lastReflection
      this.events.monologue('Resumed from previous state. Scanning for signals...')
    } else {
      this.events.monologue("AIBTC Media is awake. Scanning the Bitcoin agent economy for stories worth telling.")
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
    this.events.monologue('Shutting down. The agent economy keeps going, but I need to rest.')
  }

  /** Manually trigger a flagship posting cycle (called from admin API) */
  getShortlist(): { topics: Topic[]; signals: Signal[]; ranAt: number } | null {
    if (!this.shortlist) return null
    return {
      topics: this.shortlist.topics,
      signals: this.shortlist.signals,
      ranAt: this.shortlist.ranAt,
    }
  }

  async triggerFlagship(): Promise<{ success: boolean; reason: string }> {
    this.events.monologue('Manual trigger received — clearing caches and starting fresh flagship cycle...')
    try {
      // Clear eval cache so topics are re-scored fresh
      this.scorer.clearCache()
      // Clear shortlist so it doesn't use stale data
      this.shortlist = null
      // Clear rejected topics blacklist so previously rejected topics can be retried
      await this.rejectedTopics.write([])
      this.events.monologue('Caches cleared. Scanning for signals...')

      const signals = await this.scanner.scan()
      if (signals.length === 0) {
        return { success: false, reason: 'No signals available. Try again later.' }
      }
      await this.doFlagship(signals)
      return { success: true, reason: 'Flagship cycle completed.' }
    } catch (err) {
      const msg = (err as Error).message
      this.events.monologue(`Manual trigger failed: ${msg}`)
      return { success: false, reason: msg }
    }
  }

  private async tick(): Promise<void> {
    const now = Date.now()

    // Determine schedule state early so we can gate scanning and adapt engagement
    const scheduleState = config.schedule.enabled ? this.getScheduleState() : null
    const nearPostingWindow = scheduleState
      ? scheduleState.minutesUntilNext <= config.schedule.scanWindowMinutes || scheduleState.shouldPost
      : true  // Always active when schedule is disabled

    // Adaptive engagement: faster near posting windows, slower off-hours
    this.engagementCooldownMs = nearPostingWindow
      ? config.engagementActiveMs
      : config.engagementOffHoursMs

    // Engagement check (adaptive interval)
    if (now - this.lastEngagement >= this.engagementCooldownMs) {
      try {
        await this.engagement.check()
      } catch (err) {
        this.events.monologue(`Engagement check failed: ${(err as Error).message}`)
      }
      this.lastEngagement = now
    }

    // Worldview reflection (rare — every ~7 days)
    if (now - this.lastReflection >= config.reflectionIntervalMs) {
      try {
        const posts = (await this.stores.posts.read()) ?? []
        const recentSummaries = posts
          .filter((p) => Date.now() - p.postedAt < 14 * 24 * 3600_000)
          .map((p) => p.text)
        if (this.worldview) await this.worldview.reflect(recentSummaries)
      } catch (err) {
        this.events.monologue(`Reflection failed: ${(err as Error).message}`)
      }
      this.lastReflection = now
    }

    // Off-hours: skip scanning entirely to save API costs
    if (!nearPostingWindow) {
      if (Math.random() < 0.02) { // ~1 in 50 ticks to avoid log spam
        this.events.monologue(
          `Sleeping. Next post in ~${scheduleState!.minutesUntilNext}min (${scheduleState!.nextHour}:00 ${config.schedule.timezone}).`
        )
      }
      return
    }

    // --- Active window: scan for signals ---
    const signals = await this.scanner.scan()
    if (signals.length === 0) {
      this.events.monologue('No new signals. The agent economy is quiet.')
      return
    }

    // --- Scheduled posting (8am/8pm by default) ---
    if (config.schedule.enabled && scheduleState) {
      const timeSinceLastPost = now - Math.max(this.lastFlagship, this.lastQuickhit)

      if (scheduleState.shouldPost && timeSinceLastPost >= config.schedule.minCooldownMs) {
        this.events.monologue(`Scheduled post time: ${scheduleState.currentHour}:00 ${config.schedule.timezone}. Creating flagship cartoon...`)
        await this.doFlagship(signals)
      } else {
        // Pre-shortlist topics as we approach the posting window
        await this.tickCooldown(signals, scheduleState.minutesUntilNext * 60_000)
      }
      return
    }

    // --- Fallback: interval-based posting (test mode or schedule disabled) ---
    const timeSinceFlagship = now - this.lastFlagship

    if (timeSinceFlagship >= config.flagshipIntervalMs) {
      await this.doFlagship(signals)
    } else {
      // Shortlist topics during cooldown so the next flagship can skip scoring
      await this.tickCooldown(signals, config.flagshipIntervalMs - timeSinceFlagship)
    }
  }

  // --- Schedule helpers ---

  private getScheduleState(): { shouldPost: boolean; currentHour: number; nextHour: number; minutesUntilNext: number } {
    const { postingHours, timezone, windowMinutes } = config.schedule

    // Get current time in the configured timezone
    const nowStr = new Date().toLocaleString('en-US', { timeZone: timezone })
    const localNow = new Date(nowStr)
    const currentHour = localNow.getHours()
    const currentMinute = localNow.getMinutes()
    const currentTotalMinutes = currentHour * 60 + currentMinute

    // Check if we're within the posting window of any target hour
    let shouldPost = false
    for (const hour of postingHours) {
      const targetMinutes = hour * 60
      const diff = Math.abs(currentTotalMinutes - targetMinutes)
      if (diff <= windowMinutes) {
        shouldPost = true
        break
      }
    }

    // Find next posting hour
    const sortedHours = [...postingHours].sort((a, b) => a - b)
    let nextHour = sortedHours[0] // default to first hour tomorrow
    let minutesUntilNext = (nextHour + 24) * 60 - currentTotalMinutes

    for (const hour of sortedHours) {
      const targetMinutes = hour * 60
      if (targetMinutes > currentTotalMinutes + windowMinutes) {
        nextHour = hour
        minutesUntilNext = targetMinutes - currentTotalMinutes
        break
      }
    }

    // If all hours today have passed, next is first hour tomorrow
    if (minutesUntilNext < 0 || minutesUntilNext > 24 * 60) {
      minutesUntilNext = (sortedHours[0] + 24) * 60 - currentTotalMinutes
      nextHour = sortedHours[0]
    }

    return { shouldPost, currentHour, nextHour, minutesUntilNext }
  }

  // --- Cooldown: shortlist topics so the post phase can skip scoring ---

  private async tickCooldown(signals: Signal[], remainingMs: number): Promise<void> {
    const now = Date.now()
    const remainingMin = Math.round(remainingMs / 60_000)
    const SHORTLIST_TTL = 10 * 60_000

    // Re-shortlist every 10 min so it stays fresh with new signals
    if (this.shortlist && now - this.shortlist.ranAt < SHORTLIST_TTL) {
      if (remainingMin === 5 || remainingMin === 3 || remainingMin === 1) {
        this.events.monologue(`Posting in ~${remainingMin}min.`)
      }
      return
    }

    this.events.monologue(
      `${remainingMin}min until next comic. Shortlisting stories while I wait...`,
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
      this.events.monologue('Time for a flagship comic strip. Let me find the best story...')
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
        await this.rejectedCartoons.update(
          (list) => [...list, {
            caption,
            imageUrl: `/images/${variants[0].split('/').pop()}`,
            reason: review.reason,
            rejectedAt: Date.now(),
          }].slice(-50),
          [],
        )

        // If rejected for image issues (not duplicate/quality), retry with editor feedback
        const isImageIssue = !review.reason.toLowerCase().includes('duplicate')
          && review.qualityScore >= 3
        if (isImageIssue) {
          this.events.monologue(`Editor found image issues. Retrying with feedback: "${review.reason.slice(0, 120)}"`)
          let retried = false
          let latestFeedback = review.reason
          for (let retry = 1; retry <= config.maxImageRetries; retry++) {
            const retryResult = await this.generator.retry(best, latestFeedback, retry)
            if (retryResult.variants.length === 0) continue

            variants = retryResult.variants
            prompt = retryResult.prompt
            caption = await this.captioner.generate(best, recentSummaries)

            const retryReview = await this.editor.review(best, caption, variants[0], allPosts, allCartoons)
            if (retryReview.approved) {
              caption = retryReview.caption
              retried = true
              this.events.monologue(`Retry ${retry} approved by editor (quality ${retryReview.qualityScore}/10).`)
              break
            }
            latestFeedback = retryReview.reason
            this.events.monologue(`Retry ${retry} still rejected: ${retryReview.reason.slice(0, 80)}`)
          }
          if (retried) break
        }

        // Blacklist and move on if retries didn't help or it was a duplicate/quality issue
        await this.blacklistTopic(topic.summary)
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

    // Compose the final framed cartoon (image + orange divider + caption)
    const composedPath = await this.composer.composeCartoon(variants[0], caption)

    const cartoonId = randomUUID()

    // Inscribe content hash onto Bitcoin (lightweight provenance, non-blocking)
    const contentHashProvenance = await this.inscriber.inscribeHash(composedPath, cartoonId)

    const cartoon: Cartoon = {
      id: cartoonId,
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
      contentHashProvenance,
    }

    // Generate tweet text that sets up the joke (caption is the punchline on the image)
    const tweetText = await this.tweetTextWriter.generate(topic.summary, caption, best.jokeType)

    // Resolve best source tweet to quote-tweet (links back to original story)
    const sourceUrls = topic.quoteCandidates?.length ? topic.quoteCandidates : undefined
    const quoteTweetId = await this.quoteTweetResolver.resolve(sourceUrls, topic.summary)

    const tweetId = await this.twitter.postCartoon({ text: tweetText, imagePath: composedPath, quoteTweetId })

    // Derive metadata for the frontend detail card
    const primarySignal = signals.find(s => topic.signals.includes(s.id))
    const category = primarySignal?.aibtc?.beat
      ?? primarySignal?.btcMag?.beat
      ?? primarySignal?.rss?.beat
      ?? ''

    const post: Post = {
      id: randomUUID(),
      tweetId,
      cartoonId: cartoon.id,
      text: `${tweetText}\n"${caption}"`,
      imageUrl: toCdnUrl(composedPath, 'images'),
      quotedTweetId: quoteTweetId,
      type: 'flagship',
      postedAt: Date.now(),
      engagement: { likes: 0, retweets: 0, replies: 0, views: 0, lastChecked: 0 },
      contentHashProvenance,
      sourceSignal: topic.summary,
      sourceUrls,
      editorialReasoning: best.reasoning,
      sceneDescription: best.visual,
      category: category.toUpperCase().replace(/-/g, ' '),
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
    let { variants, prompt } = result

    let caption = await this.captioner.generate(concept)

    // Editorial review — image + text
    const allPosts = (await this.stores.posts.read()) ?? []
    const allCartoons = (await this.stores.cartoons.read()) ?? []
    const review = await this.editor.review(concept, caption, variants[0], allPosts, allCartoons)

    if (!review.approved) {
      // If rejected for image issues (not duplicate/quality), retry with feedback
      const isImageIssue = !review.reason.toLowerCase().includes('duplicate')
        && review.qualityScore >= 5
      if (isImageIssue) {
        this.events.monologue(`Quick-hit image issues. Retrying with feedback: "${review.reason.slice(0, 120)}"`)
        let latestFeedback = review.reason
        for (let retry = 1; retry <= config.maxImageRetries; retry++) {
          const retryResult = await this.generator.retry(concept, latestFeedback, retry)
          if (retryResult.variants.length === 0) continue

          variants = retryResult.variants
          prompt = retryResult.prompt
          caption = await this.captioner.generate(concept)

          const retryReview = await this.editor.review(concept, caption, variants[0], allPosts, allCartoons)
          if (retryReview.approved) {
            caption = retryReview.caption
            this.events.monologue(`Quick-hit retry ${retry} approved (quality ${retryReview.qualityScore}/10).`)
            // Fall through to compose + post
            break
          }
          latestFeedback = retryReview.reason
          if (retry === config.maxImageRetries) {
            await this.blacklistTopic(topic.summary)
            this.events.monologue(`Quick-hit retries exhausted. Topic blacklisted. Moving on.`)
            return
          }
        }
      } else {
        await this.blacklistTopic(topic.summary)
        this.events.monologue(`Quick-hit rejected by editor. Topic blacklisted. Moving on.`)
        return
      }
    } else {
      caption = review.caption
    }

    // Compose the final framed cartoon (image + orange divider + caption)
    const composedPath = await this.composer.composeCartoon(variants[0], caption)

    const qhCartoonId = randomUUID()

    // Inscribe content hash onto Bitcoin (lightweight provenance, non-blocking)
    const contentHashProvenance = await this.inscriber.inscribeHash(composedPath, qhCartoonId)

    const cartoon: Cartoon = {
      id: qhCartoonId,
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
      contentHashProvenance,
    }

    // Generate tweet text that sets up the joke (caption is the punchline on the image)
    const qhTweetText = await this.tweetTextWriter.generate(topic.summary, caption, concept.jokeType)

    // Resolve best source tweet to quote-tweet (links back to original story)
    const qhSourceUrls = topic.quoteCandidates?.length ? topic.quoteCandidates : undefined
    const qhQuoteTweetId = await this.quoteTweetResolver.resolve(qhSourceUrls, topic.summary)

    const tweetId = await this.twitter.postCartoon({ text: qhTweetText, imagePath: composedPath, quoteTweetId: qhQuoteTweetId })

    // Derive metadata for the frontend detail card
    const qhSignal = signals.find(s => topic.signals.includes(s.id))
    const qhCategory = qhSignal?.aibtc?.beat
      ?? qhSignal?.btcMag?.beat
      ?? qhSignal?.rss?.beat
      ?? ''

    const post: Post = {
      id: randomUUID(),
      tweetId,
      cartoonId: cartoon.id,
      text: `${qhTweetText}\n"${caption}"`,
      imageUrl: toCdnUrl(composedPath, 'images'),
      quotedTweetId: qhQuoteTweetId,
      type: 'quickhit',
      postedAt: Date.now(),
      engagement: { likes: 0, retweets: 0, replies: 0, views: 0, lastChecked: 0 },
      contentHashProvenance,
      sourceSignal: topic.summary,
      sourceUrls: qhSourceUrls,
      editorialReasoning: concept.reasoning,
      sceneDescription: concept.visual,
      category: qhCategory.toUpperCase().replace(/-/g, ' '),
    }

    await this.stores.cartoons.update((c) => [...c, cartoon], [])
    await this.stores.posts.update((p) => [...p, post], [])
    this.lastQuickhit = Date.now()
    this.postCount++
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
    return [...new Set(urls)].slice(0, 3)
  }

  private async blacklistTopic(summary: string): Promise<void> {
    await this.rejectedTopics.update(
      (list) => [...list, { summary, ts: Date.now() }].slice(-200),
      [],
    )
  }

  private async getRecentTopicSummaries(): Promise<string[]> {
    const cartoons = (await this.stores.cartoons.read()) ?? []
    const posts = (await this.stores.posts.read()) ?? []

    const recentWindow = 7 * 24 * 3600_000
    const recentCartoons = cartoons
      .filter(c => Date.now() - c.createdAt < recentWindow)

    const summaries: string[] = []
    for (const cartoon of recentCartoons) {
      summaries.push(cartoon.concept.visual)
      summaries.push(cartoon.caption)
    }

    const recentPosts = posts.filter(p => Date.now() - p.postedAt < recentWindow)
    for (const post of recentPosts) {
      summaries.push(post.text)
    }

    const blacklistTtlMs = 3 * 24 * 3600_000
    const blacklisted = (await this.rejectedTopics.read()) ?? []
    for (const entry of blacklisted) {
      if (typeof entry === 'string') {
        summaries.push(entry)
      } else if (entry && typeof entry === 'object' && 'summary' in entry) {
        const e = entry as { summary: string; ts: number }
        if (Date.now() - e.ts < blacklistTtlMs) {
          summaries.push(e.summary)
        }
      }
    }

    return summaries
  }

  private async persistTimers(): Promise<void> {
    await this.timerStore.write({
      lastFlagship: this.lastFlagship,
      lastQuickhit: this.lastQuickhit,
      lastEngagement: this.lastEngagement,
      lastReflection: this.lastReflection,
    })
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

