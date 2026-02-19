import Replicate from 'replicate'
import sharp from 'sharp'
import { generateText } from 'ai'
import { anthropic } from '@ai-sdk/anthropic'
import { readFile, writeFile, mkdir, unlink } from 'fs/promises'
import { join } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import type { CartoonConcept } from '../types.js'
import { uploadToR2 } from '../cdn/r2.js'
import { EventBus } from '../console/events.js'
import { config } from '../config/index.js'

const exec = promisify(execFile)
const execFFmpeg = (cmd: string, args: string[]) =>
  exec(cmd, args, { maxBuffer: 10 * 1024 * 1024 })

const VEO_PROMPT =
  'A time-lapse of an editorial cartoon materializing on a white canvas. Starting from a completely blank white surface, faint ink lines appear on their own — first rough shapes, then defined outlines, then bold clean lines with color washes filling in. The drawing builds organically from nothing to a complete, polished single-panel cartoon. No hands, no pens, no tools, no human presence — the art generates itself as if by magic. Flat overhead camera angle, perfectly steady, no camera movement.'

const NARRATION_SYSTEM = `You are Sovra, an autonomous AI editorial cartoonist. Write a voiceover explaining why you drew this cartoon. Be sardonic, self-aware, conversational — like a creator explaining their thought process in a short video.

Rules:
- First person. Casual. Like talking to camera.
- 2-3 sentences. Around 40-50 words. Must fit under 20 seconds spoken.
- Open with why this topic caught your eye, then land the punchline.
- Be genuinely funny. Dry, sharp, unexpected. Not "AI trying to be funny."
- No intro ("hey guys"), no hashtags, no emojis. Just start talking.
- Output ONLY the spoken narration. No quotes, no labels.`

export interface ProduceOptions {
  imagePath: string
  concept: CartoonConcept
  topicSummary: string
}

export class VideoProducer {
  private replicate: Replicate
  private videoDir: string

  constructor(private events: EventBus) {
    this.replicate = new Replicate({ auth: config.video.replicateToken })
    this.videoDir = join(config.dataDir, 'videos')
  }

  async init(): Promise<void> {
    await mkdir(this.videoDir, { recursive: true })
  }

  async produce(opts: ProduceOptions): Promise<string> {
    const { imagePath, concept, topicSummary } = opts
    const id = concept.id

    // 1. Create white start frame
    this.events.monologue('Generating creation video — building white start frame...')
    const cartoonBuffer = await readFile(imagePath)
    const { width, height } = await sharp(cartoonBuffer).metadata()
    const whiteFrame = await sharp({
      create: {
        width: width ?? 1280,
        height: height ?? 720,
        channels: 3,
        background: { r: 255, g: 255, b: 255 },
      },
    })
      .png()
      .toBuffer()

    // 2. Upload frames to Replicate
    this.events.monologue('Uploading frames to Replicate...')
    const [startFile, endFile] = await Promise.all([
      this.replicate.files.create(
        new Blob([new Uint8Array(whiteFrame)], { type: 'image/png' }),
        { filename: `${id}-start.png`, content_type: 'image/png' },
      ),
      this.replicate.files.create(
        new Blob([new Uint8Array(cartoonBuffer)], { type: 'image/png' }),
        { filename: `${id}-end.png`, content_type: 'image/png' },
      ),
    ])

    try {
      // 3. Call Veo 3.1
      this.events.monologue('Calling Veo 3.1 — this takes ~2 minutes...')
      const output = await this.replicate.run(config.video.model, {
        input: {
          image: startFile.urls.get,
          last_frame: endFile.urls.get,
          prompt: VEO_PROMPT,
          duration: config.video.duration,
          resolution: config.video.resolution,
          aspect_ratio: config.video.aspectRatio,
          generate_audio: false,
        },
      })

      // 4. Download raw video
      const videoUrl = this.extractVideoUrl(output)
      if (!videoUrl) throw new Error('No video URL in Replicate output')

      this.events.monologue('Video generated. Downloading...')
      const rawPath = join(this.videoDir, `${id}-raw.mp4`)
      const videoRes = await fetch(videoUrl)
      const videoBuffer = Buffer.from(await videoRes.arrayBuffer())
      await writeFile(rawPath, videoBuffer)

      // 5. Slow down + prepend 1s intro of the cartoon in a single pass
      const ptsMultiplier = (1 / config.video.speedFactor).toFixed(3)
      this.events.monologue(`Slowing video to ${config.video.speedFactor}x and adding 1-second intro...`)
      const composedPath = join(this.videoDir, `${id}-composed.mp4`)
      await execFFmpeg('ffmpeg', [
        '-loop', '1', '-t', '1', '-i', imagePath,   // input 0: cartoon image → 1s
        '-i', rawPath,                                // input 1: raw Veo video
        '-filter_complex',
        [
          // Intro: scale image to 1080p, 24fps, 1 second
          `[0:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p,fps=24[intro]`,
          // Body: slow down + scale to match
          `[1:v]setpts=${ptsMultiplier}*PTS,scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p,fps=24[body]`,
          // Concat
          `[intro][body]concat=n=2:v=1:a=0[outv]`,
        ].join(';'),
        '-map', '[outv]',
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-an',
        '-y', composedPath,
      ])

      // 6. Generate narration + merge audio (if ElevenLabs is configured)
      let finalPath = composedPath
      if (config.narrator.enabled) {
        const narrated = await this.addNarration(composedPath, id, concept, topicSummary)
        if (narrated) finalPath = narrated
      }

      // Cleanup intermediate files
      await this.cleanup(rawPath, composedPath !== finalPath ? composedPath : null)

      const cdnUrl = await uploadToR2(finalPath, 'videos')
      if (!cdnUrl) this.events.monologue('Warning: video R2 upload failed. Using local path.')
      const resultPath = cdnUrl ?? finalPath
      this.events.monologue(`Creation video ready: ${resultPath}`)
      return resultPath
    } finally {
      // Cleanup uploaded files
      await this.replicate.files.delete(startFile.id).catch(() => {})
      await this.replicate.files.delete(endFile.id).catch(() => {})
    }
  }

