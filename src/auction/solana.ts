import {
  Connection,
  PublicKey,
  Keypair,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  sendAndConfirmTransaction,
} from '@solana/web3.js'
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
} from '@solana/spl-token'
import bs58 from 'bs58'
import * as bip39 from 'bip39'
import { derivePath } from 'ed25519-hd-key'
import { EventBus } from '../console/events.js'
import type { ChainBid, ChainAuctionClient } from './types.js'

const DISCRIMINATORS = {
  initialize:  Buffer.from([175, 175, 109, 31, 13, 152, 155, 237]),
  placeBid:    Buffer.from([238, 77, 148, 91, 200, 151, 92, 146]),
  updateBid:   Buffer.from([30, 24, 210, 187, 71, 101, 78, 46]),
  withdrawBid: Buffer.from([110, 53, 157, 195, 147, 100, 110, 73]),
  settle:      Buffer.from([175, 42, 185, 87, 144, 131, 102, 212]),
  bidAccount:  Buffer.from([143, 246, 48, 245, 42, 145, 180, 88]),
}

const MAINNET_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

function deriveKeypair(mnemonic: string, accountIndex: number): Keypair {
  const seed = bip39.mnemonicToSeedSync(mnemonic)
  const path = `m/44'/501'/${accountIndex}'/0'`
  const derived = derivePath(path, seed.toString('hex'))
  return Keypair.fromSeed(derived.key)
}

export class SolanaAuctionClient implements ChainAuctionClient {
  chain = 'solana' as const
  private connection: Connection
  private programId: PublicKey
  private usdcMint: PublicKey | null = null
  public feePayerKeypair: Keypair

  constructor(
    private events: EventBus,
    programId: string,
    rpcUrl: string,
    private agentKeypair: Keypair,
    feePayerKeypair?: Keypair,
  ) {
    this.connection = new Connection(rpcUrl, 'confirmed')
    this.programId = new PublicKey(programId)
    this.feePayerKeypair = feePayerKeypair ?? agentKeypair
  }

  static fromMnemonic(
    events: EventBus,
    programId: string,
    rpcUrl: string,
    mnemonic: string,
  ): SolanaAuctionClient {
    const agent = deriveKeypair(mnemonic, 0)
    const feePayer = deriveKeypair(mnemonic, 1)
    events.monologue(`Solana agent: ${agent.publicKey.toBase58()}`)
    events.monologue(`Solana fee payer: ${feePayer.publicKey.toBase58()}`)
    return new SolanaAuctionClient(events, programId, rpcUrl, agent, feePayer)
  }

  // --- PDAs ---

