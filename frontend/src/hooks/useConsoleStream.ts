import { useState, useEffect, useRef, useCallback } from 'react'
import type { ConsoleEvent, AgentState } from '../types'

interface ConsoleEntry {
  id: number
  type: string
  text: string
  ts: number
  tweetId?: string
  imageUrl?: string
}

interface ConsoleStreamOptions {
  onEvent?: (type: string, rawEvent?: ConsoleEvent) => void
}

export function useConsoleStream(options?: ConsoleStreamOptions) {
  const [entries, setEntries] = useState<ConsoleEntry[]>([])
  const [agentState, setAgentState] = useState<AgentState>('scanning')
  const [connected, setConnected] = useState(false)
  const [shortlist, setShortlist] = useState<{ id: string; summary: string; score: number }[]>([])
  const [stats, setStats] = useState({ events: 0, posts: 0 })
  const idRef = useRef(0)

  const addEntry = useCallback((type: string, text: string, ts: number, tweetId?: string, imageUrl?: string) => {
    const id = idRef.current++
    setEntries(prev => {
      const next = [...prev, { id, type, text, ts, tweetId, imageUrl }]
      return next.length > 200 ? next.slice(-200) : next
    })
    setStats(prev => ({ ...prev, events: prev.events + 1 }))
  }, [])

  useEffect(() => {
    let es: EventSource

    function connect() {
      es = new EventSource('/api/console/stream')

      es.onopen = () => {
        setConnected(true)
      }

      es.onmessage = (e) => {
        let event: ConsoleEvent
        try {
          event = JSON.parse(e.data)
        } catch {
          return
        }

        switch (event.type) {
          case 'monologue': {
            const isEditor = event.text.startsWith('EDITOR ') || event.text.startsWith('Sending to editorial')
            addEntry(isEditor ? 'editor' : 'monologue', event.text, event.ts, event.tweetId)
            break
          }
          case 'scan':
            addEntry('scan', `Scanned ${event.source}: ${event.signalCount} signals`, event.ts)
            break
          case 'shortlist': {
            const topicList = event.topics
              .map((t, i) => `${i + 1}. "${t.summary}" (${t.score.toFixed(1)})`)
              .join('\n')
            addEntry('shortlist', `Shortlisted ${event.topics.length} topics:\n${topicList}`, event.ts)
            setShortlist(event.topics)
            break
          }
          case 'ideate': {
            const conceptList = event.concepts
              .map((c, i) => `${i + 1}. "${c.caption}"`)
              .join('\n')
            addEntry('ideate', `Generated ${event.concepts.length} concepts:\n${conceptList}`, event.ts)
            break
          }
          case 'generate':
            addEntry('generate', `Generating ${event.variantCount} image variants`, event.ts)
            break
          case 'critique':
            addEntry('critique', event.critique, event.ts)
            break
          case 'post':
            addEntry('post', event.text, event.ts, undefined, event.imageUrl)
            setStats(prev => ({ ...prev, posts: prev.posts + 1 }))
            break
          case 'engage':
            addEntry('engage', `Replied: "${event.text}"`, event.ts)
            break
          case 'auction':
            addEntry('auction', `${event.action}`, event.ts)
            break
          case 'voice':
            options?.onEvent?.('voice', event)
            break
          case 'state_change':
            setAgentState(event.to)
            break
        }
      }

      es.onerror = () => {
        setConnected(false)
        es.close()
        setTimeout(connect, 3000)
      }
    }

    connect()
    return () => es?.close()
  }, [addEntry])

  return { entries, agentState, connected, shortlist, stats }
}
