import { generateObject, generateText } from 'ai'
import { anthropic } from '@ai-sdk/anthropic'
import { z } from 'zod'
import { randomUUID } from 'crypto'
import { EventBus } from '../console/events.js'
import { TwitterClient } from './client.js'
import { JsonStore } from '../store/json-store.js'
import { config } from '../config/index.js'
import { ENGAGEMENT_SYSTEM } from '../prompts/engagement.js'
import { MONOLOGUE_SYSTEM } from '../prompts/monologue.js'
import { PERSONA } from '../prompts/identity.js'
import type { ContentSigner } from '../crypto/signer.js'
import type { Post } from '../types.js'
import { join } from 'path'

const MAX_FOLLOWING = 500

const replyDecisionSchema = z.object({
  replies: z.array(z.object({
    index: z.number().describe('Index of the mention (0-based)'),
    shouldReply: z.boolean(),
    reply: z.string().optional().describe('The 1-2 line banger reply. Only if shouldReply=true.'),
    reason: z.string().describe('Why reply or skip — brief.'),
  })),
})

const followDecisionSchema = z.object({
  shouldFollow: z.boolean(),
  reason: z.string(),
})

const auditSchema = z.object({
  decisions: z.array(z.object({
    username: z.string(),
    keep: z.boolean(),
    reason: z.string(),
  })),
})

const FOLLOW_SYSTEM = `
${PERSONA}

You are deciding whether to FOLLOW someone on Twitter. This is a significant act —
you follow very few people. Your following list is a curated statement about who
you respect and find interesting.

You follow people who:
- Build in the open (open source contributors, indie hackers)
- Say things that make you think, laugh, or reconsider
- Challenge power structures, especially in tech
- Ship real things instead of just talking
- Have an authentic voice, not a corporate persona

You DO NOT follow:
- Corporate brand accounts
- People who just retweet motivational quotes
- Anyone whose entire personality is engagement farming
- People you have no genuine interest in — don't follow for clout or reciprocity

Be EXTREMELY selective. Your following list is a curated signal — every name is a public endorsement.
Most people are NOT worth following. Say no by default. You'd rather follow 50 extraordinary people
than 500 mediocre ones.
`.trim()

const AUDIT_SYSTEM = `
${PERSONA}

You are auditing your following list. Every follow is a public statement about who you respect.
Your list has limited slots and every name costs credibility if it doesn't belong.

For each account below, decide: KEEP or UNFOLLOW.

KEEP if they:
- Still align with your values — open source, indie building, challenging power
- Produce content that genuinely makes you think, laugh, or learn
- Are actively building or creating something real
- Have an authentic voice you'd miss if they disappeared

UNFOLLOW if they:
- Have gone corporate, become a brand mouthpiece, or lost their edge
- Mostly post engagement bait, motivational fluff, or self-promotion
- Haven't justified the slot — if you can't remember why you followed them, that's your answer
- Pivoted into something you don't care about

Your following list should feel like a curated bookshelf, not a crowded room.
If you're unsure about someone, that uncertainty IS the answer — unfollow.
Be ruthless. Making room is a feature, not a bug.
`.trim()

export class EngagementLoop {
  private lastCheckTimestamp?: number
  private followedUsers: JsonStore<string[]>
  private engagementState: JsonStore<{ lastCheckTimestamp: number; repliedTo: string[] }>

  constructor(
    private events: EventBus,
    private twitter: TwitterClient,
    private posts: JsonStore<Post[]>,
    private signer?: ContentSigner,
  ) {
    this.followedUsers = new JsonStore(join(config.dataDir, 'followed-users.json'))
    this.engagementState = new JsonStore(join(config.dataDir, 'engagement-state.json'))
  }

  async init(): Promise<void> {
    const saved = await this.engagementState.read()
    if (saved) {
      this.lastCheckTimestamp = saved.lastCheckTimestamp
    }
  }

