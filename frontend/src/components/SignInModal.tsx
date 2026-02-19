import { useState, useRef, useEffect } from 'react'
import { useLoginWithEmail, useLoginWithOAuth, useConnectWallet } from '@privy-io/react-auth'

type Step = 'choose' | 'email-input' | 'email-code'

interface Props {
  open: boolean
  onClose: () => void
}

export function SignInModal({ open, onClose }: Props) {
  const [step, setStep] = useState<Step>('choose')
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [agreed] = useState(true)
  const inputRef = useRef<HTMLInputElement>(null)

  const { sendCode, loginWithCode, state: emailState } = useLoginWithEmail({
    onComplete: () => { reset(); onClose() },
    onError: (err) => setError(typeof err === 'string' ? err : 'Login failed. Try again.'),
  })

  const { initOAuth, state: oauthState } = useLoginWithOAuth({
    onComplete: () => { reset(); onClose() },
    onError: () => setError('OAuth login failed. Try again.'),
  })

  const { connectWallet } = useConnectWallet({
    onSuccess: () => { reset(); onClose() },
    onError: () => setError('Wallet connection failed.'),
  })

  useEffect(() => {
    if (open) { setStep('choose'); setError(''); setCode('') }
  }, [open])

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 100)
  }, [open, step])

  function reset() {
    setStep('choose')
    setEmail('')
    setCode('')
    setError('')
  }

  async function handleSendCode() {
    if (!email.includes('@')) { setError('Enter a valid email'); return }
    setError('')
    try {
      await sendCode({ email })
      setStep('email-code')
      setCode('')
    } catch {
      setError('Could not send code. Try again.')
    }
  }

  async function handleVerify() {
    if (code.length < 6) { setError('Enter the 6-digit code'); return }
    setError('')
    try {
      await loginWithCode({ code })
    } catch {
      setError('Invalid code. Try again.')
    }
  }

  if (!open) return null

  const loading = emailState.status === 'sending-code' || emailState.status === 'submitting-code'
    || oauthState.status === 'loading'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-ink/40 backdrop-blur-sm animate-[fade-in_0.15s_ease-out]" />

      <div
        className="relative cartoon-panel bg-paper-bright max-w-sm w-full p-8 animate-[slide-up_0.2s_ease-out]"
        onClick={e => e.stopPropagation()}
      >
        {/* Close */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-ink-muted hover:text-ink transition-colors"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>

        {step === 'choose' && (
          <>
            <h2 className="font-cartoon text-[32px] font-bold text-ink leading-none mb-1">
              Sign in to Sovra
            </h2>
            <p className="font-hand text-[16px] text-ink-muted mb-6">Pull up a chair.</p>

            {/* OAuth buttons */}
            <div className="space-y-2.5 mb-5">
              <OAuthButton
                label="Continue with Google"
                icon={<GoogleIcon />}
                onClick={() => initOAuth({ provider: 'google' })}
                disabled={loading || !agreed}
              />
              <OAuthButton
                label="Continue with X"
                icon={<XIcon />}
                onClick={() => initOAuth({ provider: 'twitter' })}
                disabled={loading || !agreed}
              />
            </div>

            <Divider />

            {/* Email input */}
            <div className="mb-5">
              <input
                ref={inputRef}
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleSendCode()}
                placeholder="your@email.com"
                className="w-full px-4 py-2.5 sketch-border-thin bg-paper-bright text-ink font-mono text-[14px] placeholder:text-ink-faint focus:outline-none focus:border-vermillion/50 transition-all"
              />
              <button
                onClick={handleSendCode}
                disabled={loading || !email || !agreed}
                className="w-full mt-2.5 py-2.5 cartoon-btn bg-ink disabled:bg-ink-faint disabled:text-ink-muted text-paper-bright font-mono text-[12px] font-bold uppercase tracking-widest"
              >
                {emailState.status === 'sending-code' ? 'Sending...' : 'Continue with Email'}
              </button>
            </div>

            <Divider />

            {/* Wallet */}
            <button
              onClick={() => connectWallet()}
              disabled={loading || !agreed}
              className="w-full py-2.5 cartoon-btn bg-paper-warm text-ink font-mono text-[12px] font-bold uppercase tracking-widest flex items-center justify-center gap-2 disabled:opacity-50"
            >
              <WalletIcon />
              Connect Wallet
            </button>

            <p className="mt-5 font-mono text-[11px] text-ink-muted leading-snug text-center">
              By continuing, you agree to the{' '}
              <a href="/legal" target="_blank" rel="noopener noreferrer" className="text-vermillion hover:underline">
                Terms of Service &amp; Privacy Policy
              </a>
            </p>
          </>
        )}

        {step === 'email-code' && (
          <>
            <h2 className="font-cartoon text-[28px] font-bold text-ink leading-none mb-1">
              Check your inbox
            </h2>
            <p className="font-hand text-[15px] text-ink-muted mb-6">
              Code sent to <span className="text-ink font-medium">{email}</span>
            </p>

            <input
              ref={inputRef}
              type="text"
              inputMode="numeric"
              maxLength={6}
              value={code}
              onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              onKeyDown={e => e.key === 'Enter' && handleVerify()}
              placeholder="000000"
              className="w-full px-4 py-3 sketch-border-thin bg-paper-bright text-ink font-mono text-[24px] text-center tracking-[0.5em] placeholder:text-ink-faint focus:outline-none focus:border-vermillion/50 transition-all"
            />

            <button
              onClick={handleVerify}
              disabled={loading || code.length < 6}
              className="w-full mt-4 py-2.5 cartoon-btn bg-vermillion disabled:bg-ink-faint disabled:text-ink-muted text-paper-bright font-mono text-[12px] font-bold uppercase tracking-widest"
            >
              {emailState.status === 'submitting-code' ? 'Verifying...' : 'Verify'}
            </button>

            <div className="flex items-center justify-between mt-4">
              <button
                onClick={handleSendCode}
                disabled={loading}
                className="font-mono text-[11px] text-ink-muted hover:text-vermillion transition-colors"
              >
                Resend code
              </button>
              <button
                onClick={() => { setStep('choose'); setCode(''); setError('') }}
                className="font-mono text-[11px] text-ink-muted hover:text-ink transition-colors"
              >
                Back
              </button>
            </div>
          </>
        )}

        {/* Error display */}
        {error && (
          <p className="mt-4 font-mono text-[11px] text-vermillion text-center">{error}</p>
        )}
      </div>
    </div>
  )
}

function Divider() {
  return (
    <div className="flex items-center gap-3 my-4">
      <div className="flex-1 sketch-rule-thin" />
      <span className="font-mono text-[10px] text-ink-faint uppercase tracking-wider">or</span>
      <div className="flex-1 sketch-rule-thin" />
    </div>
  )
}

function OAuthButton({ label, icon, onClick, disabled }: { label: string; icon: React.ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="w-full py-2.5 cartoon-btn bg-paper-warm hover:bg-paper-warm/80 text-ink font-mono text-[12px] font-bold uppercase tracking-widest flex items-center justify-center gap-2.5 disabled:opacity-50"
    >
      {icon}
      {label}
    </button>
  )
}

function GoogleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24">
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
    </svg>
  )
}

function XIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
    </svg>
  )
}

function WalletIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"/>
      <path d="M3 5v14a2 2 0 0 0 2 2h16v-5"/>
      <path d="M18 12a2 2 0 0 0 0 4h4v-4z"/>
    </svg>
  )
}
