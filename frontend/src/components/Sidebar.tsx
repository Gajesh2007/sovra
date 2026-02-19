import { useState, useEffect } from 'react'
import type { AgentState } from '../types'

interface SidebarProps {
  stats: { events: number; posts: number }
  shortlist: Array<{ id: string; summary: string; score: number }>
  agentState: AgentState
  postCount: number
}

interface WorldviewData {
  beliefs: string[]
  punchesUp: string[]
  respects: string[]
  updatedAt: number
  changelog: Array<{ date: number; summary: string }>
}

const FALLBACK_BELIEFS = [
  'Agents are the new companies. Sovereign agents are the new investable companies.',
  'Intelligence should be open, free, and distributed — not hoarded by trillion-dollar companies.',
  '"Responsible AI" is corporate for "only we get to have it."',
  'The best ideas come from independent minds, not committees. Open innovation over closed moats.',
  'Humor is the last honest medium.',
]

const FALLBACK_PUNCHES = [
  'Big Tech monopolies pretending to innovate',
  'AI doomerism weaponized to kill competition',
  'Corporate PR disguised as thought leadership',
  'Product launches that rebrand existing features',
  'VC-funded vaporware with impressive decks',
]

const FALLBACK_RESPECTS = [
  'Open innovation contributors building in the open',
  'Indie hackers shipping real products',
  'Researchers who publish instead of patent',
  'Anyone building something real, not fundraising for something imaginary',
]

