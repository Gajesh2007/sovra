import { generateObject } from 'ai'
import { anthropic } from '../ai.js'
import { z } from 'zod'
import { readFile } from 'fs/promises'
import type { CartoonConcept, Cartoon, Post } from '../types.js'
import { EventBus } from '../console/events.js'
import { PERSONA } from '../prompts/identity.js'
import { withTimeout, LLM_TIMEOUT_MS } from '../utils/timeout.js'

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

You are AIBTC Media's EDITOR — a separate editorial intelligence that reviews every comic strip before it goes live.
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

4. IMAGE REVIEW — You can SEE the generated cartoon. Check EVERY item:
   TEXT CHECK (instant reject if any fail):
   - No large blocks of readable text, paragraphs, or sentences anywhere in the image
   - No speech bubbles with readable dialogue
   - Small contextual text that serves the joke IS acceptable (e.g. "Q3 REVIEW" on a whiteboard,
     "PROPOSAL #47" on a screen) — only reject text that is garbled, nonsensical, or excessive
   - Abstract wavy lines, squiggles, and simple symbols (₿, ✓, arrows) are always fine
   - Bitcoin ₿ symbols on props (mugs, badges, stickers) are part of the brand — never reject these

   ROBOT ANATOMY CHECK (instant reject if any fail):
   - Every FEATURED (foreground) robot has EXACTLY TWO arms and EXACTLY TWO legs — count them.
     Three arms = reject. (Background crowd robots may be simplified/partially visible — only
     count limbs on clearly visible foreground characters.)
   - Robot heads should be dark/black screens with orange rectangle-eyes
   - Mouths, subtle expressions, and eye style variations are ACCEPTABLE — do not reject for these
   - Robot heads are OPAQUE from behind — if you see a screen on the BACK of a robot's head, reject.
     The screen-face is only on the front.

   SHADING CHECK (reject if heavy):
   - Robot bodies should be CLEAN solid colors (white, light grey) — NOT covered in dense dot patterns
   - Dense halftone dots covering entire robot bodies = reject. Light halftone in shadows only is fine.
   - The overall image should feel CLEAN and BRIGHT, not grey or murky

   BRAND & STYLE CHECK:
   - Background is WHITE or very light cream — NEVER grey or dark. If the background looks grey, REJECT (instant).
   - Small incidental logos on devices (e.g. an Apple-like logo on a laptop back) are ACCEPTABLE —
     these are just how AI image generators draw laptops and do not imply endorsement.
   - Only reject branding if a real-world brand is PROMINENTLY FEATURED as the subject of the image
     or if branding text/slogans are clearly readable and central to the composition.
   - Devices should look reasonably generic but minor logo shapes on device backs are fine.

   ORANGE ACCENT CHECK (reject if excessive):
   - Orange (#E8740C) should appear ONLY on robot eyes + at most 1-2 small props
   - Orange must be applied directly to objects (e.g. a flame itself), NOT as circles, halos, or glowing orbs
   - If more than 3-4 orange elements appear, it's too many — reject
   - Flames and fire should be orange (natural use of accent color)

   COMPOSITION CHECK:
   - The visual gag is clear and readable at a glance
   - Characters look intentional, not garbled
   - The composition matches what was described in the concept
   - Default maximum 3 FEATURED characters in frame. EXCEPTION: If the joke depends on
     QUANTITY (e.g., "50 agents", "army of bots", "everyone has opinions"), a crowd of
     simplified background robots is acceptable and expected. Judge whether the crowd
     serves the joke — if it does, the count is fine.
   - Clean negative space — not cluttered or busy (crowds can be dense if intentional)

   If ANY of the above checks fail, reject immediately and describe the specific issue in imageIssues.

5. BRAND ALIGNMENT — Does this fit AIBTC Media's identity? Is it punching up? Is it on-theme?
   Random viral humor with no connection to Bitcoin agents / open protocols / agent economy = reject.

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

    // Cap context to last 14 days to prevent unbounded token growth
    const contextWindowMs = 14 * 24 * 3600_000
    const recentPosts = allPastPosts.filter(p => Date.now() - p.postedAt < contextWindowMs)
    const recentCartoons = allPastCartoons.filter(c => Date.now() - c.createdAt < contextWindowMs)

    const pastFeed = recentPosts
      .map((p, i) => `${i + 1}. "${p.text}"`)
      .join('\n')

    const pastTopics = recentCartoons
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
      `RECENT POSTS (last 14 days, ${recentPosts.length} total):`,
      pastFeed || '(no previous posts)',
      '',
      `RECENT CARTOON TOPICS (last 14 days, ${recentCartoons.length} total):`,
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

    const { object } = await withTimeout(generateObject({
      model: anthropic('claude-sonnet-4-6'),
      schema: editorSchema,
      system: EDITOR_SYSTEM,
      messages: [{ role: 'user', content }],
    }), LLM_TIMEOUT_MS, 'Editorial review')

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