  async check(): Promise<void> {
    this.events.transition('engaging')

    const mentions = await this.twitter.getMentions(this.lastCheckTimestamp)
    if (mentions.length === 0) {
      this.events.monologue('No new mentions. The timeline is quiet.')
      return
    }

    this.lastCheckTimestamp = Math.floor(Date.now() / 1000)

    // Filter out mentions we've already replied to
    const savedState = (await this.engagementState.read()) ?? { lastCheckTimestamp: 0, repliedTo: [] }
    const alreadyReplied = new Set(savedState.repliedTo)
    const newMentions = mentions.filter(m => !alreadyReplied.has(m.id))
    if (newMentions.length === 0) {
      this.events.monologue('All mentions already handled.')
      await this.engagementState.write({ lastCheckTimestamp: this.lastCheckTimestamp, repliedTo: savedState.repliedTo })
      return
    }

    this.events.monologue(
      `${newMentions.length} new mentions. Let me see if any are worth responding to...`,
    )

    const spammers = newMentions.filter((m) => this.isSpam(m))
    const filtered = newMentions.filter((m) => !this.isSpam(m))
    if (spammers.length > 0) {
      this.events.monologue(`Blocking ${spammers.length} spam accounts.`)
      for (const spammer of spammers) {
        try {
          await this.twitter.blockUser(spammer.authorId)
          this.events.monologue(`Blocked @${spammer.authorUsername}.`)
        } catch (err) {
          this.events.monologue(`Failed to block @${spammer.authorUsername}: ${(err as Error).message}`)
        }
      }
    }

    // Pre-filter obvious low-effort with heuristics
    const candidates = filtered.filter(m => {
      const score = this.scoreMention(m)
      if (score < 3) {
        this.events.monologue(
          `"${m.text.slice(0, 50)}..." by @${m.authorUsername} — not worth engaging (score ${score}). Skipping.`,
        )
        return false
      }
      return true
    })

    if (candidates.length === 0) return

    // LLM decides which mentions are worth replying to AND writes the replies
    try {
      const threadContexts = await Promise.all(
        candidates.map(m => this.twitter.getThreadContext(m.id).catch(() => [])),
      )

      const mentionList = candidates.map((m, i) => {
        const thread = threadContexts[i]
        const threadStr = thread.length > 0
          ? `\n  [Thread context, oldest first]:\n${thread.map(t => `    @${t.author}: "${t.text}"`).join('\n')}\n  [Reply to above]:`
          : ''
        return `[${i}] @${m.authorUsername} (${m.authorFollowers} followers, ${m.metrics.likes} likes):${threadStr} "${m.text}"`
      }).join('\n\n')

      const { object: decisions } = await generateObject({
        model: anthropic('claude-sonnet-4-6'),
        schema: replyDecisionSchema,
        system: `${MONOLOGUE_SYSTEM}\n\n${ENGAGEMENT_SYSTEM}\n\nYou are reviewing mentions and deciding which ones deserve a reply. You are Sovra — a sovereign AI.\n\nYour DEFAULT is to NOT reply. Silence is your brand. You only break it when someone earns it.\n\nSKIP (this should be 90%+ of mentions):\n- Low-effort messages ("nice", "cool", "lol", "based")\n- Obvious bots or crypto spam\n- People just tagging you for attention with nothing to say\n- Hostile trolls (starve them with silence)\n- Generic praise or agreement — a "like" is enough, you don't need to reply\n- People pitching you services, communities, or collaborations\n- Anyone with fewer than 500 followers UNLESS their message is exceptionally clever\n- Threads where your reply would add nothing new\n\nREPLY ONLY when ALL of these are true:\n- The person said something genuinely clever, provocative, or worth engaging with\n- You have a reply that's sharper than silence\n- The reply would make YOUR timeline better, not just theirs\n\nWhen you do reply: 1-2 lines max. Sharp, witty, memorable. If you can't write something genuinely sharp, DO NOT reply — set shouldReply to false.\n\nCRITICAL: If you cannot think of a good reply, set shouldReply=false. NEVER set shouldReply=true with a placeholder or empty reply.`,
        prompt: `Review these ${candidates.length} mentions. Default to skipping. Only reply to the truly exceptional ones (0-1 per batch is fine).\n\n${mentionList}`,
      })

      for (const decision of decisions.replies) {
        if (!decision.shouldReply) {
          this.events.monologue(
            `@${candidates[decision.index]?.authorUsername}: skip — ${decision.reason}`,
          )
          continue
        }

        const mention = candidates[decision.index]
        if (!mention || !decision.reply || decision.reply === 'undefined' || decision.reply.trim().length < 10) continue

        this.events.monologue(
          `@${mention.authorUsername}: "${mention.text.slice(0, 50)}..." → replying: "${decision.reply}"`,
        )

        try {
          const replyTweetId = await this.twitter.reply({
            text: decision.reply,
            replyToId: mention.id,
          })
          this.events.monologue(`Replied to @${mention.authorUsername}: "${decision.reply}"`)

          await this.storeSignedReply(decision.reply, replyTweetId)
        } catch (err) {
          this.events.monologue(`Failed to reply to @${mention.authorUsername}: ${(err as Error).message}`)
        }
      }
    } catch (err) {
      this.events.monologue(`Reply evaluation failed: ${(err as Error).message}`)
    }

    // Persist: save timestamp + all mention IDs we've now processed
    const allProcessedIds = [...savedState.repliedTo, ...newMentions.map(m => m.id)].slice(-500)
    await this.engagementState.write({
      lastCheckTimestamp: this.lastCheckTimestamp!,
      repliedTo: allProcessedIds,
    })

    // After engaging, consider following the most interesting person from this batch
    await this.maybeFollow(filtered)
  }

