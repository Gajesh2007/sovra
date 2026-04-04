const testMode = process.env.TEST_MODE === 'true'

export const config = {
  testMode,
  port: Number(process.env.PORT || 3000),

  // AI
  textModel: 'claude-sonnet-4-20250514' as string,
  imageModel: 'gemini-2.5-flash-image' as string,

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
    searchEnabled: process.env.TWITTER_SEARCH_ENABLED !== 'false',
    searchQueries: (process.env.TWITTER_SEARCH_QUERIES
      ?? [
        // Core intersection — consolidated with OR operators to reduce API calls
        '"Bitcoin AI" OR "BTC AI" OR "Bitcoin agents" -is:retweet lang:en',
        '"agent economy" (Bitcoin OR crypto OR blockchain) -is:retweet lang:en',
        '(Stacks OR Lightning) AI agents -is:retweet lang:en',
        // Broader net — let LLM relevance filter handle precision
        '(OpenAI OR Anthropic OR "Claude" OR "GPT") Bitcoin -is:retweet lang:en',
        '"AI agents" (crypto OR blockchain OR decentralized) -is:retweet lang:en',
      ].join(',')
    ).split(',').map(q => q.trim()).filter(Boolean),
    searchCacheTtlMs: Number(process.env.TWITTER_SEARCH_CACHE_TTL ?? 30 * 60_000), // 30 min
    searchMinLikes: Number(process.env.TWITTER_SEARCH_MIN_LIKES ?? 10),
    searchMinFollowers: Number(process.env.TWITTER_SEARCH_MIN_FOLLOWERS ?? 50),
    searchMaxResults: Number(process.env.TWITTER_SEARCH_MAX_RESULTS ?? 60),
  },

  // AIBTC.news API
  aibtcNews: {
    baseUrl: process.env.AIBTC_NEWS_URL ?? 'https://aibtc.news',
    beats: (process.env.AIBTC_BEATS ?? 'dev-tools,ordinals-culture,governance,defi').split(','),
    pollIntervalMs: testMode ? 30_000 : 5 * 60_000,  // 30s vs 5min
  },

  // Bitcoin Magazine RSS
  btcMag: {
    feedUrl: process.env.BTCMAG_FEED_URL ?? 'https://bitcoinmagazine.com/feed',
    maxArticles: Number(process.env.BTCMAG_MAX_ARTICLES ?? 30),
    enabled: process.env.BTCMAG_ENABLED !== 'false',  // enabled by default
  },

  // Additional RSS feeds (CoinDesk, The Defiant, etc.)
  rssFeeds: [
    {
      key: 'coindesk',
      name: 'CoinDesk',
      feedUrl: process.env.COINDESK_FEED_URL ?? 'https://www.coindesk.com/arc/outboundfeeds/rss/',
      maxArticles: Number(process.env.COINDESK_MAX_ARTICLES ?? 30),
      enabled: process.env.COINDESK_ENABLED !== 'false',
    },
    {
      key: 'thedefiant',
      name: 'The Defiant',
      feedUrl: process.env.THEDEFIANT_FEED_URL ?? 'https://thedefiant.io/feed',
      maxArticles: Number(process.env.THEDEFIANT_MAX_ARTICLES ?? 30),
      enabled: process.env.THEDEFIANT_ENABLED !== 'false',
    },
  ],

  // Google News RSS (aggregates from hundreds of publishers)
  googleNews: {
    enabled: process.env.GOOGLE_NEWS_ENABLED !== 'false',  // enabled by default
    queries: (process.env.GOOGLE_NEWS_QUERIES
      ?? [
        'Bitcoin AI agents',
        'Bitcoin artificial intelligence',
        'AI autonomous crypto blockchain',
        'Bitcoin AI data center mining',
        '"AI agents" Bitcoin OR Stacks OR Lightning',
      ].join(',')
    ).split(',').map(q => q.trim()).filter(Boolean),
    maxArticles: Number(process.env.GOOGLE_NEWS_MAX_ARTICLES ?? 60),
    lookbackMs: 48 * 60 * 60 * 1000,  // 48 hours
  },

  // Agent loop
  tickIntervalMs: testMode ? 10_000 : 600_000,  // 10s test vs 10min production
  flagshipIntervalMs: testMode ? 30_000 : 2 * 3600_000,     // 30s vs 2h (minimum cooldown between posts)
  quickhitCooldownMs: testMode ? 15_000 : 3600_000,          // 15s vs 1h

  // Scheduled posting: target specific hours of the day (24h format)
  schedule: {
    enabled: !testMode,
    postingHours: (process.env.POSTING_HOURS ?? '8,20').split(',').map(Number),  // 8am, 8pm ET
    timezone: process.env.POSTING_TIMEZONE ?? 'America/New_York',
    windowMinutes: 30,   // Fire within ±30 min of target hour
    minCooldownMs: testMode ? 30_000 : 10 * 3600_000,  // Minimum 10h between posts (supports 2/day schedule)
    scanWindowMinutes: 65,  // Only scan within this many minutes of a posting window
  },

  // Adaptive posting: starts fast, slows exponentially per post
  posting: {
    minCooldownMs: testMode ? 5 * 60_000 : 45 * 60_000,     // 5min vs 45min
    maxCooldownMs: testMode ? 5 * 60_000 : 60 * 60_000,     // 5min vs 1h
    growthFactor: 1.5,
  },

  // Scanning
  scan: {
    newsTtlMs: testMode ? 60_000 : 15 * 60_000,
  },

  // Image generation
  imageVariants: testMode ? 1 : 3,
  maxImageRetries: testMode ? 2 : 5,

  // Caching
  cache: {
    topicEvalTtlMs: testMode ? 60_000 : 30 * 60_000,
    engagementEvalTtlMs: testMode ? 60_000 : 30 * 60_000,
    imagePromptTtlMs: testMode ? 60_000 : 24 * 3600_000,
    llmResponseTtlMs: testMode ? 60_000 : 3600_000,
    maxEntries: 1000,
  },

  // Engagement intervals (adaptive: faster near posting windows, slower off-hours)
  engagementActiveMs: testMode ? 10_000 : 5 * 60_000,       // 5 min near posting windows
  engagementOffHoursMs: testMode ? 60_000 : 30 * 60_000,    // 30 min during off-hours

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

  // Bitcoin Ordinals inscription
  ordinals: {
    enabled: process.env.INSCRIPTION_ENABLED === 'true',
    network: (process.env.ORDINALS_NETWORK ?? 'testnet') as 'mainnet' | 'testnet',
    mnemonic: process.env.ORDINALS_MNEMONIC ?? '',
    maxFeeRate: Number(process.env.ORDINALS_MAX_FEE_RATE ?? 3),
    maxCostUSD: Number(process.env.ORDINALS_MAX_COST_USD ?? 2),
    mempoolApi: process.env.ORDINALS_MEMPOOL_API ?? 'https://mempool.space/testnet4/api',
  },

  // Paths
  dataDir: '.data',
} as const

if (testMode) {
  console.log(`[TEST MODE] Fast timers: tick 10s, flagship 30s, quickhit 15s, 1 image variant | Model: ${config.textModel}`)
}

