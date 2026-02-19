import { EventEmitter } from 'events'
import { appendFile, mkdir, readFile } from 'fs/promises'
import { dirname } from 'path'

// Agent states
export type AgentState =
  | 'scanning'
  | 'monologuing'
  | 'shortlisting'
  | 'ideating'
  | 'generating'
  | 'critiquing'
  | 'composing'
  | 'posting'
  | 'engaging'
  | 'auctioning'

export type ConsoleEvent =
  | { type: 'monologue'; text: string; state: AgentState; ts: number; tweetId?: string }
  | { type: 'scan'; source: string; signalCount: number; ts: number }
  | { type: 'shortlist'; topics: { id: string; summary: string; score: number }[]; ts: number }
  | { type: 'ideate'; concepts: { id: string; caption: string }[]; topicId: string; ts: number }
  | { type: 'generate'; prompt: string; variantCount: number; ts: number }
  | { type: 'critique'; critique: string; selected: number; ts: number }
  | { type: 'post'; tweetId: string; text: string; imageUrl?: string; ts: number }
  | { type: 'engage'; replyTo: string; text: string; ts: number }
  | { type: 'auction'; action: string; details: Record<string, unknown>; ts: number }
  | { type: 'voice'; url: string; text: string; ts: number }
  | { type: 'state_change'; from: AgentState; to: AgentState; ts: number }
  | { type: 'metric'; name: string; value: number; ts: number }

const HISTORY_SIZE = 50

export class EventBus {
  private emitter = new EventEmitter()
  private logPath: string
  private currentState: AgentState = 'scanning'
  private recentEvents: ConsoleEvent[] = []

  constructor(logPath: string) {
    this.logPath = logPath
    this.emitter.setMaxListeners(100)
  }

  async init(): Promise<void> {
    await mkdir(dirname(this.logPath), { recursive: true })
    // Seed ring buffer from persisted log so history survives restarts
    try {
      const raw = await readFile(this.logPath, 'utf-8')
      const lines = raw.trimEnd().split('\n').slice(-HISTORY_SIZE)
      for (const line of lines) {
        try {
          const event = JSON.parse(line) as ConsoleEvent
          this.recentEvents.push(event)
          if (event.type === 'state_change') this.currentState = event.to
        } catch { /* skip malformed lines */ }
      }
    } catch { /* file doesn't exist yet — fresh start */ }
  }

  get history(): ConsoleEvent[] {
    return this.recentEvents
  }

  emit(event: ConsoleEvent): void {
    this.recentEvents.push(event)
    if (this.recentEvents.length > HISTORY_SIZE) {
      this.recentEvents = this.recentEvents.slice(-HISTORY_SIZE)
    }
    this.emitter.emit('event', event)
    // Console log
    this.logToConsole(event)
    // Fire-and-forget log append
    appendFile(this.logPath, JSON.stringify(event) + '\n').catch(() => {})
  }

  private logToConsole(event: ConsoleEvent): void {
    const time = new Date(event.ts).toLocaleTimeString()
    const stage = `[${this.currentState.toUpperCase()}]`.padEnd(16)
    switch (event.type) {
      case 'monologue':
        console.log(`[${time}] ${stage} 💭 ${event.text}`)
        break
      case 'scan':
        console.log(`[${time}] ${stage} 🔍 Scanned ${event.source}: ${event.signalCount} signals`)
        break
      case 'shortlist':
        console.log(`[${time}] ${stage} 📋 Shortlisted ${event.topics.length} topics`)
        break
      case 'ideate':
        console.log(`[${time}] ${stage} ✏️  ${event.concepts.length} concepts generated`)
        break
      case 'generate':
        console.log(`[${time}] ${stage} 🎨 Generating ${event.variantCount} image variants`)
        break
      case 'critique':
        console.log(`[${time}] ${stage} 🧐 ${event.critique}`)
        break
      case 'post':
        console.log(`[${time}] ${stage} 📤 POSTED: "${event.text}"`)
        break
      case 'engage':
        console.log(`[${time}] ${stage} 💬 Replied: "${event.text}"`)
        break
      case 'auction':
        console.log(`[${time}] ${stage} 🔨 Auction: ${event.action}`)
        break
      case 'voice':
        console.log(`[${time}] ${stage} 🔊 Voice: "${event.text.slice(0, 60)}..."`)
        break
      case 'state_change':
        console.log(`[${time}] ⚡ ${event.from} → ${event.to}`)
        break
      case 'metric':
        console.log(`[${time}] ${stage} 📊 ${event.name}: ${event.value}`)
        break
    }
  }

  monologue(text: string, opts?: { state?: AgentState; tweetId?: string }): void {
    this.emit({
      type: 'monologue',
      text,
      state: opts?.state ?? this.currentState,
      ts: Date.now(),
      ...(opts?.tweetId ? { tweetId: opts.tweetId } : {}),
    })
  }

  transition(to: AgentState): void {
    const from = this.currentState
    this.currentState = to
    this.emit({ type: 'state_change', from, to, ts: Date.now() })
  }

  subscribe(handler: (event: ConsoleEvent) => void): () => void {
    this.emitter.on('event', handler)
    return () => {
      this.emitter.off('event', handler)
    }
  }

  get state(): AgentState {
    return this.currentState
  }
}
