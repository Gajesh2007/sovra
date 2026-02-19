import { generateText, generateObject } from 'ai'
import { anthropic } from '@ai-sdk/anthropic'
import { gateway } from '@ai-sdk/gateway'
import { readFile, writeFile, mkdir } from 'fs/promises'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { z } from 'zod'
import sharp from 'sharp'
import { uploadToR2 } from '../cdn/r2.js'
import type { CartoonConcept } from '../types.js'
import { Cache } from '../cache/cache.js'
import { EventBus } from '../console/events.js'
import { config } from '../config/index.js'
import { STYLE_TEMPLATE } from '../prompts/style.js'
import type { TwitterReadProvider } from '../twitter/provider.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SIGNATURE_PATH = join(__dirname, '..', 'assets', 'sovra_signature_no_bg.png')

const subjectExtractionSchema = z.object({
  subjects: z.array(z.object({
    name: z.string().describe('Full name or product name'),
    type: z.enum(['person', 'product', 'company', 'other']),
    twitterHandle: z.string().optional().describe('Twitter handle if known, without @'),
  })),
})

export class Generator {
  private imageDir: string
  private signatureBuffer: Buffer | null = null
  private refImageCache = new Map<string, string>()

  constructor(
    private events: EventBus,
    private imageCache: Cache,
    private twitterApiIo?: TwitterReadProvider,
  ) {
    this.imageDir = join(config.dataDir, 'images')
  }

  async init(): Promise<void> {
    await mkdir(this.imageDir, { recursive: true })
    try {
      this.signatureBuffer = await readFile(SIGNATURE_PATH)
    } catch {
      this.events.monologue('Signature file not found — cartoons will be unsigned.')
    }
  }

  async generate(
    concept: CartoonConcept,
    variantCount: number = config.imageVariants,
  ): Promise<{ variants: string[]; prompt: string }> {
    this.events.transition('generating')

    const prompt = this.buildPrompt(concept)
    const cacheKey = Cache.key(`img:${prompt}`)
    const cached = this.imageCache.get(cacheKey) as { variants: string[] } | null
    if (cached) {
      this.events.monologue('Using cached image variants for this prompt.')
      return { variants: cached.variants, prompt }
    }

    this.events.monologue(
      `Generating ${variantCount} image variants. Prompt: "${prompt.slice(0, 120)}..."`,
    )
    this.events.emit({
      type: 'generate',
      prompt: prompt.slice(0, 200),
      variantCount,
      ts: Date.now(),
    })

    const variants: string[] = []

    for (let i = 0; i < variantCount; i++) {
      try {
        const refImages = i === 0 ? await this.findReferenceImages(concept) : (concept.referenceImageUrls ?? [])
        const messages = await this.buildMessages(prompt, refImages)
        const { files } = await generateText({
          model: gateway(config.imageModel),
          messages,
        })

        if (files && files.length > 0) {
          const file = files[0]
          const filename = `${concept.id}-v${i + 1}.png`
          const filepath = join(this.imageDir, filename)
          const raw = Buffer.from(file.base64, 'base64')
          const signed = await this.applySignature(raw)
          await writeFile(filepath, signed)
          uploadToR2(filepath, 'images').catch(() => {})
          variants.push(filepath)
          this.events.monologue(`Variant ${i + 1}/${variantCount} generated.`)
        } else {
          this.events.monologue(`Variant ${i + 1}: no image returned. Skipping.`)
        }
      } catch (err) {
        this.events.monologue(
          `Variant ${i + 1} failed: ${(err as Error).message}. Moving on.`,
        )
      }
    }

    if (variants.length > 0) {
      this.imageCache.set(cacheKey, { variants }, config.cache.imagePromptTtlMs)
    }

    return { variants, prompt }
  }

  async retry(
    concept: CartoonConcept,
    feedback: string,
    attempt: number,
  ): Promise<{ variants: string[]; prompt: string }> {
    this.events.monologue(
      `Retry ${attempt}/${config.maxImageRetries}. Adjusting prompt based on: ${feedback}`,
    )
    const modified = {
      ...concept,
      composition: `${concept.composition}\n\nIMPORTANT ADJUSTMENT: ${feedback}`,
    }
    return this.generate(modified, 1)
  }

  private async findReferenceImages(concept: CartoonConcept): Promise<string[]> {
    const urls: string[] = [...(concept.referenceImageUrls ?? [])]

    try {
      const { object } = await generateObject({
        model: anthropic('claude-haiku-4-5-20251001'),
        schema: subjectExtractionSchema,
        prompt: `Extract named people, products, or companies from this cartoon concept that would benefit from a visual reference photo:\n\nVisual: ${concept.visual}\n\nOnly include specific, real, recognizable subjects (e.g. "Sam Altman", "iPhone", "Tesla Cybertruck"). Skip generic descriptions like "a businessman" or "a robot". For people, provide their Wikipedia article title (e.g. "Sam_Altman", "Tim_Cook").`,
      })

      for (const subject of object.subjects) {
        if (this.refImageCache.has(subject.name)) {
          urls.push(this.refImageCache.get(subject.name)!)
          continue
        }

        // Layer 1: Wikipedia — best source for high-quality photos of public figures
        const wikiImage = await this.fetchWikipediaImage(subject.name)
        if (wikiImage) {
          this.refImageCache.set(subject.name, wikiImage)
          urls.push(wikiImage)
          this.events.monologue(`Found reference photo for ${subject.name} via Wikipedia`)
          continue
        }

        // Layer 2: Twitter profile picture — fallback
        if (this.twitterApiIo && subject.twitterHandle) {
          try {
            const user = await this.twitterApiIo.getUserInfo(subject.twitterHandle)
            if (user?.profilePicture) {
              const fullSize = user.profilePicture.replace('_normal', '')
              this.refImageCache.set(subject.name, fullSize)
              urls.push(fullSize)
              this.events.monologue(`Found reference photo for ${subject.name} via @${subject.twitterHandle}`)
            }
          } catch { /* no reference available */ }
        }
      }
    } catch {
      // Subject extraction failed — continue with whatever we have
    }

    return [...new Set(urls)].slice(0, 5)
  }