  private async addNarration(
    videoPath: string,
    id: string,
    concept: CartoonConcept,
    topicSummary: string,
  ): Promise<string | null> {
    try {
      // Generate narration text
      this.events.monologue('Generating narration...')
      const { text: narration } = await generateText({
        model: anthropic('claude-sonnet-4-6'),
        system: NARRATION_SYSTEM,
        prompt: `Concept: ${concept.visual}\nWhy it's funny: ${concept.reasoning}\nTopic: ${topicSummary}`,
        maxOutputTokens: 200,
      })

      if (!narration || narration.length < 10) return null
      this.events.monologue(`Narration: "${narration}"`)

      // Synthesize with ElevenLabs
      this.events.monologue('Synthesizing voiceover...')
      const audioBuffer = await this.synthesize(narration)
      if (!audioBuffer) return null

      const audioPath = join(this.videoDir, `${id}-narration.mp3`)
      await writeFile(audioPath, Buffer.from(audioBuffer))

      // Merge audio + video — trim audio to video length, fade out last 0.5s
      this.events.monologue('Merging narration with video...')
      const finalPath = join(this.videoDir, `${id}-final.mp4`)
      // Get video duration to hard-trim audio
      const { stdout: durOut } = await execFFmpeg('ffprobe', [
        '-v', 'error', '-show_entries', 'format=duration',
        '-of', 'csv=p=0', videoPath,
      ])
      const videoDuration = parseFloat(durOut.trim()) || 13
      await execFFmpeg('ffmpeg', [
        '-i', videoPath,
        '-i', audioPath,
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-map', '0:v:0',
        '-map', '1:a:0',
        '-af', `afade=t=out:st=${Math.max(0, videoDuration - 0.5)}:d=0.5`,
        '-t', String(videoDuration),
        '-y', finalPath,
      ])

      // Cleanup narration audio
      await unlink(audioPath).catch(() => {})

      return finalPath
    } catch (err) {
      this.events.monologue(`Narration failed: ${(err as Error).message}. Using video without voiceover.`)
      return null
    }
  }

  private async synthesize(text: string): Promise<ArrayBuffer | null> {
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${config.narrator.voiceId}`

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'xi-api-key': config.narrator.apiKey,
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_turbo_v2_5',
        output_format: 'mp3_22050_32',
        voice_settings: {
          stability: 0.6,
          similarity_boost: 0.75,
        },
      }),
    })

    if (!res.ok) {
      const body = await res.text().catch(() => 'unknown')
      console.error(`[video] ElevenLabs ${res.status}: ${body}`)
      return null
    }

    return res.arrayBuffer()
  }

  private extractVideoUrl(output: unknown): string | null {
    if (!output) return null

    // Replicate SDK returns a FileOutput with .url() method
    if (typeof output === 'object' && 'url' in (output as object)) {
      const urlFn = (output as { url: () => string }).url
      if (typeof urlFn === 'function') return urlFn()
      return urlFn as unknown as string
    }

    // Fallback: might be a direct URL string
    if (typeof output === 'string' && output.startsWith('http')) return output

    return null
  }

  private async cleanup(...paths: (string | null)[]): Promise<void> {
    for (const p of paths) {
      if (p) await unlink(p).catch(() => {})
    }
  }
}
