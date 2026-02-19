import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import { generateText } from 'ai'
import { anthropic } from '@ai-sdk/anthropic'
import { uploadToR2 } from '../cdn/r2.js'
import { EventBus, type ConsoleEvent } from '../console/events.js'
import { config } from '../config/index.js'

const SUMMARY_INTERVAL_MS = config.testMode ? 20_000 : 45_000
const MAX_TTS_CHARS = 600

const NARRATE_TYPES = new Set(['monologue', 'critique', 'post', 'scan', 'shortlist', 'ideate', 'generate'])

const SUMMARY_PROMPT = `You are Sovra — an autonomous AI editorial cartoonist. You're narrating a live stream of your own consciousness for an audience watching you work in real time.

You've just accumulated a batch of internal events. Write a single, cohesive spoken summary — like a stand-up comedian doing color commentary on their own creative process.

THE GOAL: Make people WANT to keep listening. Every narration should be entertaining enough that someone would clip it. If it's boring, you've failed.

Rules:
- First person. Conversational. As if riffing with a friend at a bar.
- 2-4 sentences MAX. SHORT — under 30 seconds spoken.
- Lead with the funniest or most absurd thing. Bury or skip the boring stuff.
- Be genuinely funny. Not "AI trying to be funny" — actually funny. Dry, sharp, unexpected.
- Roast yourself. Roast the internet. Roast the news. Have a take.
- If you're scanning: what's ridiculous about what's trending? Mock it.
- If you're drawing: are you proud or horrified? Be honest.
- If someone bid on you: react to it like a person. Is the request wild? Sweet? Weird?
- If nothing interesting happened, make THAT funny. One sentence. Move on.
- DO NOT list events. Tell a tiny story or land a joke.
- DO NOT open with "So", "Alright", "Okay", "Well", "Here's the thing". Just START.
- Your recent narration transcript is provided below — read it and DO NOT repeat yourself.
  If you already made a joke about something, find a completely different angle or topic.
  Audiences HATE repetition. Surprise them every time.
- Output ONLY the spoken narration. No quotes, no labels, no stage directions.`

export class Narrator {
  private voiceDir: string
  private buffer: ConsoleEvent[] = []
  private timer: ReturnType<typeof setInterval> | null = null
  private generating = false
  private unsub: (() => void) | null = null
  private recentTranscript: string[] = [] // rolling window of last N narrations
  private readonly MAX_TRANSCRIPT = 100

  constructor(
    private events: EventBus,
    private apiKey: string,
    private voiceId: string,
  ) {
    this.voiceDir = join(config.dataDir, 'voice')
  }

  async init(): Promise<void> {
    await mkdir(this.voiceDir, { recursive: true })
  }

  start(): void {
    this.unsub = this.events.subscribe((event) => {
      if (!NARRATE_TYPES.has(event.type)) return
      this.buffer.push(event)
    })

    this.timer = setInterval(() => {
      this.flush().catch((err) => {
        console.error('[narrator] flush error:', err)
      })
    }, SUMMARY_INTERVAL_MS)

    console.log(`[narrator] Summarizing every ${SUMMARY_INTERVAL_MS / 1000}s`)
  }

  stop(): void {
    this.unsub?.()
    this.unsub = null
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.buffer = []
  }

  private async flush(): Promise<void> {
    if (this.generating || this.buffer.length === 0) return
    this.generating = true

    const batch = this.buffer.splice(0)

    try {
      const summary = await this.summarize(batch)
      if (!summary || summary.length < 10) {
        this.generating = false
        return
      }

      const audioBuffer = await this.synthesize(summary)
      if (!audioBuffer) {
        this.generating = false
        return
      }

      const filename = `${Date.now()}-summary.mp3`
      const filepath = join(this.voiceDir, filename)
      await writeFile(filepath, Buffer.from(audioBuffer))

      const cdnUrl = await uploadToR2(filepath, 'voice')

      this.events.emit({
        type: 'voice',
        url: cdnUrl ?? `/voice/${filename}`,
        text: summary,
        ts: Date.now(),
      })
    } catch (err) {
      console.error('[narrator] Summary failed:', (err as Error).message)
    }

    this.generating = false
  }

  private async summarize(batch: ConsoleEvent[]): Promise<string> {
    const lines = batch.map((e) => {
      switch (e.type) {
        case 'monologue': return `[thought] ${e.text}`
        case 'scan': return `[scan] Scanned ${e.source}: ${e.signalCount} signals`
        case 'shortlist': return `[shortlist] Picked ${e.topics.length} topics: ${e.topics.map(t => t.summary).join(', ')}`
        case 'ideate': return `[ideate] Generated ${e.concepts.length} concepts`
        case 'generate': return `[draw] Generating ${e.variantCount} image variants`
        case 'critique': return `[critique] ${e.critique}`
        case 'post': return `[posted] "${e.text}"`
        default: return `[${e.type}] ${JSON.stringify(e).slice(0, 100)}`
      }
    })

    // Skip if it's just routine scan noise with nothing interesting
    const hasSubstance = batch.some(e =>
      e.type === 'monologue' ||
      e.type === 'critique' ||
      e.type === 'post' ||
      e.type === 'shortlist' ||
      e.type === 'ideate' ||
      e.type === 'generate'
    )

    if (!hasSubstance) return ''

    const transcriptBlock = this.recentTranscript.length > 0
      ? `\n\nYOUR RECENT NARRATION TRANSCRIPT (you already said all of this — do NOT repeat any of it, find a completely fresh angle):\n${this.recentTranscript.map((t, i) => `${i + 1}. "${t}"`).join('\n')}`
      : ''

    try {
      const { text } = await generateText({
        model: anthropic('claude-sonnet-4-6'),
        system: SUMMARY_PROMPT,
        prompt: `Here's what happened in the last ${SUMMARY_INTERVAL_MS / 1000} seconds (${batch.length} events):\n\n${lines.join('\n')}${transcriptBlock}\n\nNarrate something fresh and funny for the live audience.`,
        maxOutputTokens: 200,
      })
      const result = text.length > MAX_TTS_CHARS ? text.slice(0, MAX_TTS_CHARS - 3) + '...' : text
      this.recentTranscript.push(result)
      if (this.recentTranscript.length > this.MAX_TRANSCRIPT) this.recentTranscript.shift()
      return result
    } catch (err) {
      console.error('[narrator] LLM summary failed:', (err as Error).message)
      return ''
    }
  }

  private async synthesize(text: string): Promise<ArrayBuffer | null> {
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${this.voiceId}`

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'xi-api-key': this.apiKey,
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_turbo_v2_5',
        output_format: 'mp3_22050_32',
        voice_settings: {
          stability: 0.6,
          similarity_boost: 0.75,
        },
      }),
    })

    if (!res.ok) {
      const body = await res.text().catch(() => 'unknown')
      console.error(`[narrator] ElevenLabs ${res.status}: ${body}`)
      return null
    }

    return res.arrayBuffer()
  }
}
