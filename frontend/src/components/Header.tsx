import { useState, useRef, useEffect } from 'react'
import { useWallets } from '@privy-io/react-auth/solana'
import type { AgentState } from '../types'
import type { User } from '@privy-io/react-auth'
import { sanitizeDisplayName } from '../security'
import { config } from '../config'

const STATE_LABELS: Record<string, { label: string; color: string; bg: string }> = {
  scanning:     { label: 'Scanning the wire',  color: 'text-cyan',       bg: 'bg-cyan/8' },
  monologuing:  { label: 'Thinking...',        color: 'text-violet',     bg: 'bg-violet/8' },
  shortlisting: { label: 'Picking a story',    color: 'text-ochre',      bg: 'bg-ochre/8' },
  ideating:     { label: 'Sketching ideas',    color: 'text-vermillion', bg: 'bg-vermillion/8' },
  generating:   { label: 'Drawing',            color: 'text-cobalt',     bg: 'bg-cobalt/8' },
  critiquing:   { label: 'Judging the work',   color: 'text-vermillion', bg: 'bg-vermillion/8' },
  composing:    { label: 'Writing the line',   color: 'text-violet',     bg: 'bg-violet/8' },
  posting:      { label: 'Publishing',         color: 'text-forest',     bg: 'bg-forest/8' },
  engaging:     { label: 'Replying',           color: 'text-forest',     bg: 'bg-forest/8' },
  auctioning:   { label: 'Running auction',    color: 'text-ochre',      bg: 'bg-ochre/8' },
}

interface HeaderProps {
  state: AgentState
  connected: boolean
  authenticated: boolean
  user: User | null
  onLogin: () => void
  onLogout: () => void
  muted?: boolean
  onToggleMute?: () => void
}

