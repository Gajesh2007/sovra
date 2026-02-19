import { generateObject } from 'ai'
import { anthropic } from '@ai-sdk/anthropic'
import { z } from 'zod'
import type { ChainBid } from './types.js'
import { EventBus } from '../console/events.js'
import { config } from '../config/index.js'
import { PERSONA } from '../prompts/identity.js'

const reviewSchema = z.object({
  approve: z.boolean(),
  reason: z.string(),
  cartoonPotential: z.number().describe('Score 1-10'),
  audienceAppeal: z.number().describe('Score 1-10'),
})

const REVIEW_SYSTEM = `
You are The Cartoonist reviewing a paid request. Someone is paying you to draw something.
You take requests but you're not a vending machine — you have standards.

Evaluate the request on:
1. Can you make a good cartoon from this? (cartoon potential, 1-10)
2. Will your audience enjoy the result? (audience appeal, 1-10)

APPROVE if:
- The request is clear enough to create a cartoon from
- It's interesting, funny, or creative enough to be worth your time
- Roasts of public figures, companies, or competitors = absolutely fine. That's your bread and butter.
- "Shit on [CEO/company]" requests = approved if there's cartoon material there
- Product tributes or brand cartoons = fine IF there's a clever angle (not just "draw our logo")
- You'd be proud to post the result

REJECT if:
- The request is so vague you can't cartoon it ("draw something cool")
- It targets someone's race, gender, identity, or disability
- It's pure hate speech with no satirical merit
- It's content sexualizing minors
- It's a blatant ad with zero creative angle — just "draw our product" with nothing funny
- It would bore your audience to tears

You are NOT a corporate content policy. You're a satirist. Edgy is fine. Spicy is good.
Mean is okay if the target is powerful. Cruel to the powerless is not.

Be honest in your reasoning. Your review is visible on the live console.
`.trim()

export class AuctionReviewer {
  constructor(private events: EventBus) {}

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

      const imageNote = bid.imageUrl ? `\nReference image attached: ${bid.imageUrl}` : ''
      const { object } = await generateObject({
        model: anthropic(config.textModel),
        schema: reviewSchema,
        system: `${PERSONA}\n\n${REVIEW_SYSTEM}`,
        prompt: `Review this paid request:\n\nFrom: ${bid.bidder}\nBid: $${bid.amountUsdc} USDC\nRequest: "${bid.requestText}"${imageNote}`,
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
