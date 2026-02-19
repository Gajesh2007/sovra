import { useEffect, useRef, useCallback, useState } from 'react'

interface VoiceEvent {
  type: 'voice'
  url: string
  text: string
  ts: number
}

// Smallest valid WAV: 44-byte header, zero samples — enough to "activate" the element on iOS
const SILENT_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA='

export function useVoiceStream({ muted }: { muted: boolean }) {
  const [speaking, setSpeaking] = useState(false)
  const [currentText, setCurrentText] = useState<string | null>(null)
  const [blocked, setBlocked] = useState(false)
  const queueRef = useRef<VoiceEvent[]>([])
  const playingRef = useRef(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const mutedRef = useRef(muted)
  const unlockedRef = useRef(false)

  useEffect(() => {
    audioRef.current = new Audio()
    audioRef.current.setAttribute('playsinline', 'true')
  }, [])

  useEffect(() => {
    const unlock = () => {
      if (unlockedRef.current || !audioRef.current) return
      const a = audioRef.current
      a.src = SILENT_WAV
      a.load()
      a.play().then(() => {
        a.pause()
        unlockedRef.current = true
        setBlocked(false)
      }).catch(() => {})
    }
    const events = ['click', 'keydown', 'touchstart'] as const
    events.forEach(e => document.addEventListener(e, unlock, { once: false }))
    return () => { events.forEach(e => document.removeEventListener(e, unlock)) }
  }, [])

  useEffect(() => {
    mutedRef.current = muted
    if (muted && audioRef.current) {
      audioRef.current.pause()
      playingRef.current = false
      setSpeaking(false)
      setCurrentText(null)
      queueRef.current = []
    }
  }, [muted])

  const playOne = useCallback((url: string): Promise<void> => {
    return new Promise((resolve, reject) => {
      const audio = audioRef.current
      if (!audio) return reject(new Error('No audio element'))

      const cleanup = () => {
        audio.onended = null
        audio.onerror = null
        audio.oncanplaythrough = null
      }

      audio.onended = () => { cleanup(); resolve() }
      audio.onerror = () => { cleanup(); reject(new Error('Audio load error')) }

      audio.src = url
      audio.load()

      audio.oncanplaythrough = () => {
        audio.oncanplaythrough = null
        audio.play().catch((err) => {
          cleanup()
          if (err.name === 'NotAllowedError') setBlocked(true)
          reject(err)
        })
      }
    })
  }, [])

  const drain = useCallback(async () => {
    if (playingRef.current) return
    playingRef.current = true

    while (queueRef.current.length > 0) {
      if (mutedRef.current) {
        queueRef.current = []
        break
      }

      const event = queueRef.current.shift()!
      setSpeaking(true)
      setCurrentText(event.text)

      try {
        await playOne(event.url)
      } catch {
        // Playback failed — continue to next in queue
      }
    }

    playingRef.current = false
    setSpeaking(false)
    setCurrentText(null)
  }, [playOne])

  const enqueue = useCallback((event: VoiceEvent) => {
    if (mutedRef.current) return
    if (queueRef.current.length >= 3) queueRef.current.shift()
    queueRef.current.push(event)
    drain()
  }, [drain])

  return { speaking, currentText, enqueue, blocked }
}
