import { useState, useEffect } from 'react'
import { usePrivy } from '@privy-io/react-auth'
import { useConsoleStream } from './hooks/useConsoleStream'
import { useFeed } from './hooks/useFeed'
import { useVoiceStream } from './hooks/useVoiceStream'
import { Header } from './components/Header'
import { Monologue } from './components/Monologue'
import { Feed } from './components/Feed'
import { Auction } from './components/Auction'
import { Sidebar } from './components/Sidebar'
import { VoiceIndicator } from './components/VoiceIndicator'
import { SignInModal } from './components/SignInModal'
import { Legal } from './components/Legal'

type Tab = 'console' | 'feed' | 'auction'

const TABS: { id: Tab; label: string; sublabel: string }[] = [
  { id: 'console', label: 'The Brain', sublabel: 'Live thoughts' },
  { id: 'feed', label: 'Gallery', sublabel: 'Published work' },
  { id: 'auction', label: 'Requests', sublabel: 'Direct the pen' },
]

export default function App() {
  const [page, setPage] = useState<'main' | 'legal'>(() =>
    window.location.pathname === '/legal' ? 'legal' : 'main'
  )

  if (page === 'legal') {
    return <Legal onBack={() => { window.history.pushState({}, '', '/'); setPage('main') }} />
  }

  const [muted, setMuted] = useState(() => localStorage.getItem('sound-muted') === 'true')
  const toggleMute = () => {
    setMuted(prev => {
      const next = !prev
      localStorage.setItem('sound-muted', String(next))
      return next
    })
  }
  const { speaking, currentText, enqueue: enqueueVoice, blocked: audioBlocked } = useVoiceStream({ muted })
  const { entries, agentState, connected, shortlist, stats } = useConsoleStream({
    onEvent: (_type, rawEvent) => {
      if (rawEvent?.type === 'voice') {
        enqueueVoice(rawEvent as { type: 'voice'; url: string; text: string; ts: number })
      }
    },
  })
  const posts = useFeed()
  const params = new URLSearchParams(window.location.search)
  const viewEverything = params.get('view_everything') === 'true'
  const [tab, setTab] = useState<Tab>('console')
  const [compareMode, setCompareMode] = useState(() => params.get('opengallery') === 'true')
  const { authenticated, user, logout } = usePrivy()
  const [showSignIn, setShowSignIn] = useState(false)
  const openSignIn = () => setShowSignIn(true)

  if (viewEverything) {
    return (
      <div className="h-screen flex flex-col bg-paper">
        <Header
          state={agentState}
          connected={connected}
          authenticated={authenticated}
          user={user}
          onLogin={openSignIn}
          onLogout={logout}
          muted={muted}
          onToggleMute={toggleMute}
        />

        {speaking && (
          <div className="bg-paper-bright border-b border-border/60 px-6 sm:px-10 py-1.5">
            <VoiceIndicator speaking={speaking} text={currentText} />
          </div>
        )}

        <div className="flex-1 grid grid-cols-[1fr_1fr_360px] min-h-0">
          {/* The Brain */}
          <div className="min-h-0 overflow-hidden border-r-[2px] border-ink">
            <div className="sticky top-0 z-10 glass-panel border-b-[2px] border-ink px-4 py-2">
              <div className="flex items-center gap-2">
                <div className="w-[3px] h-4 bg-cobalt rounded-full" />
                <span className="font-cartoon text-[16px] font-bold text-ink">The Brain</span>
                <span className="font-mono text-[9px] text-ink-faint uppercase tracking-wider">Live thoughts</span>
              </div>
            </div>
            <Monologue entries={entries} compareMode={false} onToggleCompare={() => {}} />
          </div>

          {/* Gallery */}
          <div className="min-h-0 overflow-hidden border-r-[2px] border-ink">
            <Feed posts={posts} streamMode />
          </div>

          {/* Bids (read-only) + Sidebar */}
          <div className="min-h-0 overflow-y-auto">
            <StreamBidsPanel />
            <div className="border-t-[2px] border-ink">
              <Sidebar stats={stats} shortlist={shortlist} agentState={agentState} postCount={posts.length} />
            </div>
          </div>
        </div>

        <SignInModal open={showSignIn} onClose={() => setShowSignIn(false)} />
      </div>
    )
  }

  return (
    <div className="h-screen flex flex-col bg-paper">
      <Header
        state={agentState}
        connected={connected}
        authenticated={authenticated}
        user={user}
        onLogin={openSignIn}
        onLogout={logout}
        muted={muted}
        onToggleMute={toggleMute}
      />

      <SignInModal open={showSignIn} onClose={() => setShowSignIn(false)} />

      {/* Audio blocked prompt */}
      {audioBlocked && !muted && (
        <div className="bg-ochre/10 border-b-[2px] border-ochre/30 px-6 sm:px-10 py-2 flex items-center justify-center gap-2 cursor-pointer" onClick={() => {}}>
          <span className="font-hand text-[15px] text-ochre">Click anywhere to enable Sovra&apos;s voice</span>
        </div>
      )}

      {/* Voice indicator */}
      {speaking && (
        <div className="bg-paper-bright border-b border-border/60 px-6 sm:px-10 py-1.5">
          <VoiceIndicator speaking={speaking} text={currentText} />
        </div>
      )}

      {/* Section navigation */}
      <nav className="bg-paper-bright border-b-[2px] border-ink px-6 sm:px-10">
        <div className="flex items-stretch gap-0">
          {TABS.map(({ id, label, sublabel }) => {
            const isActive = tab === id
            return (
              <button
                key={id}
                onClick={() => setTab(id)}
                className={`relative px-5 sm:px-7 py-3 transition-all group ${
                  isActive ? '' : 'hover:bg-paper-warm/50'
                }`}
              >
                {/* Active indicator — thick ink underline */}
                {isActive && (
                  <div className="absolute bottom-0 left-2 right-2 h-[4px] bg-vermillion" style={{ borderRadius: '255px 15px 225px 15px/15px 225px 15px 255px' }} />
                )}

                <div className="flex items-center gap-2">
                  <span className={`font-cartoon text-[20px] font-bold transition-colors ${
                    isActive ? 'text-ink' : 'text-ink-muted group-hover:text-ink-light'
                  }`}>
                    {label}
                  </span>

                  {id === 'feed' && posts.length > 0 && (
                    <span className="font-mono text-[9px] font-bold text-paper-bright bg-vermillion px-1.5 py-0.5 rounded-full leading-none">
                      {posts.length}
                    </span>
                  )}
                  {id === 'auction' && (
                    <span className="inline-block w-[6px] h-[6px] rounded-full bg-ochre animate-[pulse-soft_2s_infinite]" />
                  )}
                </div>

                <span className={`block font-mono text-[11px] font-medium uppercase tracking-wider mt-0.5 transition-colors ${
                  isActive ? 'text-ink-muted' : 'text-ink-faint'
                }`}>
                  {sublabel}
                </span>
              </button>
            )
          })}
        </div>
      </nav>

      {/* Main content area */}
      <div className={`flex-1 layout-grid grid min-h-0 ${
        compareMode && tab === 'console'
          ? 'grid-cols-[1fr_1fr_360px]'
          : 'grid-cols-[1fr_360px]'
      }`}>
        <main className="min-h-0 overflow-hidden border-r-[2px] border-ink">
          {tab === 'console' && <Monologue entries={entries} compareMode={compareMode} onToggleCompare={() => setCompareMode(!compareMode)} />}
          {tab === 'feed' && <Feed posts={posts} />}
          {tab === 'auction' && <Auction authenticated={authenticated} onLogin={openSignIn} />}
        </main>
        {compareMode && tab === 'console' && (
          <div className="min-h-0 overflow-hidden border-r-[2px] border-ink">
            <Feed posts={posts} />
          </div>
        )}
        <div className="sidebar-panel">
          <Sidebar stats={stats} shortlist={shortlist} agentState={agentState} postCount={posts.length} />
        </div>
      </div>
    </div>
  )
}

