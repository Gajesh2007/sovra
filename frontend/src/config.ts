// ============================================================
// SOVRA — Frontend Configuration (Mainnet)
// ============================================================

export const config = {
  privy: {
    appId: import.meta.env.VITE_PRIVY_APP_ID ?? '',
  },

  solana: {
    cluster: 'mainnet-beta' as const,
    rpcUrl: import.meta.env.VITE_SOLANA_RPC_URL ?? '',
    programId: import.meta.env.VITE_SOLANA_AUCTION_PROGRAM_ID ?? '',
    usdcMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    usdcDecimals: 6,
    explorerUrl: 'https://solscan.io',
  },

  base: {
    chainId: 8453,
    rpcUrl: import.meta.env.VITE_BASE_RPC_URL ?? '',
    auctionAddress: import.meta.env.VITE_BASE_AUCTION_ADDRESS as `0x${string}` ?? '',
    usdcAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as `0x${string}`,
    usdcDecimals: 6,
    explorerUrl: 'https://basescan.org',
  },
} as const

export const AUCTION_CONFIG = config
