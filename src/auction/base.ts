import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  type Address,
} from 'viem'
import { base } from 'viem/chains'
import { privateKeyToAccount, mnemonicToAccount } from 'viem/accounts'
import { EventBus } from '../console/events.js'
import type { ChainBid, ChainAuctionClient } from './types.js'

const AUCTION_ABI = parseAbi([
  'function getBid(address bidder) view returns (uint256 amount, uint64 createdAt, uint64 updatedAt, bool active)',
  'function settle(address winner) external',
  'function activeBidCount() view returns (uint256)',
  'function minimumBid() view returns (uint256)',
])

export class BaseAuctionClient implements ChainAuctionClient {
  chain = 'base' as const
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private publicClient: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private walletClient: any
  private contractAddress: Address

  constructor(
    private events: EventBus,
    rpcUrl: string,
    contractAddress: string,
    account: ReturnType<typeof privateKeyToAccount> | ReturnType<typeof mnemonicToAccount>,
  ) {
    this.contractAddress = contractAddress as Address

    this.publicClient = createPublicClient({
      chain: base,
      transport: http(rpcUrl),
    })

    this.walletClient = createWalletClient({
      account,
      chain: base,
      transport: http(rpcUrl),
    })

    events.monologue(`Base agent: ${account.address}`)
  }

  static fromMnemonic(
    events: EventBus,
    rpcUrl: string,
    contractAddress: string,
    mnemonic: string,
  ): BaseAuctionClient {
    const account = mnemonicToAccount(mnemonic)
    return new BaseAuctionClient(events, rpcUrl, contractAddress, account)
  }

  async getActiveBids(knownBidders?: string[]): Promise<ChainBid[]> {
    if (!knownBidders || knownBidders.length === 0) return []

    const bids: ChainBid[] = []

    for (const bidder of knownBidders) {
      if (!bidder.startsWith('0x') || bidder.length !== 42) continue
      try {
        const [amount, createdAt, , active] = await this.publicClient.readContract({
          address: this.contractAddress,
          abi: AUCTION_ABI,
          functionName: 'getBid',
          args: [bidder as Address],
        })

        if (active && amount > 0n) {
          bids.push({
            chain: 'base',
            bidder,
            amountRaw: amount,
            amountUsdc: Number(amount) / 1_000_000,
            requestText: '', // stored off-chain in agent
            timestamp: Number(createdAt),
            bidRef: bidder,
          })
        }
      } catch (err) {
        this.events.monologue(`Failed to read Base bid for ${bidder}: ${(err as Error).message}`)
      }
    }

    return bids
  }

  async settle(bidRef: string): Promise<string> {
    const hash = await this.walletClient.writeContract({
      address: this.contractAddress,
      abi: AUCTION_ABI,
      functionName: 'settle',
      args: [bidRef as Address],
    })

    await this.publicClient.waitForTransactionReceipt({ hash })

    this.events.monologue(`Settled Base bid. TX: ${hash}`)
    return hash
  }
}
