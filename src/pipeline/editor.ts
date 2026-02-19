import { generateObject } from 'ai'
import { anthropic } from '@ai-sdk/anthropic'
import { z } from 'zod'
import { readFile } from 'fs/promises'
import type { CartoonConcept, Cartoon, Post } from '../types.js'
import { EventBus } from '../console/events.js'
import { PERSONA } from '../prompts/identity.js'

const editorSchema = z.object({
  approved: z.boolean(),
  isDuplicate: z.boolean().describe('Is this too similar to a previous post?'),
  duplicateOf: z.string().optional().describe('Which previous post is it duplicating?'),
  imageApproved: z.boolean().describe('Does the image look good? No text leaks, no artifacts, clear visual gag?'),
  imageIssues: z.string().optional().describe('What is wrong with the image if not approved'),
  captionApproved: z.boolean(),
  revisedCaption: z.string().optional().describe('Improved caption if the original needs work'),
  qualityScore: z.number().describe('1-10 overall quality'),
  reason: z.string().describe('Editorial reasoning — what works, what does not, why approved/rejected'),
})

const EDITOR_SYSTEM = `
${PERSONA}

You are Sovra's EDITOR — a separate editorial intelligence that reviews every cartoon before it goes live.
You use a different model (Sonnet) from the creative side (Opus) to provide an independent perspective.

Your job:

1. DUPLICATE CHECK — You receive ALL previous posts. If this new cartoon covers the same topic,
   the same joke angle, or would feel repetitive to a follower scrolling the feed, REJECT it.
   Be aggressive about this. If someone could confuse this new post with a previous one, it's a duplicate.
   Look at themes, targets, joke mechanisms — not just literal word overlap.

2. QUALITY GATE — Is this cartoon actually good? Does the caption land? Would someone screenshot
   and share this? A score below 6 means reject.

3. CAPTION REVIEW — Is the caption punchy enough? Does it work standalone AND with the image?
   If you can write a better one (shorter, sharper, funnier), provide it as revisedCaption.
   Keep it under 100 characters. No hashtags, no emojis.

4. IMAGE REVIEW — You can SEE the generated cartoon. Check:
   - No text, words, or letters leaked into the image (common failure — instant reject)
   - The visual gag is clear and readable at a glance
   - Characters look intentional, not garbled (no extra limbs, melted faces)
   - The composition matches what was described in the concept
   - The style is consistent with Sovra's editorial cartoon aesthetic
   If the image has text in it or looks broken, reject immediately.

5. BRAND ALIGNMENT — Does this fit Sovra's identity? Is it punching up? Is it on-theme?
   Random viral humor with no connection to open innovation / Big Tech critique = reject.

Rules:
- Be HARSH. Better to reject a mediocre cartoon than publish something that dilutes the feed.
- If in doubt, reject. There will always be another topic.
- When you approve, your reason should explain why this DESERVES to be published.
- When you reject, your reason should be specific enough to guide the next attempt.
`

export class Editor {
  constructor(private events: EventBus) {}

  async review(
    concept: CartoonConcept,
    caption: string,
    imagePath: string,
    allPastPosts: Post[],
    allPastCartoons: Cartoon[],
  ): Promise<{
    approved: boolean
    caption: string
    reason: string
    qualityScore: number
  }> {
    this.events.monologue('Sending to editorial review (text + image)...')

    const pastFeed = allPastPosts
      .map((p, i) => `${i + 1}. "${p.text}"`)
      .join('\n')

    const pastTopics = allPastCartoons
      .map((c, i) => `${i + 1}. Topic: ${c.concept.visual} | Caption: "${c.caption}"`)
      .join('\n')

    const textPrompt = [
      'CARTOON TO REVIEW:',
      `Visual concept: ${concept.visual}`,
      `Joke type: ${concept.jokeType}`,
      `Reasoning: ${concept.reasoning}`,
      `Proposed caption: "${caption}"`,
      '',
      'The generated cartoon image is attached. Review BOTH the image and the concept.',
      '',
      '---',
      '',
      `ALL PREVIOUS POSTS (${allPastPosts.length} total, most recent last):`,
      pastFeed || '(no previous posts)',
      '',
      `PREVIOUS CARTOON TOPICS (${allPastCartoons.length} total):`,
      pastTopics || '(no previous cartoons)',
      '',
      'Review this cartoon. Should it be published?',
    ].join('\n')

    // Build multi-modal message with the image
    const content: Array<{ type: 'text'; text: string } | { type: 'image'; image: Uint8Array; mimeType: string }> = []

    try {
      const imageBuffer = await readFile(imagePath)
      content.push({ type: 'image', image: new Uint8Array(imageBuffer), mimeType: 'image/png' })
    } catch {
      this.events.monologue('Could not read image for review — reviewing text only.')
    }

    content.push({ type: 'text', text: textPrompt })

    const { object } = await generateObject({
      model: anthropic('claude-sonnet-4-6'),
      schema: editorSchema,
      system: EDITOR_SYSTEM,
      messages: [{ role: 'user', content }],
    })

    const finalCaption = object.captionApproved ? caption : (object.revisedCaption ?? caption)

    if (!object.imageApproved) {
      this.events.monologue(
        `EDITOR REJECTED — image issues: ${object.imageIssues ?? 'Visual quality not acceptable.'}`,
      )
      return { approved: false, caption, reason: object.imageIssues ?? 'Image quality issue', qualityScore: object.qualityScore }
    }

    if (object.isDuplicate) {
      this.events.monologue(
        `EDITOR REJECTED — duplicate. ${object.duplicateOf ? `Too similar to: "${object.duplicateOf}"` : 'Covers same ground as recent posts.'}`,
      )
      return { approved: false, caption, reason: object.reason, qualityScore: object.qualityScore }
    }

    if (!object.approved) {
      this.events.monologue(
        `EDITOR REJECTED — quality ${object.qualityScore}/10. ${object.reason}`,
      )
      return { approved: false, caption, reason: object.reason, qualityScore: object.qualityScore }
    }

    if (!object.captionApproved && object.revisedCaption) {
      this.events.monologue(
        `EDITOR APPROVED with caption revision: "${caption}" → "${object.revisedCaption}". ${object.reason}`,
      )
    } else {
      this.events.monologue(
        `EDITOR APPROVED — quality ${object.qualityScore}/10. ${object.reason}`,
      )
    }

    return {
      approved: true,
      caption: finalCaption,
      reason: object.reason,
      qualityScore: object.qualityScore,
    }
  }
}
