import type { FastifyInstance } from 'fastify'
import type { EventBus, ConsoleEvent } from './events.js'

export function registerConsoleRoutes(app: FastifyInstance, events: EventBus) {
  // SSE stream of all console events
  app.get('/api/console/stream', (req, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    })

    const send = (event: ConsoleEvent) => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`)
    }

    // Replay recent history so the page isn't blank on load
    for (const event of events.history) {
      send(event)
    }

    // Send current state after history
    send({
      type: 'state_change',
      from: events.state,
      to: events.state,
      ts: Date.now(),
    })

    const unsub = events.subscribe(send)

    req.raw.on('close', () => {
      unsub()
    })
  })

  // Current agent state
  app.get('/api/console/state', async () => {
    return { state: events.state, ts: Date.now() }
  })
}
