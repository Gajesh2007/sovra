const testMode = process.env.TEST_MODE === 'true'

export const config = {
  testMode,
  port: Number(process.env.PORT || 3000),

  // AI
  textModel: 'claude-opus-4-6' as string,
  imageModel: 'google/gemini-3-pro-image' as const,

  // Twitter
  twitter: {
    readProvider: (process.env.TWITTER_READ_PROVIDER ?? 'v2') as 'v2' | 'proxy',
    postingEnabled: process.env.TWITTER_POSTING_ENABLED === 'true',
    bearerToken: process.env.TWITTER_BEARER_TOKEN!,
    apiKey: process.env.TWITTER_API_KEY!,
    apiSecret: process.env.TWITTER_API_SECRET!,
    accessToken: process.env.TWITTER_ACCESS_TOKEN!,
    accessSecret: process.env.TWITTER_ACCESS_SECRET!,
    twitterApiIoKey: process.env.TWITTERAPI_IO_KEY ?? '',
    username: process.env.TWITTER_USERNAME ?? '',
  },

  // Agent loop
  tickIntervalMs: testMode ? 10_000 : 30_000,
  flagshipIntervalMs: testMode ? 30_000 : 6 * 3600_000,     // 30s vs 6h
  quickhitCooldownMs: testMode ? 15_000 : 3600_000,          // 15s vs 1h

  // Adaptive posting: starts fast, slows exponentially per post
  posting: {
    minCooldownMs: testMode ? 5 * 60_000 : 45 * 60_000,     // 5min vs 45min
    maxCooldownMs: testMode ? 5 * 60_000 : 60 * 60_000,     // 5min vs 1h
    growthFactor: 1.5,
  },

  // Scanning
  scan: {
    twitterTimelineTtlMs: testMode ? 30_000 : 2 * 60_000,
    newsTtlMs: testMode ? 60_000 : 15 * 60_000,
  },

  // Image generation
  imageVariants: testMode ? 1 : 3,
  maxImageRetries: testMode ? 1 : 3,

  // Caching
  cache: {
    topicEvalTtlMs: testMode ? 60_000 : 3600_000,
    engagementEvalTtlMs: testMode ? 60_000 : 30 * 60_000,
    imagePromptTtlMs: testMode ? 60_000 : 24 * 3600_000,
    llmResponseTtlMs: testMode ? 60_000 : 3600_000,
    maxEntries: 1000,
  },

  // Auction
  auction: {
    cycleDurationSeconds: testMode ? 300 : 6 * 3600,           // 5min vs 6h
    minimumBidUsdc: 1_000_000,
    pollIntervalMs: testMode ? 15_000 : 60_000,
  },

  // Chains
  base: {
    enabled: !!process.env.BASE_RPC_URL,
    rpcUrl: process.env.BASE_RPC_URL ?? '',
    auctionAddress: process.env.BASE_AUCTION_ADDRESS ?? '',
    usdcAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // Base mainnet USDC
  },

  solana: {
    enabled: !!process.env.SOLANA_RPC_URL,
    rpcUrl: process.env.SOLANA_RPC_URL ?? '',
    programId: process.env.SOLANA_AUCTION_PROGRAM_ID ?? '',
    mnemonic: process.env.MNEMONIC ?? '',
  },

  // Narrator (voice)
  narrator: {
    enabled: !!process.env.ELEVENLABS_API_KEY,
    apiKey: process.env.ELEVENLABS_API_KEY ?? '',
    voiceId: process.env.ELEVENLABS_VOICE_ID ?? '',
  },

  // Video pipeline (Replicate Veo 3.1)
  video: {
    enabled: !!process.env.REPLICATE_API_TOKEN,
    replicateToken: process.env.REPLICATE_API_TOKEN ?? '',
    model: 'google/veo-3.1' as const,
    duration: 8,
    speedFactor: 0.667,      // 8s / 0.667 ≈ 12s final video
    resolution: '1080p' as const,
    aspectRatio: '16:9' as const,
  },

  // Worldview reflection
  reflectionIntervalMs: testMode ? 5 * 60_000 : 7 * 24 * 3600_000,  // 5min vs 7 days

  // Posting
  maxCaptionLength: 100,
  recentTopicWindowMs: 24 * 3600_000,

  // CDN (Cloudflare R2)
  r2: {
    enabled: !!process.env.R2_ACCESS_KEY_ID,
    accountId: process.env.R2_ACCOUNT_ID ?? '',
    accessKeyId: process.env.R2_ACCESS_KEY_ID ?? '',
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? '',
    bucketName: process.env.R2_BUCKET_NAME ?? '',
    publicUrl: process.env.R2_PUBLIC_URL ?? '',
  },

  // Postgres backup
  postgres: {
    enabled: !!process.env.DATABASE_URL,
    url: process.env.DATABASE_URL ?? '',
  },

  // Paths
  dataDir: '.data',
} as const

if (testMode) {
  console.log(`[TEST MODE] Fast timers: tick 10s, flagship 30s, quickhit 15s, 1 image variant | Model: ${config.textModel}`)
}
