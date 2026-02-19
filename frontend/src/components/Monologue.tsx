import { useEffect, useRef } from 'react'
import { TweetEmbed } from './TweetEmbed'
import { sanitizeImageUrl } from '../security'

interface Entry {
  id: number
  type: string
  text: string
  ts: number
  tweetId?: string
  imageUrl?: string
}

const TYPE_STYLES: Record<string, { color: string; label: string; icon: string }> = {
  monologue: { color: 'text-violet',     label: 'thought',  icon: '~' },
  editor:    { color: 'text-cobalt',     label: 'editor',   icon: '✎' },
  scan:      { color: 'text-cyan',       label: 'scan',     icon: '>' },
  shortlist: { color: 'text-ochre',      label: 'pick',     icon: '#' },
  ideate:    { color: 'text-vermillion', label: 'sketch',   icon: '*' },
  generate:  { color: 'text-cobalt',     label: 'draw',     icon: '%' },
  critique:  { color: 'text-vermillion', label: 'judge',    icon: '!' },
  post:      { color: 'text-forest',     label: 'post',     icon: '+' },
  engage:    { color: 'text-forest',     label: 'reply',    icon: '@' },
  auction:   { color: 'text-ochre',      label: 'bid',      icon: '$' },
}

export function Monologue({ entries, compareMode, onToggleCompare }: {
  entries: Entry[]
  compareMode?: boolean
  onToggleCompare?: () => void
}) {
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    // Auto-scroll to top when new entries arrive (latest first)
    if (el.scrollTop < 120) {
      el.scrollTo({ top: 0, behavior: 'smooth' })
    }
  }, [entries.length])

  return (
    <div ref={scrollRef} className="h-full overflow-y-auto bg-paper">
      {entries.length === 0 ? (
        <EmptyBrain />
      ) : (
        <>
        {/* Section header — only shown when there are entries */}
        <div className="sticky top-0 z-10 glass-panel border-b-[2px] border-ink px-6 sm:px-10 py-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-[4px] h-5 bg-vermillion rounded-full" />
              <h2 className="font-cartoon text-2xl font-bold text-ink">Internal Monologue</h2>
            </div>
            <div className="flex items-center gap-3">
              {onToggleCompare && (
                <button
                  onClick={onToggleCompare}
                  className={`hidden md:inline-block cartoon-btn font-cartoon text-[14px] px-3 py-0.5 ${
                    compareMode
                      ? 'bg-cobalt text-paper-bright'
                      : 'bg-paper-warm text-ink-muted'
                  }`}
                >
                  {compareMode ? 'Close Gallery' : 'Open Gallery'}
                </button>
              )}
              <span className="font-mono text-[12px] font-medium text-ink-muted tabular-nums">
                {entries.length} entries
              </span>
              <span className="inline-block w-[2px] h-4 bg-vermillion rounded-full animate-[typewriter-blink_1s_infinite]" />
            </div>
          </div>
        </div>
        <div className="px-6 sm:px-10 py-6 space-y-1">
          {[...entries].reverse().map((entry, i) => {
            const style = TYPE_STYLES[entry.type] ?? { color: 'text-ink-faint', label: entry.type, icon: '.' }
            const isPost = entry.type === 'post'
            const isNew = i === 0

            return (
              <div
                key={entry.id}
                className={`group flex gap-3 py-2.5 px-3 -mx-3 transition-colors hover:bg-paper-warm/60 ${
                  isNew ? 'animate-[slide-up_0.2s_ease-out]' : ''
                }`}
                style={{ borderRadius: isNew ? '255px 15px 225px 15px/15px 225px 15px 255px' : undefined }}
              >
                {/* Gutter */}
                <div className="shrink-0 w-14 flex items-baseline justify-end gap-1.5 pt-0.5">
                  <span className={`font-mono text-[12px] font-bold ${style.color}`}>
                    {style.icon}
                  </span>
                  <span className="font-mono text-[12px] font-semibold text-ink-muted tabular-nums">
                    {new Date(entry.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className={`font-cartoon text-[16px] font-bold ${style.color}`}>
                      {style.label}
                    </span>
                  </div>
                  <p className={`font-hand text-[16px] leading-relaxed whitespace-pre-line ${
                    isPost ? 'text-forest font-bold' : 'text-ink-secondary'
                  }`}>
                    {entry.text}
                  </p>
                  {entry.imageUrl && sanitizeImageUrl(entry.imageUrl) && (
                    <div className="mt-3 max-w-sm cartoon-panel p-2 inline-block">
                      <img
                        src={sanitizeImageUrl(entry.imageUrl)!}
                        alt="cartoon"
                        className="w-full rounded-sm"
                        loading="lazy"
                      />
                    </div>
                  )}
                  {entry.tweetId && (
                    <div className="mt-3 max-w-md">
                      <TweetEmbed tweetId={entry.tweetId} />
                    </div>
                  )}
                </div>
              </div>
            )
          })}
          
        </div>
        </>
      )}
    </div>
  )
}

function EmptyBrain() {
  return (
    <div className="flex flex-col items-center justify-center h-full px-8 py-16">
      {/* Animated scanning bar */}
      <div className="w-48 h-px bg-border rounded-full overflow-hidden mb-10">
        <div className="h-full w-1/3 bg-vermillion/40 rounded-full animate-[scan-line_2s_ease-in-out_infinite]" />
      </div>

      <p className="font-cartoon text-3xl sm:text-4xl text-ink leading-snug text-center">
        Sovra is waking up&hellip;
      </p>

      <p className="font-hand text-[16px] text-ink-muted mt-4 text-center max-w-sm leading-relaxed">
        Scanning the internet for something worth drawing.
        Thoughts will stream here in real time.
      </p>

      {/* Pulsing dot */}
      <div className="mt-8 flex items-center gap-2">
        <div className="w-1.5 h-1.5 rounded-full bg-cyan animate-[pulse-soft_1.5s_infinite]" />
        <span className="font-mono text-[10px] text-ink-faint uppercase tracking-widest">Listening</span>
      </div>
    </div>
  )
}
