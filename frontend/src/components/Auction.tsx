import { useState, useEffect } from 'react'
import { useSolanaBid } from '../hooks/useSolanaBid'
import { useBaseBid } from '../hooks/useBaseBid'
import { config as appConfig } from '../config'
import { validateBidAmount, validateRequestText, sanitizeText } from '../security'

type Chain = 'solana' | 'base'

interface AuctionState {
  lastSettledAt: number | null
  nextSettleAt: number | null
  settled: boolean
  bidCount: number
  topBid: { bidder: string; amountUsdc: number; requestText: string; chain?: string } | null
}

interface BidEntry {
  chain: string
  bidder: string
  amountUsdc: number
  requestText: string
}

export function Auction({ authenticated, onLogin }: { authenticated: boolean; onLogin: () => void }) {
  const [auctionState, setAuctionState] = useState<AuctionState | null>(null)
  const [bidAmount, setBidAmount] = useState('')
  const [requestText, setRequestText] = useState('')
  const [success, setSuccess] = useState(false)
  const [editing, setEditing] = useState(false)
  const [showAllBids, setShowAllBids] = useState(false)
  const [allBids, setAllBids] = useState<BidEntry[]>([])
  const [imageFile, setImageFile] = useState<File | null>(null)
  const [imagePreview, setImagePreview] = useState<string | null>(null)
  const [uploadedImageUrl, setUploadedImageUrl] = useState<string | null>(null)
  const [moderationStatus, setModerationStatus] = useState<'idle' | 'checking' | 'approved' | 'rejected'>('idle')
  const [activeBidImage, setActiveBidImage] = useState<string | null>(null)
  const [selectedChain, setSelectedChain] = useState<Chain>('solana')

  const solanaBid = useSolanaBid()
  const baseBid = useBaseBid()

  const bid = selectedChain === 'solana' ? solanaBid : baseBid
  const { placeBid, loading, error, txSig, activeBid, usdcBalance, walletAddress } = bid
  const baseNeedsGas = baseBid.needsGas && selectedChain === 'base'

  // Check if user has an active bid on either chain
  const activeBidOnAnyChain = solanaBid.activeBid
    ? { ...solanaBid.activeBid, chain: 'solana' as Chain, walletAddress: solanaBid.walletAddress }
    : baseBid.activeBid
      ? { ...baseBid.activeBid, chain: 'base' as Chain, walletAddress: baseBid.walletAddress }
      : null

  const explorerUrl = selectedChain === 'solana' ? appConfig.solana.explorerUrl : appConfig.base.explorerUrl

  useEffect(() => {
    const addr = activeBidOnAnyChain?.walletAddress
    if (!addr || !activeBidOnAnyChain) { setActiveBidImage(null); return }
    fetch(`/api/auction/request/${addr}`)
      .then(r => r.json())
      .then(d => setActiveBidImage(d.imageUrl ?? null))
      .catch(() => setActiveBidImage(null))
  }, [activeBidOnAnyChain?.walletAddress, activeBidOnAnyChain?.amount])

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch('/api/auction/state')
        setAuctionState(await res.json())
      } catch { /* retry silently */ }
    }
    load()
    const interval = setInterval(load, 10_000)
    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    if (txSig) {
      setSuccess(true)
      if (!activeBid) {
        setBidAmount('')
        setRequestText('')
      }
      setEditing(false)
      const timer = setTimeout(() => setSuccess(false), 5000)
      return () => clearTimeout(timer)
    }
  }, [txSig])

  const timeLeft = auctionState?.nextSettleAt
    ? Math.max(0, auctionState.nextSettleAt - Math.floor(Date.now() / 1000))
    : 0
  const hours = Math.floor(timeLeft / 3600)
  const minutes = Math.floor((timeLeft % 3600) / 60)

  function selectImage(file: File) {
    setImageFile(file)
    setImagePreview(URL.createObjectURL(file))
    setUploadedImageUrl(null)
    setModerationStatus('idle')
  }

  function clearImage() {
    setImageFile(null)
    if (imagePreview) URL.revokeObjectURL(imagePreview)
    setImagePreview(null)
    setUploadedImageUrl(null)
    setModerationStatus('idle')
  }

  async function uploadImage(): Promise<string | null> {
    if (!imageFile) return uploadedImageUrl
    if (uploadedImageUrl) return uploadedImageUrl
    const form = new FormData()
    form.append('file', imageFile)
    const res = await fetch('/api/auction/upload', { method: 'POST', body: form })
    if (!res.ok) throw new Error('Image upload failed')
    const { url } = await res.json()
    setUploadedImageUrl(url)
    return url
  }

  async function moderate(text: string, imgUrl: string | null): Promise<void> {
    const res = await fetch('/api/auction/moderate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, imageUrl: imgUrl }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: 'Content review failed' }))
      throw new Error(body.error ?? 'Request rejected by content policy')
    }
  }

  async function handleSubmit() {
    const amount = Number(bidAmount)
    if (!validateBidAmount(amount) || !validateRequestText(requestText)) return

    setModerationStatus('checking')
    try {
      const imgUrl = await uploadImage()
      await moderate(sanitizeText(requestText), imgUrl)

      // Save request text + image to agent (off-chain) before placing on-chain bid
      if (walletAddress) {
        await fetch('/api/auction/request', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ bidder: walletAddress, requestText: sanitizeText(requestText), imageUrl: imgUrl }),
        })
      }
      await placeBid(amount, sanitizeText(requestText))
      setModerationStatus('approved')
      clearImage()
    } catch (err) {
      setModerationStatus('rejected')
      throw err
    }
  }

  async function handleUpdate() {
    const newAmount = Number(bidAmount)
    const currentAmount = activeBidOnAnyChain?.amount ?? 0
    if (!validateBidAmount(newAmount)) return
    const amountChange = newAmount - currentAmount
    const text = sanitizeText(requestText || activeBidOnAnyChain?.requestText || '')
    if (!validateRequestText(text)) return

    setModerationStatus('checking')
    try {
      const imgUrl = await uploadImage()
      await moderate(text, imgUrl)

      const addr = activeBidOnAnyChain?.walletAddress
      if (addr) {
        await fetch('/api/auction/request', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ bidder: addr, requestText: text, imageUrl: imgUrl }),
        })
      }

      // Use the hook for the chain the bid is actually on
      const bidHook = activeBidOnAnyChain?.chain === 'base' ? baseBid : solanaBid
      await bidHook.updateBid(text, amountChange)
      setModerationStatus('approved')
      clearImage()
    } catch (err) {
      setModerationStatus('rejected')
      throw err
    }
  }

  async function handleWithdraw() {
    const bidHook = activeBidOnAnyChain?.chain === 'base' ? baseBid : solanaBid
    await bidHook.withdrawBid()
    clearImage()
  }

  return (
    <div className="h-full overflow-y-auto bg-paper">
      <div className="sticky top-0 z-10 glass-panel border-b-[2px] border-ink px-6 sm:px-10 py-3">
        <div className="flex items-center gap-3">
          <div className="w-[3px] h-5 bg-ochre rounded-full" />
          <h2 className="font-cartoon text-2xl font-bold text-ink">Requests</h2>
        </div>
      </div>

      <div className="max-w-lg mx-auto px-6 sm:px-8 py-8 space-y-8">
        {/* Hero */}
        <div className="text-center space-y-3">
          <h2 className="font-cartoon text-[36px] sm:text-[42px] font-bold text-ink leading-tight">
            Direct the Pen
          </h2>
          <p className="font-hand text-[16px] text-ink-muted max-w-sm mx-auto leading-snug">
            Tell me what to draw. Your bid persists until you win or withdraw.
            Pay with USDC on Solana or Base.
          </p>
        </div>

        {/* Status board */}
        <div className="cartoon-panel overflow-hidden">
          <div className="px-5 py-3.5 border-b border-border flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="relative flex items-center justify-center">
                <div className={`w-2 h-2 rounded-full ${timeLeft > 0 ? 'bg-forest' : 'bg-ink-faint'}`} />
                {timeLeft > 0 && <div className="absolute w-2 h-2 rounded-full bg-forest animate-ping opacity-40" />}
              </div>
              <span className="font-cartoon text-[18px] font-bold text-ink">
                Accepting Bids
              </span>
            </div>
            {timeLeft > 0 && (
              <span className="font-mono text-xs font-bold text-vermillion tabular-nums">
                Next pick in {hours}h {minutes}m
              </span>
            )}
          </div>

          <div className="grid grid-cols-3 divide-x divide-border">
            <AuctionStat label="Active Bids" value={auctionState?.bidCount ?? 0} />
            <AuctionStat label="Top Offer" value={`$${auctionState?.topBid?.amountUsdc?.toFixed(0) ?? '0'}`} accent />
            <AuctionStat label="Minimum" value="$1" />
          </div>

          {auctionState?.topBid && (
            <div className="px-5 py-4 border-t border-border bg-paper">
              <div className="flex items-center gap-2 mb-1.5">
                <div className="font-mono text-[9px] uppercase tracking-[0.2em] text-ink-faint">Leading request</div>
                {auctionState.topBid.chain && <ChainBadge chain={auctionState.topBid.chain} />}
              </div>
              <p className="font-hand text-[15px] text-ink-light leading-snug">
                &ldquo;{auctionState.topBid.requestText.slice(0, 140)}&rdquo;
              </p>
              <p className="font-mono text-[11px] text-ochre mt-2 font-bold tabular-nums">
                ${auctionState.topBid.amountUsdc} USDC
              </p>
            </div>
          )}

          {(auctionState?.bidCount ?? 0) > 0 && (
            <button
              onClick={async () => {
                if (!showAllBids) {
                  try {
                    const res = await fetch('/api/auction/bids')
                    if (res.ok) setAllBids(await res.json())
                  } catch {}
                }
                setShowAllBids(prev => !prev)
              }}
              className="w-full px-5 py-2.5 border-t border-border text-center font-mono text-[11px] text-ink-muted hover:text-ink hover:bg-paper-warm/50 transition-colors"
            >
              {showAllBids ? 'Hide all bids' : `View all ${auctionState?.bidCount ?? 0} bids`}
            </button>
          )}

          {showAllBids && allBids.length > 0 && (
            <div className="border-t border-border">
              {allBids.map((bid, i) => (
                <div key={bid.bidder} className={`px-5 py-3.5 flex gap-4 ${i > 0 ? 'border-t border-border/50' : ''} ${i === 0 ? 'bg-ochre/5' : 'bg-paper'}`}>
                  <span className="shrink-0 font-mono text-[12px] font-bold text-ink-faint w-5 text-right tabular-nums pt-0.5">{i + 1}.</span>
                  <div className="flex-1 min-w-0">
                    <p className="font-hand text-[14px] text-ink-light leading-snug truncate">
                      &ldquo;{bid.requestText.slice(0, 120)}{bid.requestText.length > 120 ? '...' : ''}&rdquo;
                    </p>
                    <div className="flex items-center gap-2 mt-1">
                      <span className="font-mono text-[11px] font-bold text-ochre tabular-nums">${bid.amountUsdc} USDC</span>
                      <ChainBadge chain={bid.chain} />
                      <span className="font-mono text-[9px] text-ink-faint">{bid.bidder.slice(0, 4)}...{bid.bidder.slice(-4)}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Active bid display */}
        {activeBidOnAnyChain && !editing && (
          <div className="cartoon-panel p-5 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="font-cartoon text-[20px] font-bold text-forest">Your active bid</span>
                <ChainBadge chain={activeBidOnAnyChain.chain} />
              </div>
              <span className="font-mono text-[14px] font-bold text-ochre tabular-nums">${activeBidOnAnyChain.amount} USDC</span>
            </div>
            <p className="font-hand text-[15px] text-ink-light leading-snug">
              &ldquo;{activeBidOnAnyChain.requestText}&rdquo;
            </p>
            {activeBidImage && (
              <div className="mt-3">
                <span className="font-mono text-[9px] uppercase tracking-wider text-ink-faint">Reference image</span>
                <img src={activeBidImage} alt="Bid reference" className="mt-1 w-full max-h-40 object-contain sketch-border-thin bg-paper-warm" />
              </div>
            )}
            <p className="font-hand text-[13px] text-ink-muted">This bid persists until you win or withdraw.</p>
            <div className="flex gap-2 pt-2">
              <button
                onClick={() => {
                  setEditing(true)
                  setRequestText(activeBidOnAnyChain.requestText)
                  setBidAmount(String(activeBidOnAnyChain.amount))
                  setSelectedChain(activeBidOnAnyChain.chain)
                }}
                className="flex-1 py-2.5 cartoon-btn bg-paper-warm text-ink font-cartoon text-[16px]"
              >
                Edit Request
              </button>
              <button
                onClick={handleWithdraw}
                disabled={loading}
                className="flex-1 py-2.5 cartoon-btn bg-vermillion/10 text-vermillion font-cartoon text-[16px]"
              >
                {loading ? 'Processing...' : 'Withdraw'}
              </button>
            </div>
          </div>
        )}

        {success && (
          <div className="sketch-border-light bg-forest/5 p-4 text-center animate-[slide-up_0.2s_ease-out]">
            <p className="font-cartoon text-[20px] text-forest font-bold">
              {activeBidOnAnyChain ? 'Bid updated!' : 'Request submitted!'}
            </p>
            {txSig && txSig !== 'text-only-update' && (
              <p className="font-mono text-[11px] text-forest/60 mt-1">
                <a href={`${explorerUrl}/tx/${txSig}`} target="_blank" rel="noopener noreferrer" className="underline hover:text-forest transition-colors">
                  View on-chain receipt &rarr;
                </a>
              </p>
            )}
          </div>
        )}

        {error && (
          <div className="sketch-border-light bg-vermillion/5 p-4">
            <p className="font-mono text-sm text-vermillion">{error}</p>
          </div>
        )}

        {/* Bid form */}
        {!authenticated ? (
          <button onClick={onLogin} className="w-full py-3.5 cartoon-btn bg-ink text-paper-bright font-cartoon font-bold text-[20px]">
            Sign In to Request
          </button>
        ) : (!activeBidOnAnyChain || editing) ? (
          <div className="space-y-5">
            <FieldGroup label="What should Sovra draw?">
              <textarea
                value={requestText}
                onChange={(e) => setRequestText(e.target.value)}
                placeholder="Roast the latest iPhone... Draw my friend as a superhero..."
                rows={4}
                maxLength={500}
                className="w-full px-4 py-3 sketch-border-thin bg-paper-bright text-ink font-hand text-[15px] placeholder:text-ink-faint focus:outline-none focus:border-cobalt/50 transition-all resize-none leading-snug"
              />
              <div className="text-right font-mono text-[9px] text-ink-faint mt-1 tabular-nums">{requestText.length}/500</div>
            </FieldGroup>

            {/* Reference image (optional) */}
            <FieldGroup label="Reference image (optional)">
              {imagePreview ? (
                <div className="relative">
                  <img src={imagePreview} alt="Reference" className="w-full max-h-48 object-contain sketch-border-thin bg-paper-warm" />
                  <button onClick={clearImage} className="absolute top-2 right-2 w-6 h-6 flex items-center justify-center bg-ink/70 text-paper-bright rounded-full hover:bg-vermillion transition-colors">
                    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                  </button>
                  {moderationStatus === 'checking' && (
                    <div className="absolute inset-0 bg-paper/60 flex items-center justify-center">
                      <span className="font-mono text-[11px] text-ink-muted animate-pulse">Checking content...</span>
                    </div>
                  )}
                </div>
              ) : (
                <label className="flex flex-col items-center gap-2 py-6 sketch-border-thin bg-paper-warm/50 cursor-pointer hover:bg-paper-warm transition-colors">
                  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-ink-faint"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>
                  <span className="font-hand text-[14px] text-ink-muted">Drop an image or click to upload</span>
                  <span className="font-mono text-[9px] text-ink-faint">JPEG, PNG, WebP, GIF &middot; Max 5MB</span>
                  <input type="file" accept="image/jpeg,image/png,image/webp,image/gif" className="hidden" onChange={e => { if (e.target.files?.[0]) selectImage(e.target.files[0]) }} />
                </label>
              )}
            </FieldGroup>

            {/* Amount + chain toggle inline */}
            <FieldGroup label="Your offer (USDC)">
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <span className="absolute left-4 top-1/2 -translate-y-1/2 font-cartoon text-lg text-ink-muted">$</span>
                  <input
                    type="number"
                    min="1"
                    max="100000"
                    step="1"
                    value={bidAmount}
                    onChange={(e) => setBidAmount(e.target.value)}
                    placeholder="1"
                    className="w-full pl-10 pr-4 py-3 sketch-border-thin bg-paper-bright text-ink font-mono text-base placeholder:text-ink-faint focus:outline-none focus:border-cobalt/50 transition-all"
                  />
                </div>
                <ChainToggle selected={selectedChain} onChange={setSelectedChain} />
              </div>

              {bidAmount && !validateBidAmount(Number(bidAmount)) && (
                <p className="mt-1 font-mono text-[10px] text-vermillion">
                  Amount must be $1&ndash;$100,000.
                </p>
              )}

              {/* Balance display */}
              {authenticated && usdcBalance !== null && (
                <div className="mt-2 flex items-center justify-between">
                  <span className="font-mono text-[11px] text-ink-muted">
                    Balance: <span className={`font-bold tabular-nums ${usdcBalance > 0 ? 'text-forest' : 'text-vermillion'}`}>${usdcBalance.toFixed(2)}</span>
                    <span className="text-ink-faint ml-1">USDC on {selectedChain === 'solana' ? 'Solana' : 'Base'}</span>
                  </span>
                  {bidAmount && Number(bidAmount) > usdcBalance && (
                    <span className="font-mono text-[10px] text-vermillion">Insufficient</span>
                  )}
                </div>
              )}

              {/* Base gas warning */}
              {authenticated && baseNeedsGas && (
                <div className="mt-2 sketch-border-light bg-vermillion/5 p-3.5 space-y-2">
                  <div className="flex items-center gap-2">
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-vermillion shrink-0"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                    <span className="font-cartoon text-[14px] font-bold text-vermillion">ETH needed for gas</span>
                  </div>
                  <p className="font-hand text-[13px] text-ink-muted leading-snug">
                    Base requires a tiny amount of ETH to pay for transaction gas (~$0.01).
                    Send at least <span className="font-mono font-bold text-ink">0.0001 ETH</span> on Base to your wallet:
                  </p>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 font-mono text-[11px] text-ink bg-paper-warm px-2.5 py-1.5 break-all select-all">{baseBid.walletAddress}</code>
                    <button onClick={() => navigator.clipboard.writeText(baseBid.walletAddress!)} className="shrink-0 cartoon-btn px-2.5 py-1.5 bg-paper-warm text-ink-muted hover:text-ink" title="Copy address">
                      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
                    </button>
                  </div>
                  {baseBid.ethBalance !== null && (
                    <p className="font-mono text-[10px] text-ink-faint">
                      Current: {baseBid.ethBalance.toFixed(6)} ETH
                    </p>
                  )}
                </div>
              )}

              {authenticated && (solanaBid.walletAddress || baseBid.walletAddress) && (
                <div className="mt-3 sketch-border-light bg-ochre/5 p-3.5 space-y-3">
                  <p className="font-hand text-[14px] text-ink-light leading-snug">
                    Send USDC to your wallet:
                  </p>
                  {solanaBid.walletAddress && (
                    <div>
                      <span className="font-mono text-[9px] uppercase tracking-wider text-ink-faint flex items-center gap-1.5 mb-1">
                        <img src="/solana-logo.png" alt="" className="w-3 h-3 rounded-full" />
                        Solana
                      </span>
                      <div className="flex items-center gap-2">
                        <code className="flex-1 font-mono text-[11px] text-ink bg-paper-warm px-2.5 py-1.5 break-all select-all">{solanaBid.walletAddress}</code>
                        <button onClick={() => navigator.clipboard.writeText(solanaBid.walletAddress!)} className="shrink-0 cartoon-btn px-2.5 py-1.5 bg-paper-warm text-ink-muted hover:text-ink" title="Copy Solana address">
                          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
                        </button>
                      </div>
                    </div>
                  )}
                  {baseBid.walletAddress && (
                    <div>
                      <span className="font-mono text-[9px] uppercase tracking-wider text-ink-faint flex items-center gap-1.5 mb-1">
                        <img src="/base-logo.png" alt="" className="w-3 h-3 rounded-full" />
                        Base
                      </span>
                      <div className="flex items-center gap-2">
                        <code className="flex-1 font-mono text-[11px] text-ink bg-paper-warm px-2.5 py-1.5 break-all select-all">{baseBid.walletAddress}</code>
                        <button onClick={() => navigator.clipboard.writeText(baseBid.walletAddress!)} className="shrink-0 cartoon-btn px-2.5 py-1.5 bg-paper-warm text-ink-muted hover:text-ink" title="Copy Base address">
                          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </FieldGroup>

            <div className="flex gap-2">
              {editing && (
                <button onClick={() => setEditing(false)} className="flex-1 py-3.5 cartoon-btn bg-paper-warm text-ink font-cartoon font-bold text-[18px]">Cancel</button>
              )}
              <button
                onClick={editing ? handleUpdate : handleSubmit}
                disabled={loading || moderationStatus === 'checking' || !bidAmount || !requestText || !validateBidAmount(Number(bidAmount)) || !validateRequestText(requestText) || baseNeedsGas}
                className="flex-1 py-3.5 cartoon-btn bg-vermillion disabled:bg-ink-faint disabled:text-ink-muted disabled:shadow-none text-paper-bright font-cartoon font-bold text-[20px]"
              >
                {moderationStatus === 'checking'
                  ? 'Reviewing content...'
                  : loading
                    ? 'Processing...'
                    : editing
                      ? 'Update Bid'
                      : `Submit Request \u2014 $${bidAmount || '0'}`}
              </button>
            </div>
          </div>
        ) : null}

        {/* Rules */}
        <div className="pt-6">
          <div className="editorial-rule mb-6" />
          <h3 className="font-cartoon text-[22px] font-bold text-ink mb-4">How it works</h3>
          <div className="space-y-2.5">
            <Rule n="I">Write your request and back it with USDC on Solana or Base.</Rule>
            <Rule n="II">Every cycle, Sovra reviews ALL bids across both chains and picks the best one.</Rule>
            <Rule n="III">If you don&apos;t win, your bid carries forward. No re-signing.</Rule>
            <Rule n="IV">Update your request for free. Withdraw your USDC anytime.</Rule>
          </div>
        </div>
      </div>
    </div>
  )
}

// --- Chain toggle with logos ---

function ChainToggle({ selected, onChange }: { selected: Chain; onChange: (chain: Chain) => void }) {
  return (
    <div className="flex sketch-border-thin overflow-hidden shrink-0">
      <button
        onClick={() => onChange('solana')}
        className={`flex items-center gap-1.5 px-3 py-2.5 transition-all ${
          selected === 'solana' ? 'bg-ink text-paper-bright' : 'bg-paper-bright text-ink-muted hover:text-ink'
        }`}
        title="Pay with Solana"
      >
        <img src="/solana-logo.png" alt="Solana" className="w-4 h-4 rounded-full" />
        <span className="font-mono text-[11px] font-bold">SOL</span>
      </button>
      <div className="w-px bg-border" />
      <button
        onClick={() => onChange('base')}
        className={`flex items-center gap-1.5 px-3 py-2.5 transition-all ${
          selected === 'base' ? 'bg-ink text-paper-bright' : 'bg-paper-bright text-ink-muted hover:text-ink'
        }`}
        title="Pay with Base"
      >
        <img src="/base-logo.png" alt="Base" className="w-4 h-4 rounded-full" />
        <span className="font-mono text-[11px] font-bold">BASE</span>
      </button>
    </div>
  )
}

function ChainBadge({ chain }: { chain: string }) {
  const isSolana = chain === 'solana'
  return (
    <span className={`inline-flex items-center gap-1 font-mono text-[8px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-sm ${
      isSolana ? 'bg-cobalt/10 text-cobalt' : 'bg-forest/10 text-forest'
    }`}>
      <img src={isSolana ? '/solana-logo.png' : '/base-logo.png'} alt="" className="w-2.5 h-2.5 rounded-full" />
      {isSolana ? 'SOL' : 'BASE'}
    </span>
  )
}

function FieldGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="font-cartoon text-[16px] text-ink-muted block mb-2">{label}</label>
      {children}
    </div>
  )
}

function AuctionStat({ label, value, accent }: { label: string; value: number | string; accent?: boolean }) {
  return (
    <div className="text-center py-4">
      <div className={`font-mono text-2xl font-bold tabular-nums leading-none ${accent ? 'text-ochre' : 'text-ink'}`}>{value}</div>
      <div className="font-mono text-[10px] font-semibold uppercase tracking-[0.15em] text-ink-muted mt-1.5">{label}</div>
    </div>
  )
}

function Rule({ n, children }: { n: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="font-cartoon text-[18px] text-vermillion shrink-0 w-6 text-right font-bold">{n}.</span>
      <span className="font-hand text-[15px] text-ink-muted leading-snug">{children}</span>
    </div>
  )
}
