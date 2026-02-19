interface VoiceIndicatorProps {
  speaking: boolean
  text: string | null
}

export function VoiceIndicator({ speaking, text }: VoiceIndicatorProps) {
  if (!speaking || !text) return null

  return (
    <div className="flex items-start gap-3 px-4 py-2.5 sketch-border-light bg-violet/5">
      <div className="flex items-end gap-[2px] h-4 shrink-0 mt-0.5">
        <div className="w-[3px] bg-violet rounded-full animate-[voice-bar-1_0.8s_ease-in-out_infinite]" />
        <div className="w-[3px] bg-violet rounded-full animate-[voice-bar-2_0.8s_ease-in-out_infinite_0.2s]" />
        <div className="w-[3px] bg-violet rounded-full animate-[voice-bar-3_0.8s_ease-in-out_infinite_0.4s]" />
      </div>
      <p className="font-hand text-[15px] text-violet leading-snug">
        {text}
      </p>
    </div>
  )
}
