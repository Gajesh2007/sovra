import { generateObject } from 'ai'
import { anthropic } from '@ai-sdk/anthropic'
import { z } from 'zod'
import type { CartoonConcept } from '../types.js'
import { EventBus } from '../console/events.js'
import { config } from '../config/index.js'
import { CAPTION_SYSTEM } from '../prompts/caption.js'
import { MONOLOGUE_SYSTEM } from '../prompts/monologue.js'

const captionsSchema = z.object({
  captions: z.array(
    z.object({
      text: z.string(),
      angle: z.string(),
    }),
  ),
  bestIndex: z.number().describe('Index of the best caption (0-based)'),
  reasoning: z.string(),
})

export class Captioner {
  constructor(private events: EventBus) {}

  async generate(concept: CartoonConcept, recentCaptions: string[] = []): Promise<string> {
    this.events.transition('composing')
    this.events.monologue(
      `Writing the one-liner for "${concept.caption}". Let me find something punchier...`,
    )

    let pastCaptionsContext = ''
    if (recentCaptions.length > 0) {
      pastCaptionsContext = `\n\n===== CAPTIONS ALREADY USED (DO NOT reuse these or write something too similar) =====\n${recentCaptions.map((c, i) => `${i + 1}. "${c}"`).join('\n')}\n===== END =====`
    }

    const { object } = await generateObject({
      model: anthropic(config.textModel),
      schema: captionsSchema,
      system: `${MONOLOGUE_SYSTEM}\n\n${CAPTION_SYSTEM}`,
      prompt: `Write 5 one-liner captions for this cartoon:\n\nTopic: ${concept.visual}\nOriginal concept caption: "${concept.caption}"\nJoke type: ${concept.jokeType}\n\nThe caption will accompany the cartoon image in a quote-tweet of the original news.${pastCaptionsContext}`,
    })

    const best = object.captions[object.bestIndex]

    this.events.monologue(
      `Candidates:\n${object.captions.map((c, i) => `  ${i === object.bestIndex ? '→' : ' '} "${c.text}" (${c.angle})`).join('\n')}\n\nGoing with: "${best.text}". ${object.reasoning}`,
    )

    return best.text
  }
}
