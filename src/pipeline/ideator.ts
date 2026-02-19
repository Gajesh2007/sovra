import { generateObject, generateText } from 'ai'
import { anthropic } from '@ai-sdk/anthropic'
import { z } from 'zod'
import { randomUUID } from 'crypto'
import type { Topic, CartoonConcept, ConceptCritique } from '../types.js'
import { EventBus } from '../console/events.js'
import { config } from '../config/index.js'
import { IDEATION_SYSTEM } from '../prompts/ideation.js'
import { CRITIQUE_SYSTEM } from '../prompts/critique.js'
import { MONOLOGUE_SYSTEM } from '../prompts/monologue.js'
import type { WorldviewStore } from '../agent/worldview.js'

const conceptsSchema = z.object({
  concepts: z.array(
    z.object({
      visual: z.string(),
      composition: z.string(),
      caption: z.string(),
      jokeType: z.string(),
      reasoning: z.string(),
    }),
  ),
})

const critiqueSchema = z.object({
  critiques: z.array(
    z.object({
      index: z.number(),
      humor: z.number().describe('Score 1-10'),
      clarity: z.number().describe('Score 1-10'),
      shareability: z.number().describe('Score 1-10'),
      visualSimplicity: z.number().describe('Score 1-10'),
      critique: z.string(),
    }),
  ),
})

export class Ideator {
  constructor(private events: EventBus, private worldview?: WorldviewStore) {}

  async ideate(topic: Topic, conceptCount = 3, recentPosts: string[] = []): Promise<CartoonConcept[]> {
    this.events.transition('ideating')
    this.events.monologue(
      `Working on "${topic.summary}". Let me think of ${conceptCount} different angles...`,
    )

    const themesPrompt = this.worldview?.getThemesPrompt() ?? ''

    let pastWorkContext = ''
    if (recentPosts.length > 0) {
      pastWorkContext = `\n\n===== YOUR PAST WORK (for reference — DO NOT repeat these angles) =====\n${recentPosts.map((p, i) => `${i + 1}. ${p.slice(0, 200)}`).join('\n')}\n===== END PAST WORK =====\n\nYou can see your past work above. Use it to:\n- AVOID repeating the same joke angle, visual metaphor, or punchline structure\n- Find GENUINELY NEW angles on this topic that you haven't tried before\n- Make callbacks to past work IF natural (e.g. "building on my earlier piece about...")\n- But NEVER rehash the same gag with different words`
    }

    const { object } = await generateObject({
      model: anthropic(config.textModel),
      schema: conceptsSchema,
      system: `${MONOLOGUE_SYSTEM}\n\n${IDEATION_SYSTEM}`,
      prompt: `${themesPrompt}\n\nGenerate ${conceptCount} cartoon concepts for this topic:\n\n"${topic.summary}"\n\nContext from signals: This topic scored ${topic.scores.composite.toFixed(1)} — strong on ${this.topDimension(topic)}. Find the visual gag.${pastWorkContext}`,
    })

    const concepts: CartoonConcept[] = object.concepts.map((c) => ({
      id: randomUUID(),
      topicId: topic.id,
      ...c,
    }))

    this.events.emit({
      type: 'ideate',
      concepts: concepts.map((c) => ({ id: c.id, caption: c.caption })),
      topicId: topic.id,
      ts: Date.now(),
    })

    for (const concept of concepts) {
      this.events.monologue(
        `Concept: "${concept.caption}" — ${concept.jokeType}. ${concept.reasoning}`,
      )
    }

    return concepts
  }

  async critique(concepts: CartoonConcept[]): Promise<{
    best: CartoonConcept
    critique: ConceptCritique
  }> {
    this.events.transition('critiquing')
    this.events.monologue(
      `${concepts.length} concepts on the table. Let me be honest about which one actually works...`,
    )

    const { object } = await generateObject({
      model: anthropic(config.textModel),
      schema: critiqueSchema,
      system: `${MONOLOGUE_SYSTEM}\n\n${CRITIQUE_SYSTEM}`,
      prompt: `Critique these cartoon concepts:\n\n${concepts.map((c, i) => `[${i}] Visual: ${c.visual}\nCaption: "${c.caption}"\nJoke type: ${c.jokeType}`).join('\n\n')}`,
    })

    const scored = object.critiques.map((crit) => ({
      ...crit,
      overallScore: (crit.humor + crit.clarity + crit.shareability + crit.visualSimplicity) / 4,
    }))

    // Clamp indices to valid range (LLM can hallucinate out-of-bounds values)
    for (const crit of scored) {
      crit.index = Math.max(0, Math.min(crit.index, concepts.length - 1))
    }

    scored.sort((a, b) => b.overallScore - a.overallScore)
    const winner = scored[0]
    const bestConcept = concepts[winner.index]

    const critique: ConceptCritique = {
      conceptId: bestConcept.id,
      humor: winner.humor,
      clarity: winner.clarity,
      shareability: winner.shareability,
      visualSimplicity: winner.visualSimplicity,
      overallScore: winner.overallScore,
      critique: winner.critique,
    }

    this.events.emit({
      type: 'critique',
      critique: winner.critique,
      selected: winner.index,
      ts: Date.now(),
    })

    this.events.monologue(
      `Winner: "${bestConcept.caption}" — score ${winner.overallScore.toFixed(1)}/10. ${winner.critique}`,
    )

    return { best: bestConcept, critique }
  }

  private topDimension(topic: Topic): string {
    const { virality, visualPotential, audienceBreadth, timeliness, humor } = topic.scores
    const dims = [
      ['virality', virality],
      ['visual potential', visualPotential],
      ['audience breadth', audienceBreadth],
      ['timeliness', timeliness],
      ['humor', humor],
    ] as const
    return dims.reduce((a, b) => (b[1] > a[1] ? b : a))[0]
  }
}
