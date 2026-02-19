import Fastify from 'fastify'
import { generateText } from 'ai'
import { anthropic } from '@ai-sdk/anthropic'
import { join, extname } from 'path'
import { mkdir, writeFile } from 'fs/promises'
import { VersionedTransaction, PublicKey as SolPublicKey } from '@solana/web3.js'
import { TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { config } from './config/index.js'
import { EventBus } from './console/events.js'
import { registerConsoleRoutes } from './console/stream.js'
import { Cache } from './cache/cache.js'
import { JsonStore } from './store/json-store.js'
import { Scanner } from './pipeline/scanner.js'
import { Scorer } from './pipeline/scorer.js'
import { Ideator } from './pipeline/ideator.js'
import { Generator } from './pipeline/generator.js'
import { Captioner } from './pipeline/captioner.js'
import { TwitterClient } from './twitter/client.js'
import { TwitterApiIoClient } from './twitter/twitterapi-io.js'
import { TwitterV2Reader } from './twitter/twitterapi-v2.js'
import type { TwitterReadProvider } from './twitter/provider.js'
import { EngagementLoop } from './twitter/engagement.js'
import { SolanaAuctionClient } from './auction/solana.js'
import { BaseAuctionClient } from './auction/base.js'
import { AuctionOrchestrator } from './auction/slot.js'
import { AuctionReviewer } from './auction/review.js'
import type { ChainAuctionClient } from './auction/types.js'
import { Editor } from './pipeline/editor.js'
import { AgentLoop } from './agent/loop.js'
import { WorldviewStore } from './agent/worldview.js'
import { Narrator } from './narrator/narrator.js'
import { VideoProducer } from './video/producer.js'
import { BackupStore } from './store/backup.js'
import { toCdnUrl, uploadBufferToR2, migratePostsToCdn } from './cdn/r2.js'
import type { Cartoon, Post, Signal } from './types.js'

async function main() {
  // --- Restore from Postgres backup if available ---
  let backup: BackupStore | null = null
  if (config.postgres.enabled && config.solana.mnemonic) {
    backup = new BackupStore(config.postgres.url, config.solana.mnemonic)
    await backup.init()
    const restored = await backup.restoreAll(config.dataDir)
    if (restored > 0) {
      console.log(`Restored ${restored} files from encrypted Postgres backup`)
    }
  }

  // --- Event bus ---
  const events = new EventBus(join(config.dataDir, 'events.jsonl'))
  await events.init()

  // --- Caches ---
  const signalCache = new Cache<Signal[]>('signals', 200, join(config.dataDir, 'cache-signals.json'))
  const evalCache = new Cache('eval', config.cache.maxEntries, join(config.dataDir, 'cache-eval.json'))
  const imageCache = new Cache('images', 100, join(config.dataDir, 'cache-images.json'))
  await Promise.all([signalCache.restore(), evalCache.restore(), imageCache.restore()])

  // --- Stores ---
  const stores = {
    cartoons: new JsonStore<Cartoon[]>(join(config.dataDir, 'cartoons.json')),
    posts: new JsonStore<Post[]>(join(config.dataDir, 'posts.json')),
  }

  // --- Twitter read provider ---
  let readProvider: TwitterReadProvider
  if (config.twitter.readProvider === 'proxy' && config.twitter.twitterApiIoKey) {
    readProvider = new TwitterApiIoClient(config.twitter.twitterApiIoKey)
  } else {
    const { TwitterApi } = await import('twitter-api-v2')
    const oauth = new TwitterApi({
      appKey: config.twitter.apiKey,
      appSecret: config.twitter.apiSecret,
      accessToken: config.twitter.accessToken,
      accessSecret: config.twitter.accessSecret,
    })
    readProvider = new TwitterV2Reader(config.twitter.bearerToken, oauth)
  }

  const twitter = new TwitterClient(events, readProvider)

  // --- Worldview ---
  const worldview = new WorldviewStore(events, join(config.dataDir, 'worldview.json'))
  await worldview.init()

  // --- Pipeline ---
  const scanner = new Scanner(events, readProvider, signalCache, twitter)
  const scorer = new Scorer(events, evalCache)
  const ideator = new Ideator(events, worldview)
  const generator = new Generator(events, imageCache, readProvider)
  await generator.init()
  const captioner = new Captioner(events)

  // --- Engagement ---
  const engagement = new EngagementLoop(events, twitter)
  await engagement.init()

  // --- Chain clients ---
  let solanaClient: SolanaAuctionClient | null = null
  let baseClient: BaseAuctionClient | null = null
  const chainClients: ChainAuctionClient[] = []

  if (config.solana.enabled && config.solana.mnemonic) {
    solanaClient = SolanaAuctionClient.fromMnemonic(
      events,
      config.solana.programId,
      config.solana.rpcUrl,
      config.solana.mnemonic,
    )
    await solanaClient.ensureInitialized(config.auction.minimumBidUsdc)
    chainClients.push(solanaClient)
    console.log('Solana auction client enabled')
  }

  if (config.base.enabled && config.solana.mnemonic) {
    baseClient = BaseAuctionClient.fromMnemonic(
      events,
      config.base.rpcUrl,
      config.base.auctionAddress,
      config.solana.mnemonic,
    )
    chainClients.push(baseClient)
    console.log('Base auction client enabled')
  }

  // --- Auction ---
  const auction = new AuctionOrchestrator(
    events,
    chainClients,
    join(config.dataDir, 'auction-state.json'),
  )
  const auctionReviewer = new AuctionReviewer(events)
  const editor = new Editor(events)

  // --- Video pipeline ---
  let videoProducer: VideoProducer | null = null
  if (config.video.enabled) {
    videoProducer = new VideoProducer(events)
    await videoProducer.init()
    console.log('Video pipeline enabled (Replicate Veo 3.1)')
  }

  // --- Agent loop ---
  const agent = new AgentLoop(
    events, scanner, scorer, ideator, generator, captioner,
    twitter, engagement, auction, auctionReviewer, editor, stores, worldview,
    videoProducer ?? undefined,
  )

  // --- Narrator (voice sidecar) ---
  let narrator: Narrator | null = null
  if (config.narrator.enabled) {
    narrator = new Narrator(events, config.narrator.apiKey, config.narrator.voiceId)
    await narrator.init()
    narrator.start()
    console.log('Narrator enabled (ElevenLabs TTS)')
  }

  // --- HTTP server ---
  const app = Fastify({ logger: false })

  await app.register(import('@fastify/static'), {
    root: join(process.cwd(), 'public'),
    prefix: '/',
  })

  registerConsoleRoutes(app, events)

  app.get('/api/health', async () => ({
    status: 'alive',
    state: events.state,
    uptime: process.uptime(),
    solana: config.solana.enabled,
    base: config.base.enabled,
  }))

  app.get('/api/earnings', async () => {
    let total = 0

    // Solana: treasury + escrow
    if (solanaClient) {
      try {
        const { getAccount } = await import('@solana/spl-token')
        const connection = new (await import('@solana/web3.js')).Connection(config.solana.rpcUrl, 'confirmed')
        const programId = new SolPublicKey(config.solana.programId)

        const [auctionPda] = SolPublicKey.findProgramAddressSync([Buffer.from('auction_state')], programId)
        const stateInfo = await connection.getAccountInfo(auctionPda)
        if (stateInfo) {
          const treasury = new SolPublicKey(stateInfo.data.subarray(8 + 32 + 32, 8 + 32 + 32 + 32))
          const [escrowPda] = SolPublicKey.findProgramAddressSync([Buffer.from('escrow')], programId)

          const [treasuryAccount, escrowAccount] = await Promise.all([
            getAccount(connection, treasury).catch(() => null),
            getAccount(connection, escrowPda).catch(() => null),
          ])

          total += treasuryAccount ? Number(treasuryAccount.amount) / 1_000_000 : 0
          total += escrowAccount ? Number(escrowAccount.amount) / 1_000_000 : 0
        }
      } catch {}
    }

    // Base: USDC balance of contract (pending bids) — settled funds go to agent wallet
    if (baseClient && config.base.auctionAddress) {
      try {
        const { createPublicClient, http, parseAbi } = await import('viem')
        const { base } = await import('viem/chains')
        const client = createPublicClient({ chain: base, transport: http(config.base.rpcUrl) })
        const usdcAbi = parseAbi(['function balanceOf(address) view returns (uint256)'])
        const contractBalance = await client.readContract({
          address: config.base.usdcAddress as `0x${string}`,
          abi: usdcAbi,
          functionName: 'balanceOf',
          args: [config.base.auctionAddress as `0x${string}`],
        })
        total += Number(contractBalance) / 1_000_000
      } catch {}
    }

    return { earningsUsdc: total }
  })

  let feedCache: { data: unknown; ts: number } | null = null
  const FEED_CACHE_TTL = 10_000

  async function resolveMediaUrl(url: string | undefined | null, prefix: 'images' | 'videos'): Promise<string | null> {
    if (!url) return null
    if (url.startsWith('https://')) return url
    const filename = url.split('/').pop() ?? ''
    const localPath = join(config.dataDir, prefix, filename)
    try { await import('fs/promises').then(fs => fs.access(localPath)); return `/${prefix}/${filename}` } catch {}
    if (config.r2.enabled) return `${config.r2.publicUrl}/${prefix}/${filename}`
    return null
  }

  app.get('/api/feed', async () => {
    if (feedCache && Date.now() - feedCache.ts < FEED_CACHE_TTL) return feedCache.data

    const allPosts = (await stores.posts.read()) ?? []
    const sorted = allPosts.filter(p => p.imageUrl).sort((a, b) => b.postedAt - a.postedAt)

    const data = await Promise.all(sorted.map(async p => {
      const imagePath = await resolveMediaUrl(p.imageUrl, 'images')
      const videoPath = await resolveMediaUrl(p.videoUrl, 'videos')
      return imagePath ? {
        id: p.id,
        text: p.text,
        imagePath,
        videoPath,
        quotedTweetId: p.quotedTweetId,
        createdAt: p.postedAt,
      } : null
    }))

    const filtered = data.filter(Boolean)
    feedCache = { data: filtered, ts: Date.now() }
    return filtered
  })

  // Ensure media directories exist before registering static routes
  const imagesDir = join(process.cwd(), config.dataDir, 'images')
  const voiceDir = join(process.cwd(), config.dataDir, 'voice')
  const bidImagesDir = join(process.cwd(), config.dataDir, 'bid-images')
  const videosDir = join(process.cwd(), config.dataDir, 'videos')
  await Promise.all([mkdir(imagesDir, { recursive: true }), mkdir(voiceDir, { recursive: true }), mkdir(bidImagesDir, { recursive: true }), mkdir(videosDir, { recursive: true })])

  // Serve generated images from .data/images/
  await app.register(import('@fastify/static'), {
    root: imagesDir,
    prefix: '/images/',
    decorateReply: false,
  })

  // Serve generated voice audio from .data/voice/
  await app.register(import('@fastify/static'), {
    root: voiceDir,
    prefix: '/voice/',
    decorateReply: false,
  })

  // Serve bid reference images from .data/bid-images/
  await app.register(import('@fastify/static'), {
    root: bidImagesDir,
    prefix: '/bid-images/',
    decorateReply: false,
  })

  // Serve generated videos from .data/videos/
  await app.register(import('@fastify/static'), {
    root: videosDir,
    prefix: '/videos/',
    decorateReply: false,
  })

  // Multipart for image uploads
  await app.register(import('@fastify/multipart'), { limits: { fileSize: 5 * 1024 * 1024 } })

  app.post('/api/auction/upload', async (req, reply) => {
    const file = await req.file()
    if (!file) return reply.status(400).send({ error: 'No file uploaded' })

    const mime = file.mimetype
    if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(mime)) {
      return reply.status(400).send({ error: 'Only JPEG, PNG, WebP, and GIF images are allowed' })
    }

    const buf = await file.toBuffer()
    const ext = extname(file.filename) || '.png'
    const name = `${Date.now()}${ext}`
    await writeFile(join(bidImagesDir, name), buf)

    const cdnUrl = await uploadBufferToR2(buf as Buffer, name, 'bid-images')
    return { url: cdnUrl ?? `/bid-images/${name}` }
  })

  // Store bid request text + image off-chain (not on-chain)
  app.post('/api/auction/request', async (req, reply) => {
    const { bidder, requestText, imageUrl } = req.body as { bidder?: string; requestText?: string; imageUrl?: string }
    if (!bidder || !requestText) return reply.status(400).send({ error: 'Missing bidder or requestText' })
    if (requestText.length > 500) return reply.status(400).send({ error: 'Request text too long (max 500)' })
    await auction.saveBidRequest(bidder, requestText, imageUrl)
    return { ok: true }
  })

  app.get('/api/auction/request/:bidder', async (req) => {
    const { bidder } = req.params as { bidder: string }
    const data = await auction.getBidRequest(bidder)
    return data ?? { requestText: null, imageUrl: null }
  })

  app.get('/api/worldview', async () => worldview.getForFrontend())

  // --- Gas sponsorship ---
  const rateLimitMap = new Map<string, { count: number; resetAt: number }>()

  app.get('/api/sponsor/info', async () => {
    if (!solanaClient) return { error: 'Solana not enabled' }
    return {
      feePayerAddress: solanaClient.feePayerKeypair.publicKey.toBase58(),
      programId: config.solana.programId,
    }
  })

  app.post('/api/sponsor', async (req, reply) => {
    if (!solanaClient) return reply.status(503).send({ error: 'Solana not enabled' })

    const { transaction: serializedTx } = req.body as { transaction?: string }
    if (!serializedTx) return reply.status(400).send({ error: 'Missing transaction' })

    try {
      const txBuffer = Buffer.from(serializedTx, 'base64')
      const tx = VersionedTransaction.deserialize(txBuffer)
      const message = tx.message
      const accountKeys = message.getAccountKeys()

      // Verify fee payer is our fee payer
      const feePayer = accountKeys.get(0)
      if (!feePayer || feePayer.toBase58() !== solanaClient.feePayerKeypair.publicKey.toBase58()) {
        return reply.status(403).send({ error: 'Invalid fee payer' })
      }

      // Whitelist: only allow auction program + SPL Token + System Program (for PDA init)
      const allowedPrograms = new Set([
        config.solana.programId,
        TOKEN_PROGRAM_ID.toBase58(),
        '11111111111111111111111111111111',
        'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
      ])

      for (const ix of message.compiledInstructions) {
        const programId = accountKeys.get(ix.programIdIndex)
        if (!programId || !allowedPrograms.has(programId.toBase58())) {
          return reply.status(403).send({ error: `Unauthorized program: ${programId?.toBase58()}` })
        }

        // Cap System Program transfers from fee payer to max 0.01 SOL (rent sponsorship only)
        if (programId.toBase58() === '11111111111111111111111111111111') {
          if (ix.data[0] === 2) {
            const senderIndex = ix.accountKeyIndexes[0]
            const sender = accountKeys.get(senderIndex)
            if (sender?.toBase58() === solanaClient.feePayerKeypair.publicKey.toBase58()) {
              const lamports = ix.data.length >= 12
                ? Number(Buffer.from(ix.data.slice(4, 12)).readBigUInt64LE())
                : 0
              if (lamports > 10_000_000) {
                return reply.status(403).send({ error: 'Transfer from fee payer exceeds rent cap (0.01 SOL)' })
              }
            }
          }
        }
      }

      // Rate limit: 10 tx/hour per user (second signer = user)
      const userKey = tx.message.getAccountKeys().get(1)?.toBase58() ?? 'unknown'
      const now = Date.now()
      const limit = rateLimitMap.get(userKey)
      if (limit && now < limit.resetAt) {
        if (limit.count >= 10) {
          return reply.status(429).send({ error: 'Rate limit exceeded. Max 10 sponsored tx per hour.' })
        }
        limit.count++
      } else {
        rateLimitMap.set(userKey, { count: 1, resetAt: now + 3600_000 })
      }

      // Co-sign with fee payer
      tx.sign([solanaClient.feePayerKeypair])

      // Send
      const connection = new (await import('@solana/web3.js')).Connection(config.solana.rpcUrl, 'confirmed')
      const sig = await connection.sendTransaction(tx)

      return { txSig: sig }
    } catch (err) {
      console.error('[sponsor] Error:', (err as Error).message)
      return reply.status(500).send({ error: (err as Error).message })
    }
  })

  const rejectedCartoonsStore = new JsonStore<Array<{ caption: string; imageUrl: string; reason: string; rejectedAt: number }>>(join(config.dataDir, 'rejected-cartoons.json'))

  app.get('/api/feed/rejected', async () => {
    const rejected = (await rejectedCartoonsStore.read()) ?? []
    return rejected.sort((a, b) => b.rejectedAt - a.rejectedAt)
  })

  app.post('/api/auction/moderate', async (req, reply) => {
    const { text, imageUrl } = req.body as { text?: string; imageUrl?: string }
    if (!text || typeof text !== 'string') {
      return reply.status(400).send({ error: 'Missing text' })
    }

    const moderationSystem = `You are a content moderator for Sovra, an AI editorial cartoonist. Sovra draws satirical cartoons about public figures, institutions, tech companies, and ideas. It punches UP at the powerful, never down.

APPROVE requests that ask Sovra to:
- Satirize public figures for their PUBLIC actions/decisions
- Roast companies, institutions, or industries
- Comment on tech, politics, culture, or current events
- Draw funny/absurd scenarios about ideas or trends
- Include reference images of public figures, logos, products, or memes

REJECT requests that:
- Contain sexual, pornographic, or NSFW content (text OR image)
- Target people based on race, gender, religion, disability, or identity
- Promote violence, self-harm, or illegal activity
- Contain slurs or hate speech
- Attack private individuals (non-public figures)
- Include images of a graphic, violent, or sexual nature
- Are meaningless spam or gibberish

Respond with ONLY "APPROVE" or "REJECT: <short reason>". Nothing else.`

    try {
      type ContentPart = { type: 'text'; text: string } | { type: 'image'; image: URL }
      const parts: ContentPart[] = []

      if (imageUrl) {
        const fullUrl = imageUrl.startsWith('/') ? `http://localhost:${config.port}${imageUrl}` : imageUrl
        parts.push({ type: 'image', image: new URL(fullUrl) })
      }
      parts.push({ type: 'text', text })

      const { text: verdict } = await generateText({
        model: anthropic('claude-haiku-4-5-20250315'),
        system: moderationSystem,
        messages: [{ role: 'user', content: parts }],
      })

      const trimmed = verdict.trim()
      if (trimmed.startsWith('APPROVE')) {
        return { ok: true }
      }

      const reason = trimmed.replace(/^REJECT:\s*/i, '') || 'Content does not meet editorial guidelines.'
      return reply.status(403).send({ error: reason })
    } catch (err) {
      console.error('[moderate] Error:', (err as Error).message)
      return { ok: true }
    }
  })

  app.get('/api/auction/state', async () => {
    const state = await auction.getState()
    const bids = await auction.fetchBids()
    const topBid = bids[0]
      ? { bidder: bids[0].bidder, amountUsdc: bids[0].amountUsdc, requestText: bids[0].requestText, chain: bids[0].chain }
      : null
    return {
      ...state,
      nextSettleAt: auction.getNextSettleAt(state),
      bidCount: bids.length,
      topBid,
    }
  })

  app.get('/api/auction/bids', async () => {
    const bids = await auction.fetchBids()
    return bids.map(b => ({
      chain: b.chain,
      bidder: b.bidder,
      amountUsdc: b.amountUsdc,
      requestText: b.requestText,
    }))
  })

  // Start
  await app.listen({ port: config.port, host: '0.0.0.0' })
  console.log(`Dashboard: http://localhost:${config.port}`)
  console.log(`Console stream: http://localhost:${config.port}/api/console/stream`)

  agent.start()

  // Migrate old posts to R2 CDN (background, non-blocking)
  migratePostsToCdn(stores.posts).catch(err =>
    console.error('[r2] Migration failed:', (err as Error).message),
  )

  // Periodic backup to Postgres (every 1 min)
  if (backup) {
    const backupInterval = setInterval(async () => {
      try {
        const count = await backup!.backupAll(config.dataDir)
        if (count > 0) console.log(`[backup] Backed up ${count} files to Postgres`)
      } catch (err) {
        console.error('[backup] Failed:', (err as Error).message)
      }
    }, 60_000)

    // Cleanup on shutdown
    process.on('beforeExit', () => clearInterval(backupInterval))
  }

  const shutdown = async () => {
    console.log('Shutting down...')
    agent.stop()
    narrator?.stop()
    await Promise.all([signalCache.persist(), evalCache.persist(), imageCache.persist()])
    if (backup) {
      const count = await backup.backupAll(config.dataDir)
      console.log(`[backup] Final backup: ${count} files to Postgres`)
      await backup.close()
    }
    await app.close()
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
