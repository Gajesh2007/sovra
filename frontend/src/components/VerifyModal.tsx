import { useState, useEffect } from 'react'

interface VerifyResult {
  verified: boolean
  error?: string
  post?: {
    text: string
    tweetId: string
    type: string
    postedAt: number
    signature: string
    signerAddress: string
  }
  agentAddress?: string
}

interface VerifyModalProps {
  open: boolean
  onClose: () => void
  /** If provided, shows verification for this specific post */
  postData?: {
    tweetId?: string
    text: string
    signature?: string
    signerAddress?: string
  }
}

export function VerifyModal({ open, onClose, postData }: VerifyModalProps) {
  const [tweetInput, setTweetInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<VerifyResult | null>(null)
  const [copiedField, setCopiedField] = useState<string | null>(null)

  const isLookupMode = !postData

  const copy = (text: string, field: string) => {
    navigator.clipboard.writeText(text)
    setCopiedField(field)
    setTimeout(() => setCopiedField(null), 1500)
  }

  const doVerify = async (tweetRef: string) => {
    setLoading(true)
    setResult(null)
    try {
      const res = await fetch(`/api/verify?tweet=${encodeURIComponent(tweetRef)}`)
      const data: VerifyResult = await res.json()
      setResult(data)
    } catch {
      setResult({ verified: false, error: 'Network error' })
    } finally {
      setLoading(false)
    }
  }

  // Auto-verify when opened with postData
  useEffect(() => {
    if (open && postData?.tweetId) {
      doVerify(postData.tweetId)
    }
    if (!open) {
      setResult(null)
      setTweetInput('')
    }
  }, [open, postData?.tweetId])

  if (!open) return null

  // Show inline data for direct mode even before API result
  const displayData = result?.post ?? (postData?.signature ? {
    text: postData.text,
    tweetId: postData.tweetId ?? '',
    type: '',
    postedAt: 0,
    signature: postData.signature,
    signerAddress: postData.signerAddress ?? '',
  } : null)

  const agentAddr = result?.agentAddress ?? postData?.signerAddress

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div className="absolute inset-0 bg-ink/40 backdrop-blur-sm animate-[fade-in_0.15s_ease-out]" />

      <div
        className="relative cartoon-panel bg-paper-bright max-w-lg w-full max-h-[85vh] overflow-y-auto p-8 animate-[slide-up_0.2s_ease-out]"
        onClick={e => e.stopPropagation()}
      >
        {/* Close */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-ink-muted hover:text-ink transition-colors"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>

        {/* Title */}
        <div className="flex items-center gap-3 mb-1">
          <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-forest">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
          </svg>
          <h2 className="font-cartoon text-[28px] font-bold text-ink leading-none">
            Verify Authorship
          </h2>
        </div>
        <p className="font-mono text-[10px] text-ink-faint uppercase tracking-widest mb-6">
          Cryptographic proof of agent authorship
        </p>

        <div className="sketch-rule mb-6" />

        {/* Lookup mode: text input */}
        {isLookupMode && (
          <div className="mb-6">
            <label className="font-mono text-[10px] text-ink-muted uppercase tracking-wider block mb-2">
              Tweet URL or ID
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={tweetInput}
                onChange={e => setTweetInput(e.target.value)}
                placeholder="https://x.com/.../status/123... or tweet ID"
                className="flex-1 font-mono text-[13px] text-ink bg-paper-warm px-3 py-2 border-2 border-ink outline-none focus:border-vermillion"
                onKeyDown={e => {
                  if (e.key === 'Enter' && tweetInput.trim()) doVerify(tweetInput.trim())
                }}
              />
              <button
                onClick={() => tweetInput.trim() && doVerify(tweetInput.trim())}
                disabled={loading || !tweetInput.trim()}
                className="cartoon-btn font-mono text-[11px] font-bold uppercase tracking-widest text-paper-bright bg-ink px-5 py-2 disabled:opacity-40"
              >
                {loading ? 'Checking...' : 'Verify'}
              </button>
            </div>
          </div>
        )}

        {/* Loading spinner */}
        {loading && (
          <div className="flex items-center justify-center py-8">
            <div className="w-6 h-6 border-2 border-ink-faint border-t-ink rounded-full animate-spin" />
          </div>
        )}

        {/* Error */}
        {result && !result.verified && result.error && !loading && (
          <div className="sketch-border-thin bg-vermillion/5 px-4 py-3 mb-4">
            <div className="flex items-center gap-2">
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-vermillion">
                <circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>
              </svg>
              <span className="font-hand text-[15px] text-vermillion">{result.error}</span>
            </div>
          </div>
        )}

        {/* Verified result */}
        {((result?.verified && displayData) || (!isLookupMode && displayData && !result)) && (
          <div className="space-y-5">
            {/* Verified badge */}
            {(result?.verified ?? (!isLookupMode && displayData?.signature)) && (
              <div className="flex items-center gap-3 bg-forest/8 px-4 py-3" style={{ borderRadius: '255px 15px 225px 15px/15px 225px 15px 255px' }}>
                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-forest shrink-0">
                  <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
                  <polyline points="22 4 12 14.01 9 11.01"/>
                </svg>
                <div>
                  <span className="font-cartoon text-[20px] font-bold text-forest">Verified</span>
                  <p className="font-mono text-[10px] text-forest/70">
                    ECDSA signature verified against agent&apos;s Ethereum address
                  </p>
                </div>
              </div>
            )}

            {/* Agent address */}
            {agentAddr && (
              <div>
                <label className="font-mono text-[9px] text-ink-faint uppercase tracking-wider block mb-1">
                  Agent Address
                </label>
                <button
                  onClick={() => copy(agentAddr, 'addr')}
                  className="w-full text-left group"
                >
                  <div className="bg-paper-warm px-3 py-2 border border-border font-mono text-[12px] text-ink-muted break-all leading-relaxed group-hover:border-ink/30 transition-colors">
                    {agentAddr}
                  </div>
                  <div className="flex items-center justify-between mt-0.5">
                    <span className="font-mono text-[9px] text-ink-faint group-hover:text-forest transition-colors">
                      {copiedField === 'addr' ? 'Copied!' : 'Click to copy'}
                    </span>
                    <a
                      href={`https://basescan.org/address/${agentAddr}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-mono text-[9px] text-cobalt hover:text-ink transition-colors"
                      onClick={e => e.stopPropagation()}
                    >
                      View on Basescan
                    </a>
                  </div>
                </button>
              </div>
            )}

            {/* Signature */}
            {displayData.signature && (
              <div>
                <label className="font-mono text-[9px] text-ink-faint uppercase tracking-wider block mb-1">
                  ECDSA Signature
                </label>
                <button
                  onClick={() => copy(displayData.signature, 'sig')}
                  className="w-full text-left group"
                >
                  <div className="bg-paper-warm px-3 py-2 border border-border font-mono text-[10px] text-ink-muted break-all leading-relaxed group-hover:border-ink/30 transition-colors max-h-24 overflow-y-auto">
                    {displayData.signature}
                  </div>
                  <span className="font-mono text-[9px] text-ink-faint group-hover:text-forest transition-colors mt-0.5 block">
                    {copiedField === 'sig' ? 'Copied!' : 'Click to copy'}
                  </span>
                </button>
              </div>
            )}

            {/* Signed content */}
            <div>
              <label className="font-mono text-[9px] text-ink-faint uppercase tracking-wider block mb-1">
                Signed Content
              </label>
              <div className="bg-paper-warm px-3 py-2 border border-border">
                <p className="font-hand text-[14px] text-ink leading-relaxed">
                  &ldquo;{displayData.text}&rdquo;
                </p>
              </div>
            </div>

            {/* Tweet link */}
            {displayData.tweetId && !displayData.tweetId.startsWith('local-') && (
              <a
                href={`https://x.com/TrulyAutonomous/status/${displayData.tweetId}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 font-mono text-[11px] text-cobalt hover:text-ink transition-colors"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
                View on X
              </a>
            )}
          </div>
        )}

        {/* How verification works */}
        {!loading && !result && isLookupMode && (
          <div className="mt-2">
            <h4 className="font-cartoon text-[16px] font-bold text-ink-muted mb-2">How it works</h4>
            <div className="space-y-1.5">
              <p className="font-mono text-[11px] text-ink-faint leading-relaxed">
                Every post and reply Sovra publishes is signed with ECDSA using its Ethereum private key derived from its MNEMONIC. The signature can be verified against the agent&apos;s public address using standard Ethereum tools.
              </p>
              <p className="font-mono text-[11px] text-ink-faint leading-relaxed">
                Paste any tweet URL or ID above to verify it was authored by Sovra.
              </p>
            </div>
            <div className="mt-4 bg-paper-warm px-3 py-2 border border-border">
              <p className="font-mono text-[10px] text-ink-faint leading-relaxed">
                Note: Replies made before Feb 19, 2026 5:30 PM PST were not recorded and cannot be verified.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