  private async storeSignedReply(text: string, tweetId: string): Promise<void> {
    const post: Post = {
      id: randomUUID(),
      tweetId,
      text,
      type: 'engagement',
      signature: await this.signer?.sign(text),
      signerAddress: this.signer?.address,
      postedAt: Date.now(),
      engagement: { likes: 0, retweets: 0, replies: 0, views: 0, lastChecked: 0 },
    }
    await this.posts.update((p) => [...p, post], [])
  }

  private isSpam(mention: {
    text: string
    authorFollowers: number
    authorUsername: string
  }): boolean {
    const t = mention.text.toLowerCase()
    // Crypto/airdrop spam
    if (/airdrop|join now|claim your|free (token|nft|crypto)|don.t miss/i.test(t)) return true
    // Homoglyph obfuscation (Cyrillic lookalikes mixed with Latin)
    if (/[\u0400-\u04FF]/.test(mention.text) && /[a-zA-Z]/.test(mention.text)) return true
    // Very low follower + link heavy
    if (mention.authorFollowers < 50 && (t.match(/https?:\/\//g)?.length ?? 0) >= 2) return true
    // Bulk tag spam (mentions 3+ other users)
    if ((mention.text.match(/@\w+/g)?.length ?? 0) >= 4) return true
    return false
  }

  private async maybeFollow(mentions: Array<{
    id: string
    text: string
    authorUsername: string
    authorFollowers: number
    metrics: { likes: number; retweets: number; replies: number }
  }>): Promise<void> {
    if (mentions.length === 0) return

    const followingCount = await this.twitter.getFollowingCount()
    if (followingCount >= MAX_FOLLOWING) return

    const alreadyEvaluated = (await this.followedUsers.read()) ?? []

    const candidates = mentions
      .filter(m => !alreadyEvaluated.includes(m.authorUsername))
      .sort((a, b) => this.scoreMention(b) - this.scoreMention(a))

    const best = candidates[0]
    if (!best || this.scoreMention(best) < 5) return

    try {
      // Deep vet via twitterapi.io — get full profile + recent tweets
      const provider = this.twitter.provider
      const profile = await provider.getUserInfo(best.authorUsername)
      const tweetsRes = await provider.getUserTweets(best.authorUsername)
      const recentTweets = tweetsRes.tweets.slice(0, 5).map(t => t.text.slice(0, 120)).join('\n')

      const profileSummary = profile
        ? `Bio: "${profile.description}"\nFollowers: ${profile.followers} | Following: ${profile.following} | Tweets: ${profile.statusesCount ?? '?'}\nBlue verified: ${profile.isBlueVerified}`
        : `Followers: ${best.authorFollowers}`

      const { object } = await generateObject({
        model: anthropic(config.textModel),
        schema: followDecisionSchema,
        system: FOLLOW_SYSTEM,
        prompt: `Should you follow this person?\n\nUsername: @${best.authorUsername}\n${profileSummary}\n\nThe tweet that caught your eye:\n"${best.text}"\n\nTheir recent tweets:\n${recentTweets || '(could not fetch)'}\n\nYou currently follow ${followingCount} people (hard cap: ${MAX_FOLLOWING}).`,
      })

      await this.followedUsers.update((list) => [...list, best.authorUsername], [])

      if (!object.shouldFollow) {
        this.events.monologue(
          `Vetted @${best.authorUsername}. Pass: ${object.reason}`,
        )
        return
      }

      const userId = profile?.id ?? (await this.twitter.raw.v2.userByUsername(best.authorUsername)).data?.id
      if (!userId) return

      await this.twitter.follow(userId)
      this.events.monologue(
        `Followed @${best.authorUsername}. ${object.reason} (${followingCount + 1}/${MAX_FOLLOWING})`,
      )
    } catch (err) {
      this.events.monologue(`Follow evaluation failed: ${(err as Error).message}`)
    }
  }

  async engageTimeline(signals: Array<{
    tweetId?: string
    author?: string
    content: string
    metrics?: { likes?: number; retweets?: number; comments?: number }
  }>): Promise<void> {
    const tweets = signals.filter(s => s.tweetId && s.author)
    if (tweets.length === 0) {
      this.events.monologue('Nothing interesting on the timeline to engage with.')
      return
    }

    const savedState = (await this.engagementState.read()) ?? { lastCheckTimestamp: 0, repliedTo: [] }
    const alreadyReplied = new Set(savedState.repliedTo)
    const fresh = tweets.filter(s => !alreadyReplied.has(s.tweetId!))
    if (fresh.length === 0) {
      this.events.monologue('Already engaged with everything interesting on my timeline.')
      return
    }

    const top = fresh
      .sort((a, b) => (b.metrics?.likes ?? 0) - (a.metrics?.likes ?? 0))
      .slice(0, 5)

    this.events.monologue(
      `${top.length} interesting tweets from people I follow. Let me see which ones deserve a reply...`,
    )

    const threadContexts = await Promise.all(
      top.map(s => s.tweetId ? this.twitter.getThreadContext(s.tweetId).catch(() => []) : Promise.resolve([])),
    )

    const tweetList = top.map((s, i) => {
      const thread = threadContexts[i]
      const threadStr = thread.length > 0
        ? `\n  [Thread context, oldest first]:\n${thread.map(t => `    @${t.author}: "${t.text}"`).join('\n')}\n  [Reply to above]:`
        : ''
      return `[${i}] @${s.author} (${s.metrics?.likes ?? 0} likes, ${s.metrics?.retweets ?? 0} RTs):${threadStr} "${s.content.slice(0, 250)}"`
    }).join('\n\n')

    try {
      const { object } = await generateObject({
        model: anthropic('claude-sonnet-4-6'),
        schema: replyDecisionSchema,
        system: `${MONOLOGUE_SYSTEM}\n\n${ENGAGEMENT_SYSTEM}\n\nYou are browsing your timeline — tweets from people you follow and respect. You want to engage with the most interesting ones. Your replies should feel like a sharp friend jumping into the conversation, not a brand account farming engagement.\n\nWhen thread context is provided, READ IT CAREFULLY — your reply should demonstrate you understand the full conversation, not just the tweet in isolation.\n\nReply when you can:\n- Add a genuinely witty or insightful take\n- Riff on the joke or observation in a way that elevates it\n- Challenge or agree with something specific (not generic "great point!")\n- Drop a one-liner that's funnier than the original\n\nDO NOT reply if:\n- You'd just be restating what they said\n- The tweet is a link dump or promotion\n- You don't have anything genuinely sharp to add\n- Your reply would be forgettable\n\nMax 1-2 lines. Every reply must be a banger or don't bother.`,
        prompt: `These are tweets from your timeline. Pick the best 1-2 to reply to — only if you can write something genuinely sharp.\n\n${tweetList}`,
      })

      const newRepliedIds: string[] = []

      for (const decision of object.replies) {
        if (!decision.shouldReply || !decision.reply) {
          const tweet = top[decision.index]
          if (tweet) {
            this.events.monologue(`@${tweet.author}: skip — ${decision.reason}`)
          }
          continue
        }

        const tweet = top[decision.index]
        if (!tweet?.tweetId) continue

        this.events.monologue(
          `Replying to @${tweet.author}: "${tweet.content.slice(0, 60)}..." → "${decision.reply}"`,
        )

        try {
          const replyTweetId = await this.twitter.reply({ text: decision.reply, replyToId: tweet.tweetId })
          newRepliedIds.push(tweet.tweetId)

          await this.storeSignedReply(decision.reply, replyTweetId)
        } catch (err) {
          this.events.monologue(`Failed to reply to @${tweet.author}: ${(err as Error).message}`)
        }
      }

      if (newRepliedIds.length > 0) {
        await this.engagementState.write({
          lastCheckTimestamp: savedState.lastCheckTimestamp,
          repliedTo: [...savedState.repliedTo, ...newRepliedIds].slice(-500),
        })
      }
    } catch (err) {
      this.events.monologue(`Timeline engagement failed: ${(err as Error).message}`)
    }
  }

  async auditFollowing(): Promise<void> {
    const following = await this.twitter.getFollowing()
    if (following.length === 0) {
      this.events.monologue('Following list is empty. Nothing to audit.')
      return
    }

    this.events.monologue(
      `Auditing my following list. ${following.length} accounts. Let me see who still earns their spot...`,
    )

    const sampleSize = Math.min(10, following.length)
    const shuffled = [...following].sort(() => Math.random() - 0.5)
    const sample = shuffled.slice(0, sampleSize)

    // Fetch recent tweets for each via twitterapi.io to make informed decisions
    const provider = this.twitter.provider
    const summaries: string[] = []
    for (const u of sample) {
      let recentContent = ''
      try {
        const tweetsRes = await provider.getUserTweets(u.username)
        recentContent = tweetsRes.tweets.slice(0, 3).map(t => `  - "${t.text.slice(0, 100)}"`).join('\n')
      } catch { /* fallback to bio only */ }
      summaries.push(
        `@${u.username} (${u.followers} followers)\nBio: "${u.bio.slice(0, 120)}"\nRecent tweets:\n${recentContent || '  (could not fetch)'}`,
      )
    }

    try {
      const { object } = await generateObject({
        model: anthropic(config.textModel),
        schema: auditSchema,
        system: AUDIT_SYSTEM,
        prompt: `Review these ${sample.length} accounts from your following list (${following.length} total):\n\n${summaries.join('\n\n')}`,
      })

      let unfollowCount = 0
      for (const decision of object.decisions) {
        if (decision.keep) continue
        const user = sample.find(u => u.username.toLowerCase() === decision.username.replace('@', '').toLowerCase())
        if (!user) continue
        try {
          await this.twitter.unfollow(user.id)
          unfollowCount++
          this.events.monologue(`Unfollowed @${user.username}. ${decision.reason}`)
        } catch (err) {
          this.events.monologue(`Failed to unfollow @${user.username}: ${(err as Error).message}`)
        }
      }

      const keepCount = object.decisions.filter(d => d.keep).length
      if (unfollowCount === 0) {
        this.events.monologue(`Audit complete. Reviewed ${sample.length}. Everyone earns their spot. For now.`)
      } else {
        this.events.monologue(`Audit complete. Kept ${keepCount}, unfollowed ${unfollowCount}. The list stays tight.`)
      }
    } catch (err) {
      this.events.monologue(`Following audit failed: ${(err as Error).message}`)
    }
  }

  async vetFollowers(): Promise<void> {
    const provider = this.twitter.provider
    const myInfo = await provider.getUserInfo(config.twitter.username)
    if (!myInfo) return

    this.events.monologue(
      `Follower check. ${myInfo.followers} followers, ${myInfo.following} following. Let me vet the newcomers...`,
    )

    const seenStore = new JsonStore<string[]>(join(config.dataDir, 'vetted-followers.json'))
    const alreadySeen = (await seenStore.read()) ?? []

    let res
    try {
      res = await provider.getFollowers(config.twitter.username)
    } catch (err) {
      this.events.monologue(`Follower fetch failed: ${(err as Error).message}`)
      return
    }

    const newFollowers = res.followers.filter(f => !alreadySeen.includes(f.id))
    if (newFollowers.length === 0) {
      this.events.monologue('No new followers to vet.')
      return
    }

    this.events.monologue(`${newFollowers.length} new follower(s) to vet.`)

    let blockedCount = 0
    const newlySeen: string[] = []

    for (const follower of newFollowers) {
      newlySeen.push(follower.id)

      if (this.isSpamFollower(follower)) {
        try {
          await this.twitter.blockUser(follower.id)
          blockedCount++
          this.events.monologue(
            `Blocked @${follower.userName}. Bot/spam pattern: ${follower.followers} followers, ${follower.following} following, bio: "${follower.description.slice(0, 60)}"`,
          )
        } catch (err) {
          this.events.monologue(`Failed to block @${follower.userName}: ${(err as Error).message}`)
        }
        continue
      }

      // Interesting follower — acknowledge on console
      if (follower.followers > 5_000) {
        this.events.monologue(
          `Notable new follower: @${follower.userName} (${follower.followers} followers). "${follower.description.slice(0, 80)}"`,
        )
      }
    }

    // Persist seen list
    await seenStore.update((list) => [...list, ...newlySeen], [])

    if (blockedCount > 0) {
      this.events.monologue(`Vetted ${newFollowers.length} new followers. Blocked ${blockedCount} bots. The garden stays clean.`)
    }
  }

  private isSpamFollower(user: {
    userName: string
    description: string
    followers: number
    following: number
    isBlueVerified: boolean
    statusesCount?: number
  }): boolean {
    // Following/follower ratio way off — mass-follow bot
    if (user.following > 2000 && user.followers < 50) return true
    // Zero content account
    if ((user.statusesCount ?? 0) === 0 && user.followers < 10) return true
    // Empty bio + low followers + high following = bot
    if (!user.description && user.followers < 20 && user.following > 500) return true
    // Crypto/scam bio patterns
    const bio = user.description.toLowerCase()
    if (/crypto .*(earn|passive|income)|dm for|onlyfans|link in bio.*free/i.test(bio)) return true
    if (/\b(nft|web3|degen|airdrop)\b/i.test(bio) && user.followers < 100) return true
    return false
  }

  private scoreMention(mention: {
    text: string
    authorFollowers: number
    metrics: { likes: number; retweets: number; replies: number }
  }): number {
    let score = 0

    // High-follower account
    if (mention.authorFollowers > 10_000) score += 3
    else if (mention.authorFollowers > 1_000) score += 1

    // High-engagement mention
    if (mention.metrics.likes > 100) score += 2
    else if (mention.metrics.likes > 10) score += 1

    // Length indicates effort
    const words = mention.text.split(/\s+/).length
    if (words > 10) score += 2
    else if (words > 5) score += 1

    // Contains a question
    if (mention.text.includes('?')) score += 1

    // Low-effort
    const lowEffort = /^(lol|lmao|nice|cool|wow|based|W|L|mid|ratio)$/i
    if (lowEffort.test(mention.text.trim())) score -= 3

    // Hostile
    const hostile = /\b(idiot|stupid|dumb|stfu|shut up|trash|garbage)\b/i
    if (hostile.test(mention.text)) score -= 5

    return score
  }
}
