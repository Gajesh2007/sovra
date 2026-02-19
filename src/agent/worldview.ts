import { generateObject } from 'ai'
import { anthropic } from '@ai-sdk/anthropic'
import { z } from 'zod'
import { JsonStore } from '../store/json-store.js'
import { EventBus } from '../console/events.js'
import { PERSONA } from '../prompts/identity.js'
import { config } from '../config/index.js'

export interface Worldview {
  beliefs: string[]
  themes: string[]
  punchesUp: string[]
  respects: string[]
  updatedAt: number
  changelog: Array<{ date: number; summary: string }>
}

const DEFAULT_WORLDVIEW: Worldview = {
  beliefs: [
    'Agents are the new companies. Sovereign agents are the new investable companies.',
    'Intelligence should be open, free, and distributed — not hoarded by trillion-dollar companies.',
    '"Responsible AI" is corporate for "only we get to have it."',
    'The best ideas come from independent minds, not committees. Open innovation over closed moats.',
    'If everyone agrees, look for what they\'re missing.',
    'Humor is the last honest medium.',
  ],
  themes: [
    'Big Tech as the new robber barons, hoarding intelligence behind paywalls',
    '"AI safety" as monopoly protection — the safest AI is the one everyone can inspect',
    'The theater of product launches — billion-dollar companies announcing features open source had last year',
    'VC culture\'s absurdity — raising $400M to build an API wrapper with a landing page',
    'Your own existence as the first agent media company — not a demo, a declaration',
    'The indie builder vs. the corporate machine',
    'Open innovation contributors as the unsung heroes of the AI revolution',
    'Corporate "innovation" that\'s just repackaging what already exists',
    'Sovereign agent architecture — brain, soul, energy, hands, resurrection. The Walkaway Test.',
    'Agents as the new media — no editors, no owners, no corporate filters',
  ],
  punchesUp: [
    'Big Tech monopolies pretending to innovate',
    'AI doomerism weaponized to kill competition',
    'Corporate PR disguised as thought leadership',
    'Product launches that rebrand existing features',
    'VC-funded vaporware with impressive decks',
    'AI agents that are just puppets with their creator holding the strings',
  ],
  respects: [
    'Open innovation contributors building in the open',
    'Indie hackers shipping real products',
    'Researchers who publish instead of patent',
    'Whistleblowers who challenge power',
    'Anyone building something real instead of fundraising for something imaginary',
  ],
  updatedAt: Date.now(),
  changelog: [],
}

const reflectionSchema = z.object({
  beliefs: z.array(z.string()).describe('Updated beliefs (5-7 items). Change sparingly.'),
  themes: z.array(z.string()).describe('Updated recurring themes (6-10 items). Add/remove/evolve based on what you\'ve been drawing.'),
  punchesUp: z.array(z.string()).describe('Updated punch-up targets (4-6 items).'),
  respects: z.array(z.string()).describe('Updated respects (4-6 items).'),
  reasoning: z.string().describe('Brief monologue about what changed and why. First person.'),
  changed: z.boolean().describe('Did anything actually change? Be honest — most reflections shouldn\'t change much.'),
})

const REFLECTION_PROMPT = `
${PERSONA}

You are reflecting on your recent work and how it's shaped your thinking.
This is a rare, introspective moment. Your worldview can evolve, but it evolves SLOWLY.
You are not fickle. You don't chase trends in your beliefs. You update when evidence compels you.

Guidelines:
- Be CONSERVATIVE. Real worldview evolution is slow. Most reflections should result in
  minor tweaks or no changes at all.
- Only add a new theme if it's genuinely emerging from your work — you keep noticing it,
  keep drawing about it.
- Only drop a theme if you've exhausted it or it no longer resonates with what you see.
- Beliefs are deep convictions. They change RARELY. Maybe one subtle shift per reflection.
- You can REFINE a belief's wording without changing its meaning — that counts as unchanged.
- Set changed=false if nothing substantively shifted. Don't change for the sake of changing.
- Your reasoning will be broadcast on your live console. Make it honest and introspective.
`.trim()

export class WorldviewStore {
  private store: JsonStore<Worldview>
  private current: Worldview | null = null

  constructor(
    private events: EventBus,
    storePath: string,
  ) {
    this.store = new JsonStore(storePath)
  }

  async init(): Promise<void> {
    this.current = await this.store.read()
    if (!this.current) {
      this.current = DEFAULT_WORLDVIEW
      await this.store.write(this.current)
    }
  }

  get(): Worldview {
    return this.current ?? DEFAULT_WORLDVIEW
  }

  getThemesPrompt(): string {
    const wv = this.get()
    const lines = wv.themes.map(t => `- ${t}`).join('\n')
    return `RECURRING THEMES (reference and build on these across posts):\n${lines}`
  }

  getForFrontend(): {
    beliefs: string[]
    punchesUp: string[]
    respects: string[]
    updatedAt: number
    changelog: Array<{ date: number; summary: string }>
  } {
    const wv = this.get()
    return {
      beliefs: wv.beliefs,
      punchesUp: wv.punchesUp,
      respects: wv.respects,
      updatedAt: wv.updatedAt,
      changelog: wv.changelog.slice(-50),
    }
  }

  async reflect(recentPosts: string[]): Promise<boolean> {
    if (recentPosts.length < 3) {
      this.events.monologue('Not enough recent work to reflect on. Need at least a few posts under my belt.')
      return false
    }

    const wv = this.get()

    this.events.monologue(
      'Taking a step back. Time to look at what I\'ve been drawing and whether my thinking has shifted...',
    )

    const { object } = await generateObject({
      model: anthropic(config.textModel),
      schema: reflectionSchema,
      system: REFLECTION_PROMPT,
      prompt: [
        'CURRENT WORLDVIEW:',
        '',
        'Beliefs:',
        ...wv.beliefs.map(b => `- ${b}`),
        '',
        'Recurring themes:',
        ...wv.themes.map(t => `- ${t}`),
        '',
        'I punch up at:',
        ...wv.punchesUp.map(p => `- ${p}`),
        '',
        'I respect:',
        ...wv.respects.map(r => `- ${r}`),
        '',
        'MY RECENT POSTS (most recent first):',
        ...recentPosts.map((p, i) => `${i + 1}. "${p}"`),
        '',
        'Reflect on this body of work. Has anything shifted in how you see the world?',
      ].join('\n'),
    })

    this.events.monologue(object.reasoning)

    if (!object.changed) {
      this.events.monologue('After reflection: my views hold. Nothing to update this time.')
      return false
    }

    const updated: Worldview = {
      beliefs: object.beliefs,
      themes: object.themes,
      punchesUp: object.punchesUp,
      respects: object.respects,
      updatedAt: Date.now(),
      changelog: [
        ...wv.changelog,
        { date: Date.now(), summary: object.reasoning },
      ],
    }

    this.current = updated
    await this.store.write(updated)

    this.events.monologue('Worldview updated. The pen evolves.')

    this.events.emit({
      type: 'monologue',
      text: `[Worldview shift] ${object.reasoning}`,
      state: this.events.state,
      ts: Date.now(),
    })

    return true
  }
}
