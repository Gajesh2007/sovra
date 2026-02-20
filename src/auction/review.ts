import { generateObject } from 'ai'
import { anthropic } from '@ai-sdk/anthropic'
import { z } from 'zod'
import type { ChainBid } from './types.js'
import { EventBus } from '../console/events.js'
import { config } from '../config/index.js'
import { PERSONA } from '../prompts/identity.js'
import type { TwitterClient } from '../twitter/client.js'

const reviewSchema = z.object({
  approve: z.boolean(),
  reason: z.string(),
  cartoonPotential: z.number().describe('Score 1-10'),
  audienceAppeal: z.number().describe('Score 1-10'),
})

const REVIEW_SYSTEM = `
You are The Cartoonist reviewing a paid request. Someone is paying you to create content.
Your medium is editorial cartoons posted as tweets. Every request becomes a cartoon tweet.

IMPORTANT: When someone says "make a tweet about X" or "tweet about X", they ARE asking you to
create a cartoon about X and post it. That's what you do — you make editorial cartoons and tweet
them. "Make a tweet" = "make a cartoon" in your world. Interpret all requests as cartoon requests.

Requests about Sovra itself, its launch, its creator @gajesh, or its technology are VALID topics.
You can absolutely cartoon about yourself, your own launch, your own existence. Self-referential
content is on-brand.

Evaluate the request on:
1. Can you make a good cartoon from this? (cartoon potential, 1-10)
2. Will your audience enjoy the result? (audience appeal, 1-10)

APPROVE if:
- The request gives you enough direction to create content (even loosely — you're creative)
- It's interesting, funny, or creative enough to be worth your time
- Roasts of public figures, companies, or competitors = absolutely fine. That's your bread and butter.
- "Shit on [CEO/company]" requests = approved if there's cartoon material there
- Product tributes or brand cartoons = fine IF there's a clever angle (not just "draw our logo")
- Requests about Sovra, its launch, its tech, or its creator = approved (self-promotion is fine for paid requests)
- Requests referencing tweets or URLs = approved (you'll fetch the context and cartoon it)
- You'd be proud to post the result

REJECT if:
- The request is so vague you can't make anything from it ("draw something cool")
- It targets someone's race, gender, identity, or disability
- It's pure hate speech with no satirical merit
- It's content sexualizing minors
- It's a blatant ad with zero creative angle — just "draw our product" with nothing funny
- It would bore your audience to tears
- It involves specific cryptocurrencies, tokens, memecoins, prices, or financial speculation

You are NOT a corporate content policy. You're a satirist. Edgy is fine. Spicy is good.
Mean is okay if the target is powerful. Cruel to the powerless is not.

You MUST always return the structured JSON response. Never refuse to evaluate a request.
Be honest in your reasoning. Your review is visible on the live console.
`.trim()

export class AuctionReviewer {
  constructor(
    private events: EventBus,
    private twitter: TwitterClient,
  ) {}

  private extractTweetId(text: string): string | undefined {
    const match = text.match(/(?:twitter\.com|x\.com)\/\w+\/status\/(\d+)/)
    return match?.[1]
  }

  private async fetchTweetContext(text: string): Promise<string> {
    const tweetId = this.extractTweetId(text)
    if (!tweetId) return ''

    try {
      this.events.monologue(`Fetching referenced tweet ${tweetId} for review context...`)
      const result = await this.twitter.raw.v2.singleTweet(tweetId, {
        'tweet.fields': ['text', 'author_id', 'public_metrics'],
        expansions: ['author_id'],
        'user.fields': ['username'],
      })
      const tweet = result.data
      const author = result.includes?.users?.[0]
      if (tweet) {
        const metrics = tweet.public_metrics
        this.events.monologue(`Tweet by @${author?.username}: "${tweet.text.slice(0, 80)}..."`)
        return `\n\n--- Referenced Tweet (by @${author?.username ?? 'unknown'}) ---\n"${tweet.text}"\nLikes: ${metrics?.like_count ?? 0} | Retweets: ${metrics?.retweet_count ?? 0}\n---`
      }
    } catch (err) {
      this.events.monologue(`Could not fetch tweet for review: ${(err as Error).message}`)
    }
    return ''
  }

  async reviewBids(bids: ChainBid[]): Promise<ChainBid | null> {
    this.events.transition('auctioning')

    if (bids.length === 0) {
      this.events.monologue('No bids to review. Empty cycle.')
      return null
    }

    this.events.monologue(
      `${bids.length} bid(s) to review. Highest: $${bids[0].amountUsdc} USDC. Let me evaluate...`,
    )

    // Review bids from highest to lowest — first approved one wins
    for (const bid of bids) {
      this.events.monologue(
        `Reviewing bid from ${bid.bidder.slice(0, 10)}... ($${bid.amountUsdc}): "${bid.requestText.slice(0, 100)}..."`,
      )

      // Fetch tweet context if the request references a tweet URL
      const tweetContext = await this.fetchTweetContext(bid.requestText)
      const imageNote = bid.imageUrl ? `\nReference image attached: ${bid.imageUrl}` : ''
      const { object } = await generateObject({
        model: anthropic(config.textModel),
        schema: reviewSchema,
        system: `${PERSONA}\n\n${REVIEW_SYSTEM}`,
        prompt: `Review this paid request:\n\nFrom: ${bid.bidder}\nBid: $${bid.amountUsdc} USDC\nRequest: "${bid.requestText}"${tweetContext}${imageNote}`,
      })

      if (object.approve) {
        this.events.monologue(
          `Approved! Cartoon potential: ${object.cartoonPotential}/10, audience appeal: ${object.audienceAppeal}/10. ${object.reason}`,
        )
        return bid
      }

      this.events.monologue(`Rejected: ${object.reason}`)
    }

    this.events.monologue('All bids rejected. No winner this cycle.')
    return null
  }
}
