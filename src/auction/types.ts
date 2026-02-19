export interface ChainBid {
  chain: 'solana' | 'base'
  bidder: string
  amountRaw: bigint
  amountUsdc: number
  requestText: string
  timestamp: number
  imageUrl?: string
  bidRef: string // Solana: bid PDA base58, Base: bidder address
}

export interface AuctionState {
  lastSettledAt: number | null
  settled: boolean
}

export interface ChainAuctionClient {
  chain: 'solana' | 'base'
  getActiveBids(knownBidders?: string[]): Promise<ChainBid[]>
  settle(bidRef: string): Promise<string>
}