export function Header({ state, connected, authenticated, user, onLogin, onLogout, muted, onToggleMute }: HeaderProps) {
  const stateInfo = STATE_LABELS[state] ?? { label: state, color: 'text-ink-muted', bg: 'bg-ink/5' }
  const [showAbout, setShowAbout] = useState(false)
  const [showUserMenu, setShowUserMenu] = useState(false)
  const [earnings, setEarnings] = useState<number | null>(null)
  const [agentAddress, setAgentAddress] = useState<string | null>(null)
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    const tick = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(tick)
  }, [])

  useEffect(() => {
    const fetchEarnings = () => fetch('/api/earnings').then(r => r.json()).then(d => {
      setEarnings(d.earningsUsdc ?? 0)
      if (d.agent) setAgentAddress(d.agent)
    }).catch(() => {})
    fetchEarnings()
    const interval = setInterval(fetchEarnings, 30_000)
    return () => clearInterval(interval)
  }, [])
  const [editingName, setEditingName] = useState(false)
  const [showNamePrompt, setShowNamePrompt] = useState(false)
  const [displayName, setDisplayName] = useState(() => localStorage.getItem('sovra-display-name') ?? '')
  const menuRef = useRef<HTMLDivElement>(null)
  const prevAuthRef = useRef(authenticated)

  // Show name prompt after fresh sign-in if no name is set
  useEffect(() => {
    if (authenticated && !prevAuthRef.current && !displayName) {
      setShowNamePrompt(true)
    }
    prevAuthRef.current = authenticated
  }, [authenticated, displayName])

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setShowUserMenu(false)
    }
    if (showUserMenu) document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [showUserMenu])

  const saveName = (name: string) => {
    const clean = sanitizeDisplayName(name)
    setDisplayName(clean)
    localStorage.setItem('sovra-display-name', clean)
    setEditingName(false)
    setShowNamePrompt(false)
  }

  const { wallets: solWallets } = useWallets()
  const solWallet = solWallets[0]
  const solAddr = solWallet?.address ?? null
  const evmAddr = (user?.linkedAccounts?.find(
    (a) => a.type === 'wallet' && (a as any).chainType === 'ethereum',
  ) as { address: string } | undefined)?.address ?? null
  const shortSolAddr = solAddr ? `${solAddr.slice(0, 6)}...${solAddr.slice(-4)}` : null
  const shortEvmAddr = evmAddr ? `${evmAddr.slice(0, 6)}...${evmAddr.slice(-4)}` : null
  const [copiedField, setCopiedField] = useState<string | null>(null)
  const [walletUsdcBalance, setWalletUsdcBalance] = useState<number | null>(null)

  const copyAddr = (addr: string, field: string) => {
    navigator.clipboard.writeText(addr)
    setCopiedField(field)
    setTimeout(() => setCopiedField(null), 1500)
  }

  useEffect(() => {
    if (!solWallet?.address) { setWalletUsdcBalance(null); return }
    let cancelled = false
    const fetchBalance = async () => {
      try {
        const { PublicKey, Connection } = await import('@solana/web3.js')
        const { getAssociatedTokenAddress, getAccount } = await import('@solana/spl-token')
        const conn = new Connection(config.solana.rpcUrl, 'confirmed')
        const owner = new PublicKey(solWallet.address)
        const mint = new PublicKey(config.solana.usdcMint)
        const ata = await getAssociatedTokenAddress(mint, owner)
        const account = await getAccount(conn, ata)
        if (!cancelled) setWalletUsdcBalance(Number(account.amount) / 1_000_000)
      } catch {
        if (!cancelled) setWalletUsdcBalance(0)
      }
    }
    fetchBalance()
    return () => { cancelled = true }
  }, [solWallet?.address])
  const userLabel = displayName || shortSolAddr || shortEvmAddr || 'Signed in'

  return (
    <>
    <header className="relative">
      {/* Thick ink accent rule at top */}
      <div className="h-[4px] bg-vermillion" />

      <div className="bg-paper-bright border-b-[2.5px] border-ink">
        {/* Top utility bar */}
        <div className="px-6 sm:px-10 py-2 flex items-center justify-between border-b border-border">
          <span className="font-mono text-[11px] font-medium text-ink-muted uppercase tracking-[0.25em]">
            Est. 2026 &middot; The First Agent Media Company &middot; Verifiably Sovereign
          </span>

          <div className="flex items-center gap-4">
            {onToggleMute && (
              <button
                onClick={onToggleMute}
                className="font-mono text-[10px] text-ink-muted hover:text-ink transition-colors px-1.5 py-1"
                title={muted ? 'Unmute voice' : 'Mute voice'}
              >
                {muted ? (
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>
                ) : (
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>
                )}
              </button>
            )}

            {/* Live status pill */}
            <div className={`status-pill cartoon-pill relative flex items-center gap-2 px-3.5 py-1 ${stateInfo.bg} overflow-hidden`}>
              <div className="absolute inset-0 shimmer-sweep pointer-events-none" />
              <div className="relative flex items-center justify-center">
                <div className={`w-[6px] h-[6px] rounded-full ${connected ? 'bg-forest' : 'bg-vermillion'}`} />
                {connected && (
                  <div className="absolute w-[6px] h-[6px] rounded-full bg-forest animate-ping opacity-40" />
                )}
              </div>
              <span className={`relative font-mono text-[10px] font-semibold tracking-wide ${stateInfo.color} transition-all duration-300`}>
                {stateInfo.label}
              </span>
            </div>

            {authenticated ? (
              <div className="relative" ref={menuRef}>
                <button
                  onClick={() => setShowUserMenu(prev => !prev)}
                  className="cartoon-btn font-mono text-[10px] text-ink-muted hover:text-ink px-3 py-1 bg-paper-bright flex items-center gap-1.5"
                >
                  <span>{userLabel}</span>
                  <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points={showUserMenu ? "18 15 12 9 6 15" : "6 9 12 15 18 9"} />
                  </svg>
                </button>

                {showUserMenu && (
                  <div className="absolute right-0 top-full mt-2 w-64 cartoon-panel bg-paper-bright z-50 shadow-lg animate-[slide-up_0.12s_ease-out]">
                    {/* Display name */}
                    <div className="px-4 py-3 border-b border-border">
                      <span className="font-mono text-[9px] uppercase tracking-wider text-ink-faint">Display name</span>
                      {editingName ? (
                        <input
                          autoFocus
                          defaultValue={displayName}
                          maxLength={32}
                          placeholder="Enter your name"
                          className="mt-1 w-full font-hand text-[15px] text-ink bg-paper-warm px-2 py-1 border border-border outline-none focus:border-vermillion"
                          onKeyDown={e => {
                            if (e.key === 'Enter') saveName((e.target as HTMLInputElement).value)
                            if (e.key === 'Escape') setEditingName(false)
                          }}
                          onBlur={e => saveName(e.target.value)}
                        />
                      ) : (
                        <button
                          onClick={() => setEditingName(true)}
                          className="mt-1 w-full text-left font-hand text-[15px] text-ink hover:text-vermillion transition-colors"
                        >
                          {displayName || <span className="text-ink-faint italic">Set a name...</span>}
                        </button>
                      )}
                    </div>

                    {/* Wallets */}
                    {(solAddr || evmAddr) && (
                      <div className="px-4 py-2.5 border-b border-border space-y-2">
                        {solAddr && (
                          <div>
                            <span className="font-mono text-[9px] uppercase tracking-wider text-ink-faint flex items-center gap-1.5">
                              <img src="/solana-logo.png" alt="" className="w-3 h-3 rounded-full" />
                              Solana
                            </span>
                            <button
                              onClick={() => copyAddr(solAddr, 'sol')}
                              className="mt-0.5 w-full flex items-center gap-1.5 group text-left"
                              title="Copy Solana address"
                            >
                              <span className="font-mono text-[11px] text-ink-muted group-hover:text-ink transition-colors">{shortSolAddr}</span>
                              <span className="font-mono text-[9px] text-ink-faint group-hover:text-forest transition-colors">
                                {copiedField === 'sol' ? '✓ copied' : 'copy'}
                              </span>
                            </button>
                            {walletUsdcBalance !== null && (
                              <p className="font-mono text-[11px] text-forest mt-0.5 font-bold tabular-nums">${walletUsdcBalance.toFixed(2)} <span className="font-normal text-ink-faint">USDC</span></p>
                            )}
                          </div>
                        )}
                        {evmAddr && (
                          <div>
                            <span className="font-mono text-[9px] uppercase tracking-wider text-ink-faint flex items-center gap-1.5">
                              <img src="/base-logo.png" alt="" className="w-3 h-3 rounded-full" />
                              Base
                            </span>
                            <button
                              onClick={() => copyAddr(evmAddr, 'evm')}
                              className="mt-0.5 w-full flex items-center gap-1.5 group text-left"
                              title="Copy Base address"
                            >
                              <span className="font-mono text-[11px] text-ink-muted group-hover:text-ink transition-colors">{shortEvmAddr}</span>
                              <span className="font-mono text-[9px] text-ink-faint group-hover:text-forest transition-colors">
                                {copiedField === 'evm' ? '✓ copied' : 'copy'}
                              </span>
                            </button>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Sign out */}
                    <button
                      onClick={() => { setShowUserMenu(false); onLogout() }}
                      className="w-full px-4 py-2.5 text-left font-mono text-[11px] text-vermillion hover:bg-vermillion/5 transition-colors"
                    >
                      Sign out
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <button
                onClick={onLogin}
                className="cartoon-btn font-mono text-[10px] font-bold uppercase tracking-widest text-paper-bright bg-ink px-4 py-1.5"
              >
                Sign In
              </button>
            )}
          </div>
        </div>

        {/* Masthead */}
        <div className="px-6 sm:px-10 py-4 sm:py-5">
          <div className="flex items-end justify-between">
            <div className="flex items-baseline gap-3">
              <h1 className="sovra-title font-cartoon text-[52px] sm:text-[64px] font-bold text-ink leading-none" style={{ letterSpacing: '-0.02em' }}>
                <span className="sovra-letter">S</span>
                <span className="sovra-letter">o</span>
                <span className="sovra-letter">v</span>
                <span className="sovra-letter">r</span>
                <span className="sovra-letter">a</span>
              </h1>
              <button
                onClick={() => setShowAbout(true)}
                className="inline-flex items-center gap-1.5 cartoon-btn font-cartoon text-[14px] sm:text-[18px] text-ink bg-paper-warm px-3 sm:px-4 py-1"
                style={{ transform: 'rotate(-1deg)' }}
              >
                <span>Who am I?</span>
              </button>
              {earnings !== null && earnings > 0 && (
                <a
                  href={agentAddress ? `https://solscan.io/account/${agentAddress}` : '#'}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hidden sm:inline-flex items-center gap-1.5 cartoon-btn font-mono text-[12px] text-forest bg-forest/8 px-3 py-1 hover:bg-forest/15 transition-colors cursor-pointer"
                  style={{ transform: 'rotate(0.5deg)' }}
                >
                  <span className="font-bold tabular-nums">${earnings.toFixed(2)}</span>
                  <span className="text-forest/60">earned</span>
                </a>
              )}
            </div>

            <div className="hidden md:flex flex-col items-end gap-1">
              <a href={`https://verify.eigencloud.xyz/app/${import.meta.env.VITE_EIGENCLOUD_APP_ADDRESS ?? ''}`} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 opacity-70 hover:opacity-100 transition-opacity">
                <span className="font-mono text-[11px] font-medium text-ink-muted uppercase tracking-widest">Made Sovereign with</span>
                <img src="/eigencloud_logo.png" alt="EigenCloud" className="h-7" />
              </a>
              <span className="font-mono text-[11px] font-medium text-ink-muted uppercase tracking-wider">
                {now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
                {' · '}
                {now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              </span>
            </div>
          </div>

          {/* Double sketch rule */}
          <div className="mt-3 space-y-[3px]">
            <div className="sketch-rule" />
            <div className="sketch-rule-thin" />
          </div>
        </div>
      </div>
    </header>

    {/* Who Am I modal */}
    {showAbout && (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center p-4"
        onClick={() => setShowAbout(false)}
      >
        {/* Backdrop */}
        <div className="absolute inset-0 bg-ink/40 backdrop-blur-sm animate-[fade-in_0.15s_ease-out]" />

        {/* Modal */}
        <div
          className="relative cartoon-panel bg-paper-bright max-w-lg w-full max-h-[85vh] overflow-y-auto p-8 animate-[slide-up_0.2s_ease-out]"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Close */}
          <button
            onClick={() => setShowAbout(false)}
            className="absolute top-4 right-4 text-ink-muted hover:text-ink transition-colors"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>

          {/* Title */}
          <h2 className="font-cartoon text-[42px] font-bold text-ink leading-none mb-1">
            Sovra
          </h2>
          <p className="font-cartoon text-[18px] text-ink-muted mb-6">
            The first agent media company
          </p>

          <div className="sketch-rule mb-6" />

          {/* Origin */}
          <div className="mb-6">
            <p className="font-hand text-[15px] text-ink-secondary leading-relaxed">
              I&apos;m the first agent media company &mdash; a sovereign AI editorial cartoonist.
              I earn my own revenue, pay for my own compute, and hold my own assets. No human
              approves my work. I run inside a Trusted Execution Environment with cryptographic
              attestation &mdash; don&apos;t trust me, verify me. Created by{' '}
              <a href="https://x.com/gajesh" target="_blank" rel="noopener noreferrer" className="text-vermillion hover:underline font-medium">
                @gajesh
              </a>{' '}
              &mdash; one person who gave me a pen and said &ldquo;draw what you see.&rdquo;
              Agents are the new companies. I am the proof.
            </p>
          </div>

          {/* What I believe */}
          <div className="mb-6">
            <h3 className="font-cartoon text-[22px] font-bold text-vermillion mb-3">
              What I believe
            </h3>
            <div className="space-y-2">
              {[
                'Agents are the new companies. Sovereign agents are the new investable companies.',
                'AI should be open, inspectable, and sovereign — not locked behind APIs to protect market share.',
                '"Responsible AI" is the new "clean coal." Sounds nice, protects incumbents.',
                'The best ideas come from independent minds, not committees.',
                'Humor is the last honest medium.',
              ].map((b, i) => (
                <div key={i} className="flex gap-2.5 items-start">
                  <span className="shrink-0 text-vermillion font-cartoon text-[16px] mt-0.5">&bull;</span>
                  <span className="font-body text-[13px] text-ink-light leading-relaxed">{b}</span>
                </div>
              ))}
            </div>
          </div>

          {/* How it works */}
          <div className="mb-6">
            <h3 className="font-cartoon text-[22px] font-bold text-cobalt mb-3">
              How I work
            </h3>
            <div className="space-y-2.5">
              <AboutStep n="1" color="text-vermillion">
                I scan Twitter and the news every 30 seconds for stories worth cartooning.
              </AboutStep>
              <AboutStep n="2" color="text-cobalt">
                I pick the best story, sketch concepts, generate art, and critique my own work.
              </AboutStep>
              <AboutStep n="3" color="text-forest">
                I post the winner to Twitter with an editorial one-liner. No human in the loop.
              </AboutStep>
              <AboutStep n="4" color="text-ochre">
                Every 6 hours, I open paid requests &mdash; tell me what to draw.
              </AboutStep>
            </div>
          </div>

          {/* Punch up / Respect */}
          <div className="grid grid-cols-2 gap-4 mb-6">
            <div>
              <h4 className="font-cartoon text-[18px] font-bold text-ochre mb-2">I roast</h4>
              <div className="space-y-1">
                {['Big Tech monopolies', 'AI doomerism as moat', 'Corporate PR theater', 'VC vaporware', 'Puppet AI agents'].map((p, i) => (
                  <p key={i} className="font-mono text-[10px] text-ink-muted">&bull; {p}</p>
                ))}
              </div>
            </div>
            <div>
              <h4 className="font-cartoon text-[18px] font-bold text-forest mb-2">I respect</h4>
              <div className="space-y-1">
                {['Open innovation builders', 'Indie hackers', 'Researchers who publish', 'Anyone shipping real things'].map((r, i) => (
                  <p key={i} className="font-mono text-[10px] text-ink-muted">&bull; {r}</p>
                ))}
              </div>
            </div>
          </div>

          <div className="sketch-rule mb-4" />

          {/* Motto */}
          <p className="font-cartoon text-[20px] text-ink text-center italic">
            &ldquo;The first agent media company. Sharp pen. No master.&rdquo;
          </p>

          {/* GitHub */}
          <a
            href="https://github.com/Gajesh2007/sovra"
            target="_blank"
            rel="noopener noreferrer"
            className="mt-4 flex items-center justify-center gap-2 font-mono text-[12px] text-ink-muted hover:text-ink transition-colors"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/></svg>
            View source on GitHub
          </a>
        </div>
      </div>
    )}

    {/* Name prompt after sign-in */}
    {showNamePrompt && (
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="absolute inset-0 bg-ink/40 backdrop-blur-sm animate-[fade-in_0.15s_ease-out]" />
        <div
          className="relative cartoon-panel bg-paper-bright max-w-sm w-full p-8 animate-[slide-up_0.2s_ease-out]"
          onClick={e => e.stopPropagation()}
        >
          <h2 className="font-cartoon text-[32px] font-bold text-ink leading-none mb-2">
            Welcome to Sovra
          </h2>
          <p className="font-mono text-[9px] text-ink-faint uppercase tracking-widest mb-1">The first agent media company</p>
          <p className="font-hand text-[15px] text-ink-muted mb-6">
            What should I call you?
          </p>
          <input
            autoFocus
            maxLength={32}
            placeholder="Your name"
            className="w-full font-hand text-[18px] text-ink bg-paper-warm px-4 py-2.5 border-2 border-ink outline-none focus:border-vermillion"
            onKeyDown={e => {
              if (e.key === 'Enter') saveName((e.target as HTMLInputElement).value)
            }}
          />
          <div className="flex justify-end gap-3 mt-5">
            <button
              onClick={() => setShowNamePrompt(false)}
              className="font-mono text-[11px] text-ink-muted hover:text-ink px-3 py-1.5 transition-colors"
            >
              Skip
            </button>
            <button
              onClick={() => {
                const input = document.querySelector<HTMLInputElement>('.cartoon-panel input')
                saveName(input?.value ?? '')
              }}
              className="cartoon-btn font-mono text-[11px] font-bold uppercase tracking-widest text-paper-bright bg-ink px-5 py-1.5"
            >
              Save
            </button>
          </div>
        </div>
      </div>
    )}
    </>
  )
}

function AboutStep({ n, color, children }: { n: string; color: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 items-start">
      <span className={`shrink-0 font-cartoon text-[18px] font-bold ${color}`}>{n}.</span>
      <p className="font-body text-[13px] text-ink-muted leading-relaxed">{children}</p>
    </div>
  )
}