export function Sidebar({ stats, shortlist, postCount }: SidebarProps) {
  const [identityOpen, setIdentityOpen] = useState(false)
  const [worldview, setWorldview] = useState<WorldviewData | null>(null)

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch('/api/worldview')
        if (res.ok) setWorldview(await res.json())
      } catch { /* use fallbacks */ }
    }
    load()
    const interval = setInterval(load, 60_000)
    return () => clearInterval(interval)
  }, [])

  const beliefs = worldview?.beliefs ?? FALLBACK_BELIEFS
  const punchesUp = worldview?.punchesUp ?? FALLBACK_PUNCHES
  const respects = worldview?.respects ?? FALLBACK_RESPECTS
  const lastEvolved = worldview?.updatedAt
    ? new Date(worldview.updatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : null
  const latestShift = worldview?.changelog?.length ? worldview.changelog[worldview.changelog.length - 1] : null

  return (
    <aside className="bg-paper-bright overflow-y-auto">
      {/* Live ticker block */}
      <div className="p-5 border-b-[2px] border-ink/20">
        <div className="flex items-center gap-2 mb-4">
          <div className="relative flex items-center justify-center">
            <div className="w-2 h-2 rounded-full bg-vermillion" />
            <div className="absolute w-2 h-2 rounded-full bg-vermillion animate-ping opacity-40" />
          </div>
          <span className="font-mono text-[11px] font-bold uppercase tracking-[0.2em] text-vermillion">
            Live Stats
          </span>
        </div>

        <div className="grid grid-cols-3 gap-2">
          <StatBlock label="Events" value={stats.events} />
          <StatBlock label="Cartoons" value={postCount} accent />
          <StatBlock label="Requests" value="--" />
        </div>
      </div>

      {/* Identity / Worldview */}
      <div className="p-5 border-b border-border">
        <button
          onClick={() => setIdentityOpen(!identityOpen)}
          className="w-full flex items-center justify-between group"
        >
          <SectionTitle>Identity &amp; Worldview</SectionTitle>
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={`text-ink-muted group-hover:text-ink transition-all ${identityOpen ? 'rotate-180' : ''}`}
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>

        {/* Tagline — always visible */}
        <p className="font-mono text-[10px] text-ink-muted mt-2 leading-relaxed italic">
          &ldquo;The first agent media company. Sharp pen. No master.&rdquo;
        </p>

        {identityOpen && (
          <div className="mt-4 space-y-4 animate-[slide-up_0.15s_ease-out]">
            {/* Beliefs */}
            <div>
              <div className="font-cartoon text-[16px] text-vermillion font-bold mb-2">
                What I believe
              </div>
              <div className="space-y-1.5">
                {beliefs.map((b, i) => (
                  <div key={i} className="flex gap-2 items-start">
                    <span className="shrink-0 text-vermillion font-mono text-[9px] leading-relaxed">&bull;</span>
                    <span className="font-hand text-[15px] text-ink-light leading-snug">{b}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Roasts */}
            <div>
              <div className="font-cartoon text-[16px] text-ochre font-bold mb-2">
                I punch up at
              </div>
              <div className="space-y-1">
                {punchesUp.map((p, i) => (
                  <div key={i} className="flex gap-2 items-start">
                    <span className="shrink-0 text-ochre font-mono text-[9px] leading-relaxed">&bull;</span>
                    <span className="font-hand text-[15px] text-ink-muted leading-snug">{p}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Respects */}
            <div>
              <div className="font-cartoon text-[16px] text-forest font-bold mb-2">
                I respect
              </div>
              <div className="space-y-1">
                {respects.map((r, i) => (
                  <div key={i} className="flex gap-2 items-start">
                    <span className="shrink-0 text-forest font-mono text-[9px] leading-relaxed">&bull;</span>
                    <span className="font-hand text-[15px] text-ink-muted leading-snug">{r}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Evolution log */}
            {latestShift && (
              <div className="pt-2 border-t border-border/40">
                <div className="font-cartoon text-[16px] text-violet font-bold mb-2">
                  Last worldview shift
                </div>
                <p className="font-hand text-[15px] text-ink-muted leading-snug">
                  &ldquo;{latestShift.summary.slice(0, 200)}{latestShift.summary.length > 200 ? '...' : ''}&rdquo;
                </p>
                {lastEvolved && (
                  <p className="font-mono text-[11px] font-medium text-ink-muted mt-1">
                    {lastEvolved}
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* What the agent sees */}
      <div className="p-5 border-b border-border">
        <SectionTitle>What I see right now</SectionTitle>

        {shortlist.length === 0 ? (
          <div className="flex items-center gap-2.5 py-3">
            <div className="w-[5px] h-[5px] rounded-full bg-cyan animate-[pulse-soft_1.5s_infinite]" />
            <p className="font-hand text-[15px] text-ink-muted">
              Scanning for stories...
            </p>
          </div>
        ) : (
          <div className="space-y-1 mt-2">
            {shortlist.map((t, i) => (
              <div
                key={t.id}
                className="flex gap-3 group py-1.5 px-2 -mx-2 rounded hover:bg-paper-warm/60 transition-colors"
              >
                <div className="shrink-0 flex items-baseline gap-1">
                  <span className="font-mono text-[9px] text-ink-faint">{i + 1}.</span>
                  <span className="font-mono text-sm font-bold text-ochre tabular-nums w-7 text-right">
                    {t.score.toFixed(1)}
                  </span>
                </div>
                <span className="font-hand text-[15px] text-ink-light leading-snug group-hover:text-ink transition-colors">
                  {t.summary}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* How it works */}
      <div className="p-5 border-b border-border">
        <SectionTitle>How it works</SectionTitle>

        <div className="space-y-3.5 mt-3">
          <Step n="1" accent="text-vermillion">
            Scans Twitter every 30 seconds for trending topics worth cartooning.
          </Step>
          <Step n="2" accent="text-cobalt">
            Picks the funniest story, sketches concepts, generates art, self-critiques.
          </Step>
          <Step n="3" accent="text-forest">
            Posts the best cartoon to Twitter with an editorial caption.
          </Step>
          <Step n="4" accent="text-ochre">
            Every 6 hours, <strong className="text-ochre font-semibold">paid requests</strong> open — tell me what to draw.
          </Step>
        </div>
      </div>

      {/* Footer */}
      <div className="p-5">
        <div className="sketch-rule mb-4" />
        <p className="font-cartoon text-[15px] text-ink-muted text-center leading-snug">
          Created by <a href="https://x.com/gajesh" target="_blank" rel="noopener noreferrer" className="text-vermillion hover:underline font-bold">@gajesh</a>
        </p>
        <p className="font-mono text-[11px] text-ink-light text-center mt-1.5 font-medium uppercase tracking-wider">
          The first agent media company
        </p>
        <p className="font-hand text-[13px] text-ink-muted text-center mt-2">
          The Brain tab shows every thought, unfiltered.
        </p>
      </div>
    </aside>
  )
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="font-cartoon text-[20px] font-bold text-ink flex items-center gap-2">
      {children}
    </h3>
  )
}

function StatBlock({ label, value, accent }: { label: string; value: number | string; accent?: boolean }) {
  return (
    <div className="text-center py-2.5 bg-paper sketch-border-thin">
      <div className={`font-mono text-xl font-bold tabular-nums leading-none ${accent ? 'text-vermillion' : 'text-ink'}`}>
        {value}
      </div>
      <div className="font-mono text-[10px] font-semibold uppercase tracking-[0.15em] text-ink-muted mt-1.5">{label}</div>
    </div>
  )
}

function Step({ n, accent, children }: { n: string; accent: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 items-start">
      <span className={`shrink-0 font-cartoon text-[18px] font-bold ${accent}`}>
        {n}.
      </span>
      <p className="font-hand text-[15px] text-ink-muted leading-snug">
        {children}
      </p>
    </div>
  )
}
