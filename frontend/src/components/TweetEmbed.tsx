import { useEffect, useRef } from 'react'

const TWEET_ID_RE = /^\d{1,20}$/

export function TweetEmbed({ tweetId }: { tweetId: string }) {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    if (!TWEET_ID_RE.test(tweetId)) return

    while (container.firstChild) container.removeChild(container.firstChild)

    const blockquote = document.createElement('blockquote')
    blockquote.className = 'twitter-tweet'
    blockquote.setAttribute('data-dnt', 'true')
    blockquote.setAttribute('data-theme', 'light')

    const a = document.createElement('a')
    a.href = `https://twitter.com/i/status/${tweetId}`
    blockquote.appendChild(a)
    container.appendChild(blockquote)

    const win = window as unknown as { twttr?: { widgets?: { load?: (el: HTMLElement) => void } } }
    if (win.twttr?.widgets?.load) {
      win.twttr.widgets.load(container)
    } else {
      const script = document.createElement('script')
      script.src = 'https://platform.twitter.com/widgets.js'
      script.async = true
      script.charset = 'utf-8'
      container.appendChild(script)
    }
  }, [tweetId])

  return (
    <div ref={containerRef} className="rounded-lg overflow-hidden [&_.twitter-tweet]:!m-0" />
  )
}
