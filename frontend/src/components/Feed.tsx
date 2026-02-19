import { useState, useEffect, useRef, useCallback } from 'react'
import type { LocalPost } from '../types'
import { TweetEmbed } from './TweetEmbed'
import { sanitizeImagePath, sanitizeImageUrl, sanitizeVideoPath } from '../security'

type ViewMode = 'feed' | 'gallery'

function VideoOverlay({ src, onClose }: { src: string; onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-ink/85 backdrop-blur-sm animate-[fade-in_0.15s_ease-out]"
      onClick={onClose}
    >
      <div className="relative max-w-4xl w-full" onClick={e => e.stopPropagation()}>
        <button
          onClick={onClose}
          className="absolute -top-10 right-0 text-paper-bright/80 hover:text-paper-bright transition-colors"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
        <video
          ref={videoRef}
          src={src}
          controls
          autoPlay
          playsInline
          className="w-full cartoon-panel bg-ink"
          onError={() => onClose()}
        />
      </div>
    </div>
  )
}

interface RejectedCartoon {
  caption: string
  imageUrl: string
  reason: string
  rejectedAt: number
}

export function Feed({ posts, streamMode = false }: { posts: LocalPost[]; streamMode?: boolean }) {
  const [rejected, setRejected] = useState<RejectedCartoon[]>([])
  const [showRejected, setShowRejected] = useState(false)
  const [viewMode, setViewMode] = useState<ViewMode>('feed')
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null)
  const [videoSrc, setVideoSrc] = useState<string | null>(null)

  const handleImageClick = useCallback((post: LocalPost, fallback?: () => void) => {
    if (streamMode) return
    const safeSrc = post.videoPath ? sanitizeVideoPath(post.videoPath) : null
    if (safeSrc) {
      setVideoSrc(safeSrc)
    } else if (fallback) {
      fallback()
    }
  }, [streamMode])

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch('/api/feed/rejected')
        if (res.ok) setRejected(await res.json())
      } catch {}
    }
    load()
    const interval = setInterval(load, 30_000)
    return () => clearInterval(interval)
  }, [])

  if (posts.length === 0 && rejected.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full bg-paper gap-6 px-8">
        <svg width="72" height="72" viewBox="0 0 72 72" fill="none" className="text-ink-faint animate-[float_3s_ease-in-out_infinite]">
          <rect x="12" y="8" width="48" height="56" rx="2" stroke="currentColor" strokeWidth="1.5" />
          <path d="M12 48L28 32L40 44L48 36L60 48" stroke="currentColor" strokeWidth="1" opacity="0.3" />
          <circle cx="48" cy="22" r="4" stroke="currentColor" strokeWidth="1" opacity="0.25" />
        </svg>
        <div className="text-center max-w-xs">
          <p className="font-cartoon text-xl text-ink-light">No cartoons yet</p>
          <p className="font-hand text-[15px] text-ink-muted mt-2 leading-relaxed">
            Sovra is scanning for something worth drawing.
            <br />
            <span className="text-ink-faint">New cartoons appear here as they're published.</span>
          </p>
        </div>
      </div>
    )
  }

  // Auto-scroll in stream mode for livestream viewers
  const scrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!streamMode || !scrollRef.current) return
    const el = scrollRef.current
    let direction = 1
    const tick = setInterval(() => {
      const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 2
      const atTop = el.scrollTop <= 0
      if (atBottom) direction = -1
      if (atTop) direction = 1
      el.scrollTop += direction * 1
    }, 50)
    return () => clearInterval(tick)
  }, [streamMode, posts.length])

  return (
    <div ref={scrollRef} className="h-full overflow-y-auto bg-paper">
      <div className="sticky top-0 z-10 glass-panel border-b-[2px] border-ink px-6 sm:px-10 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-[3px] h-5 bg-ochre rounded-full" />
            <h2 className="font-cartoon text-2xl font-bold text-ink">Gallery</h2>
            <span className="font-mono text-[12px] font-medium text-ink-muted tabular-nums">
              {posts.length} published
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setViewMode('feed')}
              className={`cartoon-btn font-mono text-[10px] uppercase tracking-wider px-2.5 py-1 ${viewMode === 'feed' ? 'bg-ink text-paper-bright' : 'bg-paper-warm text-ink-muted'}`}
            >
              Feed
            </button>
            <button
              onClick={() => setViewMode('gallery')}
              className={`cartoon-btn font-mono text-[10px] uppercase tracking-wider px-2.5 py-1 ${viewMode === 'gallery' ? 'bg-ink text-paper-bright' : 'bg-paper-warm text-ink-muted'}`}
            >
              Grid
            </button>
            {rejected.length > 0 && (
              <button
                onClick={() => setShowRejected(!showRejected)}
                className={`cartoon-btn font-cartoon text-[14px] px-3 py-0.5 ml-1 ${
                  showRejected ? 'bg-vermillion text-paper-bright' : 'bg-paper-warm text-ink-muted'
                }`}
              >
                {showRejected ? 'Hide Rejected' : `${rejected.length} Rejected`}
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="px-6 sm:px-10 py-8">
        {viewMode === 'gallery' ? (
          <>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
              {posts.map((post, i) => (
                post.imagePath && (
                  <div
                    key={post.id}
                    className="cartoon-panel overflow-hidden cursor-pointer group animate-[fade-in_0.3s_ease-out]"
                    style={{ animationDelay: `${i * 0.03}s`, animationFillMode: 'backwards' }}
                    onClick={() => handleImageClick(post, () => setLightboxIndex(i))}
                  >
                    <div className="relative aspect-square overflow-hidden">
                      <img
                        src={sanitizeImagePath(post.imagePath)}
                        alt="cartoon"
                        className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                        loading="lazy"
                      />
                      {post.videoPath && (
                        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                          <div className="w-10 h-10 rounded-full bg-ink/60 flex items-center justify-center group-hover:bg-vermillion/80 transition-colors">
                            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="white"><polygon points="6 3 20 12 6 21 6 3"/></svg>
                          </div>
                        </div>
                      )}
                    </div>
                    <div className="p-3">
                      <p className="font-cartoon text-[14px] sm:text-[16px] text-ink font-bold leading-snug line-clamp-2">
                        {post.text.split('\n')[0]}
                      </p>
                      <time className="block mt-1 font-mono text-[10px] text-ink-faint uppercase">
                        {timeAgo(post.createdAt)}
                      </time>
                    </div>
                  </div>
                )
              ))}
            </div>

            {lightboxIndex !== null && posts[lightboxIndex] && (
              <div
                className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-ink/80 backdrop-blur-sm animate-[fade-in_0.15s_ease-out]"
                onClick={() => setLightboxIndex(null)}
              >
                <div
                  className="relative max-w-4xl w-full max-h-[90vh] cartoon-panel bg-paper-bright overflow-y-auto"
                  onClick={e => e.stopPropagation()}
                >
                  <button
                    onClick={() => setLightboxIndex(null)}
                    className="absolute top-4 right-4 z-10 w-8 h-8 flex items-center justify-center bg-paper-bright/90 cartoon-btn text-ink hover:text-vermillion"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                  </button>
                  {posts[lightboxIndex].videoPath && sanitizeVideoPath(posts[lightboxIndex].videoPath!) ? (
                    <video
                      src={sanitizeVideoPath(posts[lightboxIndex].videoPath!)!}
                      controls
                      autoPlay
                      playsInline
                      className="w-full bg-ink"
                    />
                  ) : posts[lightboxIndex].imagePath ? (
                    <img
                      src={sanitizeImagePath(posts[lightboxIndex].imagePath!)}
                      alt="cartoon"
                      className="w-full object-contain"
                    />
                  ) : null}
                  <div className="p-6 sm:p-8">
                    <p className="font-cartoon text-[22px] sm:text-[28px] text-ink font-bold leading-snug">
                      {posts[lightboxIndex].text.split('\n')[0]}
                    </p>
                    {posts[lightboxIndex].text.split('\n').slice(1).filter(Boolean).length > 0 && (
                      <p className="mt-2 font-hand text-[16px] text-ink-muted">
                        {posts[lightboxIndex].text.split('\n').slice(1).join('\n')}
                      </p>
                    )}
                    <div className="mt-4 flex items-center gap-3">
                      <time className="font-mono text-[11px] font-medium text-ink-muted tabular-nums uppercase tracking-wide">
                        {timeAgo(posts[lightboxIndex].createdAt)}
                      </time>
                      <span className="text-ink-faint">&middot;</span>
                      <span className="font-mono text-[11px] font-medium text-ink-muted uppercase tracking-wide">by Sovra</span>
                    </div>
                    {posts[lightboxIndex].quotedTweetId && (
                      <div className="mt-5">
                        <TweetEmbed tweetId={posts[lightboxIndex].quotedTweetId!} />
                      </div>
                    )}
                  </div>
                  <div className="flex justify-between px-6 pb-4">
                    <button
                      onClick={() => setLightboxIndex(Math.max(0, lightboxIndex - 1))}
                      disabled={lightboxIndex === 0}
                      className="cartoon-btn font-mono text-[11px] uppercase px-3 py-1.5 bg-paper-warm text-ink disabled:opacity-30"
                    >
                      ← Prev
                    </button>
                    <button
                      onClick={() => setLightboxIndex(Math.min(posts.length - 1, lightboxIndex + 1))}
                      disabled={lightboxIndex === posts.length - 1}
                      className="cartoon-btn font-mono text-[11px] uppercase px-3 py-1.5 bg-paper-warm text-ink disabled:opacity-30"
                    >
                      Next →
                    </button>
                  </div>
                </div>
              </div>
            )}
          </>
        ) : (
        <div className="max-w-3xl mx-auto space-y-14">
          {posts.map((post, i) => (
            <article
              key={post.id}
              className="group animate-[fade-in_0.4s_ease-out]"
              style={{ animationDelay: `${i * 0.06}s`, animationFillMode: 'backwards' }}
            >
              {post.imagePath && (
                <div
                  className={`relative cartoon-panel overflow-hidden ${post.videoPath ? 'cursor-pointer group' : ''}`}
                  onClick={() => { if (streamMode) return; const s = post.videoPath ? sanitizeVideoPath(post.videoPath) : null; if (s) setVideoSrc(s) }}
                >
                  <img
                    src={sanitizeImagePath(post.imagePath)}
                    alt="cartoon"
                    className="w-full object-contain"
                    loading="lazy"
                  />
                  {post.videoPath && (
                    <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                      <div className="w-14 h-14 rounded-full bg-ink/50 flex items-center justify-center group-hover:bg-vermillion/80 transition-colors">
                        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="white"><polygon points="6 3 20 12 6 21 6 3"/></svg>
                      </div>
                    </div>
                  )}
                </div>
              )}

              <div className="mt-5">
                <p className="font-cartoon text-[22px] sm:text-[26px] text-ink font-bold leading-snug">
                  {post.text.split('\n')[0]}
                </p>
                {post.text.split('\n').slice(1).filter(Boolean).length > 0 && (
                  <p className="mt-2 font-hand text-[16px] text-ink-muted leading-relaxed whitespace-pre-line">
                    {post.text.split('\n').slice(1).join('\n')}
                  </p>
                )}
                <div className="mt-3 flex items-center gap-3">
                  <time className="font-mono text-[11px] font-medium text-ink-muted tabular-nums uppercase tracking-wide">
                    {timeAgo(post.createdAt)}
                  </time>
                  <span className="text-ink-faint">&middot;</span>
                  <span className="font-mono text-[11px] font-medium text-ink-muted uppercase tracking-wide">
                    by Sovra
                  </span>
                </div>
              </div>

              {post.quotedTweetId && (
                <div className="mt-5">
                  <TweetEmbed tweetId={post.quotedTweetId} />
                </div>
              )}

              {i < posts.length - 1 && !showRejected && (
                <div className="mt-10 flex items-center gap-4">
                  <div className="flex-1 editorial-rule" />
                  <span className="font-cartoon text-ink-faint text-sm">&loz;</span>
                  <div className="flex-1 editorial-rule" />
                </div>
              )}
            </article>
          ))}

          {/* Rejected cartoons */}
          {showRejected && rejected.length > 0 && (
            <>
              <div className="flex items-center gap-4 pt-4">
                <div className="flex-1 sketch-rule" />
                <span className="font-cartoon text-[18px] text-vermillion font-bold">Rejected by Editor</span>
                <div className="flex-1 sketch-rule" />
              </div>

              {rejected.map((r, i) => (
                <article
                  key={`rejected-${i}`}
                  className="opacity-60 hover:opacity-90 transition-opacity"
                >
                  <div className="relative cartoon-panel overflow-hidden">
                    <img
                      src={sanitizeImageUrl(r.imageUrl) ?? '/images/placeholder.png'}
                      alt="rejected cartoon"
                      className="w-full object-contain grayscale-[30%]"
                      loading="lazy"
                    />
                    <div className="absolute top-3 right-3 bg-vermillion text-paper-bright font-cartoon text-[14px] font-bold px-3 py-1" style={{ borderRadius: '255px 15px 225px 15px/15px 225px 15px 255px', transform: 'rotate(3deg)' }}>
                      REJECTED
                    </div>
                  </div>

                  <div className="mt-4">
                    <p className="font-hand text-[16px] text-ink-muted line-through leading-relaxed">
                      {r.caption}
                    </p>
                    <div className="mt-2 sketch-border-thin bg-vermillion/5 px-3 py-2">
                      <p className="font-hand text-[14px] text-vermillion leading-snug">
                        <span className="font-cartoon font-bold">Editor: </span>{r.reason}
                      </p>
                    </div>
                    <time className="block mt-2 font-mono text-[11px] font-medium text-ink-faint tabular-nums uppercase tracking-wide">
                      {timeAgo(r.rejectedAt)}
                    </time>
                  </div>

                  {i < rejected.length - 1 && (
                    <div className="mt-8 flex items-center gap-4">
                      <div className="flex-1 editorial-rule" />
                      <span className="font-cartoon text-vermillion/30 text-sm">&#x2717;</span>
                      <div className="flex-1 editorial-rule" />
                    </div>
                  )}
                </article>
              ))}
            </>
          )}
        </div>
        )}
      </div>

      {videoSrc && <VideoOverlay src={videoSrc} onClose={() => setVideoSrc(null)} />}
    </div>
  )
}

function timeAgo(ts: number): string {
  const seconds = Math.floor((Date.now() - ts) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}
