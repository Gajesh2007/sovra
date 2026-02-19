import type { ChainAuctionClient } from './types.js'
import type { ChainBid, AuctionState } from './types.js'
import { JsonStore } from '../store/json-store.js'
import { EventBus } from '../console/events.js'
import { config } from '../config/index.js'

interface BidRequest {
  requestText: string
  imageUrl?: string
}

export class AuctionOrchestrator {
  private stateStore: JsonStore<AuctionState>
  private bidRequests: JsonStore<Record<string, BidRequest>>

  constructor(
    private events: EventBus,
    private clients: ChainAuctionClient[],
    storePath: string,
  ) {
    this.stateStore = new JsonStore(storePath)
    const dir = storePath.substring(0, storePath.lastIndexOf('/'))
    this.bidRequests = new JsonStore(`${dir}/bid-requests.json`)
  }

  async getState(): Promise<AuctionState> {
    return (
      (await this.stateStore.read()) ?? {
        lastSettledAt: null,
        settled: false,
      }
    )
  }

  async shouldSettle(): Promise<boolean> {
    const state = await this.getState()
    if (state.lastSettledAt == null) return true // never settled — run immediately
    const now = Math.floor(Date.now() / 1000)
    return now - state.lastSettledAt >= config.auction.cycleDurationSeconds
  }

  getNextSettleAt(state: AuctionState): number | null {
    if (state.lastSettledAt == null) return Math.floor(Date.now() / 1000)
    return state.lastSettledAt + config.auction.cycleDurationSeconds
  }

  // --- Off-chain bid request storage ---

  async saveBidRequest(bidder: string, requestText: string, imageUrl?: string): Promise<void> {
    const map = (await this.bidRequests.read()) ?? {}
    map[bidder] = { requestText, imageUrl: imageUrl ?? map[bidder]?.imageUrl }
    await this.bidRequests.write(map)
  }

  async getBidRequest(bidder: string): Promise<BidRequest | null> {
    const map = (await this.bidRequests.read()) ?? {}
    return map[bidder] ?? null
  }

  // --- Fetch bids from all chains, merge with off-chain data ---

  async fetchBids(): Promise<ChainBid[]> {
    const allBids: ChainBid[] = []
    const map = (await this.bidRequests.read()) ?? {}
    const knownBidders = Object.keys(map)

    for (const client of this.clients) {
      try {
        const bids = await client.getActiveBids(knownBidders)
        allBids.push(...bids)
      } catch (err) {
        this.events.monologue(`Failed to fetch ${client.chain} bids: ${(err as Error).message}`)
      }
    }

    // Merge with off-chain request data
    for (const bid of allBids) {
      const req = map[bid.bidder]
      if (req) {
        bid.requestText = req.requestText
        bid.imageUrl = req.imageUrl
      }
    }

    // Sort by amount descending
    allBids.sort((a, b) => b.amountUsdc - a.amountUsdc)

    return allBids
  }

  async settleWinner(winner: ChainBid): Promise<void> {
    this.events.monologue(
      `Settling auction. Winner: ${winner.bidder.slice(0, 10)}... ($${winner.amountUsdc} USDC on ${winner.chain}).`,
    )

    const client = this.clients.find((c) => c.chain === winner.chain)
    if (client) {
      await client.settle(winner.bidRef)
    }

    await this.markSettled()

    this.events.emit({
      type: 'auction',
      action: 'settled',
      details: {
        chain: winner.chain,
        bidder: winner.bidder,
        amount: winner.amountUsdc,
        request: winner.requestText.slice(0, 100),
      },
      ts: Date.now(),
    })
  }

  async markSettled(): Promise<void> {
    await this.stateStore.write({
      lastSettledAt: Math.floor(Date.now() / 1000),
      settled: true,
    })
  }
}
