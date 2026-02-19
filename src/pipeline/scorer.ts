import { generateObject } from 'ai'
import { anthropic } from '@ai-sdk/anthropic'
import { z } from 'zod'
import { randomUUID } from 'crypto'
import type { Signal, Topic } from '../types.js'
import { Cache } from '../cache/cache.js'
import { EventBus } from '../console/events.js'
import { config } from '../config/index.js'
import { TOPIC_SCORING_SYSTEM } from '../prompts/scoring.js'
import { SAFETY_CHECK_SYSTEM } from '../prompts/safety.js'
import { MONOLOGUE_SYSTEM } from '../prompts/monologue.js'

const batchScoreSchema = z.object({
  topics: z.array(
    z.object({
      signalIndices: z.array(z.number()).describe('Which signal indices (0-based) this topic covers'),
      summary: z.string().describe('One-line summary of the topic'),
      safe: z.boolean().describe('Is this topic safe to cartoon about?'),
      safetyReason: z.string().optional().describe('If unsafe, why'),
      virality: z.number().describe('Score 0-10'),
      visualPotential: z.number().describe('Score 0-10'),
      audienceBreadth: z.number().describe('Score 0-10'),
      timeliness: z.number().describe('Score 0-10'),
      humor: z.number().describe('Score 0-10'),
      worldviewAlignment: z.number().describe('Score 0-10: how well does this connect to Sovra\'s themes (open AI, Big Tech critique, indie builders)?'),
      reasoning: z.string().describe('Brief explanation of the scoring'),
    }),
  ),
})

export class Scorer {
  constructor(
    private events: EventBus,
    private evalCache: Cache,
  ) {}

  async scoreAndFilter(
    signals: Signal[],
    recentTopicSummaries: string[],
  ): Promise<Topic[]> {
    this.events.transition('shortlisting')

    if (signals.length === 0) {
      this.events.monologue('Nothing worth cartooning right now. Slow news cycle.')
      return []
    }

    // Check cache — if we've evaluated this exact batch recently, reuse it
    const batchKey = Cache.key(`batch-eval:${signals.map(s => s.content.slice(0, 50)).join('|').slice(0, 500)}`)
    const cached = this.evalCache.get(batchKey) as Topic[] | null
    if (cached) {
      this.events.monologue(`Using cached evaluation for ${cached.length} topics.`)
      return cached
    }

    this.events.monologue(
      `${signals.length} signals to evaluate. Batch-scoring in a single pass...`,
    )

    // Build a numbered signal list for the LLM
    const capped = signals.slice(0, 100)
    const signalList = capped
      .map((s, i) => `[${i}] ${s.content}`)
      .join('\n\n')

    const blacklist = recentTopicSummaries.length > 0
      ? `\n\n===== DO NOT REPEAT — ALREADY COVERED =====\nThe following topics, angles, and jokes have ALREADY been drawn. You MUST NOT select any topic that overlaps with these. If a signal covers the same ground as anything below, score its worldview alignment as 0 and mark it as already covered.\n\n${recentTopicSummaries.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n\n===== END BLACKLIST =====`
      : ''

    const { object } = await generateObject({
      model: anthropic(config.textModel),
      schema: batchScoreSchema,
      system: `${MONOLOGUE_SYSTEM}\n\n${TOPIC_SCORING_SYSTEM}\n\n${SAFETY_CHECK_SYSTEM}\n\nYou are evaluating a batch of signals. Group related signals into topics, then score each topic. Return at most 10 topics, ranked by cartoon potential. For each topic, list which signal indices it covers. Also perform a safety check inline — mark unsafe topics with safe=false.\n\nCRITICAL: Check every topic against the DO NOT REPEAT blacklist. If a topic covers the same subject, same angle, or same joke as anything on the blacklist — even if the phrasing is different — give it worldview alignment 0.`,
      prompt: `Score these signals for editorial cartoon potential:\n\n${signalList}${blacklist}`,
    })

    const topics: Topic[] = []

    for (const scored of object.topics) {
      if (!scored.safe) {
        this.events.monologue(
          `"${scored.summary.slice(0, 60)}..." — skipping. ${scored.safetyReason ?? 'Content policy.'}`,
        )
        continue
      }

      const worldview = scored.worldviewAlignment ?? 0

      if (worldview < 4) {
        this.events.monologue(
          `"${scored.summary.slice(0, 60)}..." — worldview alignment ${worldview}/10. Not my beat. Skipping.`,
        )
        continue
      }

      const validIndices = scored.signalIndices
        .filter(i => i >= 0 && i < capped.length)

      const composite =
        scored.virality * 0.15 +
        scored.visualPotential * 0.15 +
        scored.audienceBreadth * 0.10 +
        scored.timeliness * 0.10 +
        scored.humor * 0.15 +
        worldview * 0.35

      const isDuplicate = recentTopicSummaries.some(
        (recent) => this.similarity(recent, scored.summary) > 0.3,
      )

      if (isDuplicate) {
        this.events.monologue(
          `"${scored.summary.slice(0, 60)}..." — already covered recently. Skipping.`,
        )
        continue
      }

      const topic: Topic = {
        id: randomUUID(),
        signals: validIndices.map(i => capped[i].id),
        summary: scored.summary,
        scores: {
          virality: scored.virality,
          visualPotential: scored.visualPotential,
          audienceBreadth: scored.audienceBreadth,
          timeliness: scored.timeliness,
          humor: scored.humor,
          worldviewAlignment: worldview,
          composite,
        },
        safety: { passed: true },
        status: 'candidate',
        evaluatedAt: Date.now(),
      }

      topics.push(topic)

      this.events.monologue(
        `"${scored.summary}" — virality: ${scored.virality}, visual: ${scored.visualPotential}, humor: ${scored.humor}, worldview: ${worldview}. Composite: ${topic.scores.composite.toFixed(1)}${isDuplicate ? ' (penalized — already covered recently)' : ''}. ${scored.reasoning}`,
      )
    }

    // Sort by composite score descending
    topics.sort((a, b) => b.scores.composite - a.scores.composite)

    // Mark top 5 as shortlisted
    for (let i = 0; i < Math.min(5, topics.length); i++) {
      topics[i].status = 'shortlisted'
    }

    this.events.emit({
      type: 'shortlist',
      topics: topics.slice(0, 5).map((t) => ({
        id: t.id,
        summary: t.summary,
        score: t.scores.composite,
      })),
      ts: Date.now(),
    })

    if (topics.length > 0) {
      this.events.monologue(
        `Top pick: "${topics[0].summary}" (${topics[0].scores.composite.toFixed(1)}). This has cartoon potential.`,
      )
    } else {
      this.events.monologue('Nothing worth cartooning right now. Slow news cycle.')
    }

    // Cache the batch result
    this.evalCache.set(batchKey, topics, config.cache.topicEvalTtlMs)

    return topics
  }

  private similarity(a: string, b: string): number {
    // Simple Jaccard similarity on words
    const wordsA = new Set(a.toLowerCase().split(/\s+/))
    const wordsB = new Set(b.toLowerCase().split(/\s+/))
    const intersection = [...wordsA].filter((w) => wordsB.has(w)).length
    const union = new Set([...wordsA, ...wordsB]).size
    return union === 0 ? 0 : intersection / union
  }
}