function StreamBidsPanel() {
  const [state, setState] = useState<{ nextSettleAt: number | null; bidCount: number; topBid: { bidder: string; amountUsdc: number; requestText: string; chain?: string } | null } | null>(null)
  const [bids, setBids] = useState<{ chain: string; bidder: string; amountUsdc: number; requestText: string }[]>([])

  useEffect(() => {
    const load = async () => {
      try {
        const [s, b] = await Promise.all([
          fetch('/api/auction/state').then(r => r.json()),
          fetch('/api/auction/bids').then(r => r.json()),
        ])
        setState(s)
        setBids(b)
      } catch {}
    }
    load()
    const interval = setInterval(load, 10_000)
    return () => clearInterval(interval)
  }, [])

  const timeLeft = state?.nextSettleAt
    ? Math.max(0, state.nextSettleAt - Math.floor(Date.now() / 1000))
    : 0

  return (
    <div className="bg-paper">
      <div className="sticky top-0 z-10 glass-panel border-b-[2px] border-ink px-4 py-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-[3px] h-4 bg-ochre rounded-full" />
            <span className="font-cartoon text-[16px] font-bold text-ink">Requests</span>
            <span className="font-mono text-[9px] text-ink-faint uppercase tracking-wider">
              {state?.bidCount ?? 0} bids
            </span>
          </div>
          {timeLeft > 0 && (
            <span className="font-mono text-[10px] font-bold text-vermillion tabular-nums">
              {Math.floor(timeLeft / 3600)}h {Math.floor((timeLeft % 3600) / 60)}m
            </span>
          )}
        </div>
      </div>

      {bids.length === 0 ? (
        <div className="px-4 py-8 text-center">
          <p className="font-hand text-[15px] text-ink-muted">No active bids yet.</p>
          <p className="font-mono text-[10px] text-ink-faint mt-1">Bids appear here when placed.</p>
        </div>
      ) : (
        <div>
          {bids.map((bid, i) => (
            <div key={bid.bidder} className={`px-4 py-3 border-b border-border/50 ${i === 0 ? 'bg-ochre/5' : ''}`}>
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-1.5">
                  <span className="font-mono text-[11px] font-bold text-ochre tabular-nums">
                    ${bid.amountUsdc} USDC
                  </span>
                  <span className={`font-mono text-[8px] font-bold uppercase px-1 py-0.5 rounded-sm ${bid.chain === 'solana' ? 'bg-cobalt/10 text-cobalt' : 'bg-forest/10 text-forest'}`}>
                    {bid.chain === 'solana' ? 'SOL' : 'BASE'}
                  </span>
                </div>
                <span className="font-mono text-[9px] text-ink-faint">
                  {bid.bidder.slice(0, 4)}...{bid.bidder.slice(-4)}
                </span>
              </div>
              <p className="font-hand text-[13px] text-ink-light leading-snug">
                &ldquo;{bid.requestText.slice(0, 100)}{bid.requestText.length > 100 ? '...' : ''}&rdquo;
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