  private async fetchWikipediaImage(name: string): Promise<string | null> {
    const slug = name.replace(/\s+/g, '_')
    try {
      const res = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(slug)}`)
      if (!res.ok) return null
      const data = await res.json() as {
        originalimage?: { source: string }
        thumbnail?: { source: string }
      }
      return data.originalimage?.source ?? data.thumbnail?.source ?? null
    } catch {
      return null
    }
  }

  private async buildMessages(prompt: string, referenceUrls: string[]): Promise<Array<{ role: 'user'; content: Array<{ type: 'text'; text: string } | { type: 'image'; image: URL }> }>> {
    const content: Array<{ type: 'text'; text: string } | { type: 'image'; image: URL }> = []

    if (referenceUrls.length > 0) {
      content.push({
        type: 'text',
        text: 'REFERENCE IMAGES — these show the real people, products, or scene from the news story. Use them so your caricatures are RECOGNIZABLE. Exaggerate features for cartoon effect but keep the likeness. Do NOT copy the photo — draw an editorial cartoon inspired by it.',
      })

      for (const url of referenceUrls) {
        try {
          content.push({ type: 'image', image: new URL(url) })
        } catch {
          // Invalid URL, skip
        }
      }
    }

    content.push({ type: 'text', text: prompt })

    return [{ role: 'user' as const, content }]
  }

  private async applySignature(imageBuffer: Buffer): Promise<Buffer> {
    if (!this.signatureBuffer) return imageBuffer

    try {
      const image = sharp(imageBuffer)
      const { width, height } = await image.metadata()
      if (!width || !height) return imageBuffer

      // Scale signature to ~12% of image width, placed in the top-right corner
      const sigWidth = Math.round(width * 0.12)
      const margin = Math.round(width * 0.02)

      const resizedSig = await sharp(this.signatureBuffer)
        .resize({ width: sigWidth, withoutEnlargement: true })
        .toBuffer()

      return image
        .composite([{
          input: resizedSig,
          gravity: 'northeast',
          top: margin,
          left: width - sigWidth - margin,
        }])
        .toBuffer()
    } catch {
      return imageBuffer
    }
  }

  private buildPrompt(concept: CartoonConcept): string {
    // Determine color mood from joke type
    const mood = this.inferMood(concept)

    return [
      STYLE_TEMPLATE,
      '',
      '---',
      '',
      `COLOR MOOD: ${mood}`,
      '',
      `JOKE MECHANIC: ${concept.jokeType}`,
      `The humor works through ${concept.jokeType.toLowerCase()}. The image must set up or amplify this comedic mechanism visually.`,
      '',
      `SCENE DESCRIPTION:`,
      concept.visual,
      '',
      `COMPOSITION & CAMERA:`,
      concept.composition,
      '',
      `WHY THIS IS FUNNY (context for rendering decisions):`,
      concept.reasoning,
      '',
      `VISUAL PRIORITIES (in order):`,
      `1. The primary visual gag must read instantly — a viewer should understand the joke within 2 seconds of looking at the image`,
      `2. Character expressions and body language carry the emotion — exaggerate posture, gestures, and reactions`,
      `3. One key supporting detail that rewards a second look`,
      `4. Clean negative space — resist the urge to fill every corner`,
      '',
      `CRITICAL REMINDERS:`,
      `- ZERO text in the image. No words, letters, signs, labels, or speech bubbles whatsoever.`,
      `- Single panel, clean white background, thick border`,
      `- Maximum 3 characters in frame`,
      `- Every prop must serve the joke — if it doesn't make the gag funnier, remove it`,
    ].join('\n')
  }

  private inferMood(concept: CartoonConcept): string {
    const text = `${concept.visual} ${concept.jokeType} ${concept.reasoning}`.toLowerCase()
    if (/tech|ai|robot|algorithm|data|digital|screen|phone|computer/.test(text)) {
      return 'COOL — use slate blue, teal, muted purple, off-white. Tech/digital atmosphere.'
    }
    if (/chaos|urgent|breaking|disaster|fire|crash|panic|war/.test(text)) {
      return 'HOT — use vermillion, amber, charcoal, white. High energy, alarming.'
    }
    if (/money|business|corporate|ceo|profit|market|stock/.test(text)) {
      return 'CORPORATE — use forest green, navy, gold, cream. Power and money vibes.'
    }
    return 'WARM — use ochre, warm gray, dusty rose, cream. Ironic, wry, human.'
  }
}