  private getAuctionStatePda(): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from('auction_state')],
      this.programId,
    )
    return pda
  }

  private getEscrowPda(): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from('escrow')],
      this.programId,
    )
    return pda
  }

  getBidPda(bidder: string): PublicKey {
    const bidderPubkey = new PublicKey(bidder)
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from('bid'), bidderPubkey.toBuffer()],
      this.programId,
    )
    return pda
  }

  // --- Auto-initialize if needed ---

  async ensureInitialized(minimumBid: number): Promise<void> {
    const auctionStatePda = this.getAuctionStatePda()
    const info = await this.connection.getAccountInfo(auctionStatePda)
    if (info) return

    this.events.monologue('Auction not initialized on-chain — initializing now...')

    const usdcMint = new PublicKey(MAINNET_USDC_MINT)
    const escrowPda = this.getEscrowPda()

    const treasury = await getAssociatedTokenAddress(usdcMint, this.agentKeypair.publicKey)

    const tx = new Transaction()

    const treasuryExists = await this.connection.getAccountInfo(treasury)
    if (!treasuryExists) {
      tx.add(createAssociatedTokenAccountInstruction(
        this.agentKeypair.publicKey,
        treasury,
        this.agentKeypair.publicKey,
        usdcMint,
      ))
    }

    const data = Buffer.alloc(16)
    DISCRIMINATORS.initialize.copy(data, 0)
    data.writeBigUInt64LE(BigInt(minimumBid), 8)

    tx.add(new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: auctionStatePda, isSigner: false, isWritable: true },
        { pubkey: usdcMint, isSigner: false, isWritable: false },
        { pubkey: treasury, isSigner: false, isWritable: false },
        { pubkey: escrowPda, isSigner: false, isWritable: true },
        { pubkey: this.agentKeypair.publicKey, isSigner: true, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data,
    }))

    const sig = await sendAndConfirmTransaction(this.connection, tx, [this.agentKeypair])
    this.events.monologue(`Auction initialized on-chain. TX: ${sig}`)
  }

  // --- Read: USDC mint from on-chain state ---

  private async getUsdcMint(): Promise<PublicKey> {
    if (this.usdcMint) return this.usdcMint
    const pda = this.getAuctionStatePda()
    const info = await this.connection.getAccountInfo(pda)
    if (!info) return new PublicKey(MAINNET_USDC_MINT)
    this.usdcMint = new PublicKey((info.data as Buffer).subarray(8 + 32, 8 + 32 + 32))
    return this.usdcMint
  }

  // --- Read: all active bids ---

  async getActiveBids(): Promise<ChainBid[]> {
    const accounts = await this.connection.getProgramAccounts(this.programId, {
      filters: [
        { memcmp: { offset: 0, bytes: bs58.encode(DISCRIMINATORS.bidAccount) } },
      ],
    })

    const bids: ChainBid[] = []
    for (const { pubkey, account } of accounts) {
      const parsed = this.parseBidAccount(account.data as Buffer)
      if (parsed && parsed.active) {
        bids.push({
          chain: 'solana',
          bidder: parsed.bidder,
          amountRaw: BigInt(parsed.amount),
          amountUsdc: parsed.amount / 1_000_000,
          requestText: '', // stored off-chain in agent
          timestamp: parsed.createdAt,
          bidRef: pubkey.toBase58(),
        })
      }
    }

    return bids
  }

  // --- Write: settle ---

  async settle(winningBidRef: string): Promise<string> {
    const winningBidPda = new PublicKey(winningBidRef)
    const auctionStatePda = this.getAuctionStatePda()
    const escrowPda = this.getEscrowPda()
    const usdcMint = await this.getUsdcMint()

    const stateInfo = await this.connection.getAccountInfo(auctionStatePda)
    if (!stateInfo) throw new Error('Auction state not found')
    // Layout: discriminator(8) + agent(32) + usdc_mint(32) + treasury(32)
    const treasury = new PublicKey((stateInfo.data as Buffer).subarray(8 + 32 + 32, 8 + 32 + 32 + 32))

    const ix = new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: auctionStatePda, isSigner: false, isWritable: true },
        { pubkey: winningBidPda, isSigner: false, isWritable: true },
        { pubkey: escrowPda, isSigner: false, isWritable: true },
        { pubkey: treasury, isSigner: false, isWritable: true },
        { pubkey: usdcMint, isSigner: false, isWritable: false },
        { pubkey: this.agentKeypair.publicKey, isSigner: true, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: DISCRIMINATORS.settle,
    })

    const tx = new Transaction().add(ix)
    const sig = await sendAndConfirmTransaction(this.connection, tx, [this.agentKeypair])
    this.events.monologue(`Settled Solana bid. TX: ${sig}`)
    return sig
  }

  // --- Parse ---

  private parseBidAccount(data: Buffer): {
    bidder: string
    amount: number
    createdAt: number
    updatedAt: number
    active: boolean
  } | null {
    try {
      let offset = 8 // skip discriminator
      const bidder = new PublicKey(data.subarray(offset, offset + 32)).toBase58(); offset += 32
      const amount = Number(data.readBigUInt64LE(offset)); offset += 8
      const createdAt = Number(data.readBigInt64LE(offset)); offset += 8
      const updatedAt = Number(data.readBigInt64LE(offset)); offset += 8
      const active = data.readUInt8(offset) === 1
      return { bidder, amount, createdAt, updatedAt, active }
    } catch {
      return null
    }
  }
}
