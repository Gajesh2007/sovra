import { useState, useEffect, useCallback, useRef } from 'react'
import { useWallets } from '@privy-io/react-auth/solana'
import {
  Connection,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  SystemProgram,
} from '@solana/web3.js'
import {
  getAssociatedTokenAddress,
  getAccount,
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token'
import { config } from '../config'

const PLACE_BID_DISCRIMINATOR = new Uint8Array([238, 77, 148, 91, 200, 151, 92, 146])
const UPDATE_BID_DISCRIMINATOR = new Uint8Array([30, 24, 210, 187, 71, 101, 78, 46])
const WITHDRAW_BID_DISCRIMINATOR = new Uint8Array([110, 53, 157, 195, 147, 100, 110, 73])
const CLOSE_BID_DISCRIMINATOR = new Uint8Array([169, 171, 66, 115, 220, 168, 231, 21])
const BID_ACCOUNT_DISCRIMINATOR = new Uint8Array([143, 246, 48, 245, 42, 145, 180, 88])

interface ActiveBid {
  amount: number
  requestText: string
  active: boolean
}

interface SponsorInfo {
  feePayerAddress: string
  programId: string
}

async function fetchSponsorInfo(): Promise<SponsorInfo> {
  const res = await fetch('/api/sponsor/info')
  if (!res.ok) throw new Error('Failed to fetch sponsor info')
  return res.json()
}

async function sponsorTransaction(serializedTx: string): Promise<string> {
  const res = await fetch('/api/sponsor', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transaction: serializedTx }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: 'Sponsorship failed' }))
    throw new Error(body.error ?? 'Sponsorship failed')
  }
  const { txSig } = await res.json()
  return txSig
}

export function useSolanaBid() {
  const { wallets } = useWallets()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [txSig, setTxSig] = useState<string | null>(null)
  const [activeBid, setActiveBid] = useState<ActiveBid | null>(null)
  const [usdcBalance, setUsdcBalance] = useState<number | null>(null)
  const sponsorInfoRef = useRef<SponsorInfo | null>(null)

  const wallet = wallets[0]
  const bidder = wallet ? new PublicKey(wallet.address) : null

  const getSponsorInfo = useCallback(async (): Promise<SponsorInfo> => {
    if (sponsorInfoRef.current) return sponsorInfoRef.current
    const info = await fetchSponsorInfo()
    sponsorInfoRef.current = info
    return info
  }, [])

  const loadActiveBid = useCallback(async () => {
    if (!bidder) { setActiveBid(null); return }

    try {
      const connection = new Connection(config.solana.rpcUrl, 'confirmed')
      const programId = new PublicKey(config.solana.programId)

      const [bidPda] = PublicKey.findProgramAddressSync(
        [Buffer.from('bid'), bidder.toBuffer()], programId)

      const info = await connection.getAccountInfo(bidPda)
      if (!info) { setActiveBid(null); return }

      const data = info.data
      const disc = data.subarray(0, 8)
      if (!disc.every((b, i) => b === BID_ACCOUNT_DISCRIMINATOR[i])) {
        setActiveBid(null)
        return
      }

      // Layout: discriminator(8) + bidder(32) + amount(8) + created_at(8) + updated_at(8) + active(1) + bump(1)
      let offset = 8 + 32
      const amount = Number(data.readBigUInt64LE(offset)); offset += 8
      offset += 8 + 8 // skip created_at + updated_at
      const active = data.readUInt8(offset) === 1

      if (active) {
        // Fetch request text from off-chain store
        let requestText = ''
        try {
          const res = await fetch(`/api/auction/request/${bidder.toBase58()}`)
          const reqData = await res.json()
          requestText = reqData.requestText ?? ''
        } catch {}
        setActiveBid({ amount: amount / 1_000_000, requestText, active })
      } else {
        setActiveBid(null)
      }
    } catch {
      setActiveBid(null)
    }
  }, [bidder?.toBase58()])

  const loadBalance = useCallback(async () => {
    if (!bidder) { setUsdcBalance(null); return }
    try {
      const connection = new Connection(config.solana.rpcUrl, 'confirmed')
      const usdcMint = new PublicKey(config.solana.usdcMint)
      const ata = await getAssociatedTokenAddress(usdcMint, bidder)
      const account = await getAccount(connection, ata)
      setUsdcBalance(Number(account.amount) / 10 ** config.solana.usdcDecimals)
    } catch {
      setUsdcBalance(0)
    }
  }, [bidder?.toBase58()])

  useEffect(() => {
    loadActiveBid()
    loadBalance()
    const interval = setInterval(() => { loadActiveBid(); loadBalance() }, 15_000)
    return () => clearInterval(interval)
  }, [loadActiveBid, loadBalance])

  async function buildAndSponsor(instructions: TransactionInstruction[]): Promise<string> {
    if (!wallet) throw new Error('No Solana wallet found. Sign in first.')

    const sponsorInfo = await getSponsorInfo()
    const connection = new Connection(config.solana.rpcUrl, 'confirmed')
    const feePayerPubkey = new PublicKey(sponsorInfo.feePayerAddress)

    const { blockhash } = await connection.getLatestBlockhash()

    const messageV0 = new TransactionMessage({
      payerKey: feePayerPubkey,
      recentBlockhash: blockhash,
      instructions,
    }).compileToV0Message()

    const tx = new VersionedTransaction(messageV0)

    const { signedTransaction } = await wallet.signTransaction({ transaction: tx.serialize() })

    const serialized = Buffer.from(signedTransaction).toString('base64')
    return sponsorTransaction(serialized)
  }

  async function placeBid(amountUsdc: number, requestText: string) {
    if (!Number.isFinite(amountUsdc) || amountUsdc <= 0 || amountUsdc > 100_000) {
      setError('Invalid bid amount.')
      return
    }
    if (!requestText || requestText.length > 500) {
      setError('Invalid request text.')
      return
    }

    setLoading(true)
    setError(null)
    setTxSig(null)

    try {
      const programId = new PublicKey(config.solana.programId)
      const usdcMint = new PublicKey(config.solana.usdcMint)
      const walletPubkey = new PublicKey(wallet!.address)
      const sponsorInfo = await getSponsorInfo()
      const feePayerPubkey = new PublicKey(sponsorInfo.feePayerAddress)
      const amountRaw = BigInt(Math.round(amountUsdc * 10 ** config.solana.usdcDecimals))
      const connection = new Connection(config.solana.rpcUrl, 'confirmed')

      const [auctionStatePda] = PublicKey.findProgramAddressSync([Buffer.from('auction_state')], programId)
      const [bidPda] = PublicKey.findProgramAddressSync([Buffer.from('bid'), walletPubkey.toBuffer()], programId)
      const [escrowPda] = PublicKey.findProgramAddressSync([Buffer.from('escrow')], programId)
      const bidderUsdc = await getAssociatedTokenAddress(usdcMint, walletPubkey)

      const instructions: TransactionInstruction[] = []

      // Create ATA if needed — fee payer pays rent
      try { await getAccount(connection, bidderUsdc) } catch {
        instructions.push(createAssociatedTokenAccountInstruction(feePayerPubkey, bidderUsdc, walletPubkey, usdcMint))
      }

      // If stale bid PDA exists (inactive/settled), close it first to reclaim rent
      const bidAccountInfo = await connection.getAccountInfo(bidPda)
      if (bidAccountInfo) {
        // New layout: discriminator(8) + bidder(32) + amount(8) + created_at(8) + updated_at(8) + active(1)
        const activeOffset = 8 + 32 + 8 + 8 + 8
        const isActive = bidAccountInfo.data.length > activeOffset && bidAccountInfo.data.readUInt8(activeOffset) === 1
        if (!isActive) {
          instructions.push(new TransactionInstruction({
            programId,
            keys: [
              { pubkey: bidPda, isSigner: false, isWritable: true },
              { pubkey: walletPubkey, isSigner: true, isWritable: true },
            ],
            data: Buffer.from(CLOSE_BID_DISCRIMINATOR),
          }))
        }
      }

      // Fund bidder with enough SOL for bid PDA rent (fee payer sponsors this)
      if (!bidAccountInfo) {
        // New size: discriminator(8) + bidder(32) + amount(8) + created_at(8) + updated_at(8) + active(1) + bump(1)
        const BID_ACCOUNT_SIZE = 8 + 32 + 8 + 8 + 8 + 1 + 1
        const rentLamports = await connection.getMinimumBalanceForRentExemption(BID_ACCOUNT_SIZE)
        const bidderBalance = await connection.getBalance(walletPubkey)
        if (bidderBalance < rentLamports) {
          instructions.push(SystemProgram.transfer({
            fromPubkey: feePayerPubkey,
            toPubkey: walletPubkey,
            lamports: rentLamports - bidderBalance,
          }))
        }
      }

      // On-chain: just amount (no text)
      const amountBuf = Buffer.alloc(8)
      amountBuf.writeBigUInt64LE(amountRaw)

      instructions.push(new TransactionInstruction({
        programId,
        keys: [
          { pubkey: auctionStatePda, isSigner: false, isWritable: true },
          { pubkey: bidPda, isSigner: false, isWritable: true },
          { pubkey: bidderUsdc, isSigner: false, isWritable: true },
          { pubkey: escrowPda, isSigner: false, isWritable: true },
          { pubkey: usdcMint, isSigner: false, isWritable: false },
          { pubkey: walletPubkey, isSigner: true, isWritable: true },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: Buffer.concat([Buffer.from(PLACE_BID_DISCRIMINATOR), amountBuf]),
      }))

      const sig = await buildAndSponsor(instructions)
      setTxSig(sig)

      // Store request text off-chain
      await fetch('/api/auction/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bidder: walletPubkey.toBase58(), requestText }),
      })

      await loadActiveBid()
    } catch (err) {
      const msg = (err as Error).message
      if (msg.includes('insufficient funds')) setError('Insufficient USDC balance.')
      else if (msg.includes('User rejected')) setError('Transaction cancelled.')
      else setError(msg)
    } finally {
      setLoading(false)
    }
  }

  async function updateBid(newRequestText: string, amountChangeUsdc: number) {
    setLoading(true)
    setError(null)

    try {
      const walletPubkey = new PublicKey(wallet!.address)

      // If only text changed (no amount change), just update off-chain — no transaction needed
      if (amountChangeUsdc === 0) {
        await fetch('/api/auction/request', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ bidder: walletPubkey.toBase58(), requestText: newRequestText }),
        })
        setTxSig('text-only-update')
        await loadActiveBid()
        return
      }

      // Amount changed — need on-chain transaction
      const programId = new PublicKey(config.solana.programId)
      const usdcMint = new PublicKey(config.solana.usdcMint)
      const amountChangeRaw = BigInt(Math.round(amountChangeUsdc * 10 ** config.solana.usdcDecimals))

      const [auctionStatePda] = PublicKey.findProgramAddressSync([Buffer.from('auction_state')], programId)
      const [bidPda] = PublicKey.findProgramAddressSync([Buffer.from('bid'), walletPubkey.toBuffer()], programId)
      const [escrowPda] = PublicKey.findProgramAddressSync([Buffer.from('escrow')], programId)
      const bidderUsdc = await getAssociatedTokenAddress(usdcMint, walletPubkey)

      // On-chain: just amount_change (i64)
      const changeBuf = Buffer.alloc(8)
      changeBuf.writeBigInt64LE(amountChangeRaw)

      const instructions = [new TransactionInstruction({
        programId,
        keys: [
          { pubkey: auctionStatePda, isSigner: false, isWritable: false },
          { pubkey: bidPda, isSigner: false, isWritable: true },
          { pubkey: bidderUsdc, isSigner: false, isWritable: true },
          { pubkey: escrowPda, isSigner: false, isWritable: true },
          { pubkey: usdcMint, isSigner: false, isWritable: false },
          { pubkey: walletPubkey, isSigner: true, isWritable: true },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        data: Buffer.concat([Buffer.from(UPDATE_BID_DISCRIMINATOR), changeBuf]),
      })]

      const sig = await buildAndSponsor(instructions)
      setTxSig(sig)

      // Update request text off-chain
      await fetch('/api/auction/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bidder: walletPubkey.toBase58(), requestText: newRequestText }),
      })

      await loadActiveBid()
    } catch (err) {
      const msg = (err as Error).message
      if (msg.includes('User rejected')) setError('Transaction cancelled.')
      else setError(msg)
    } finally {
      setLoading(false)
    }
  }

  async function withdrawBid() {
    setLoading(true)
    setError(null)

    try {
      const programId = new PublicKey(config.solana.programId)
      const usdcMint = new PublicKey(config.solana.usdcMint)
      const walletPubkey = new PublicKey(wallet!.address)

      const [auctionStatePda] = PublicKey.findProgramAddressSync([Buffer.from('auction_state')], programId)
      const [bidPda] = PublicKey.findProgramAddressSync([Buffer.from('bid'), walletPubkey.toBuffer()], programId)
      const [escrowPda] = PublicKey.findProgramAddressSync([Buffer.from('escrow')], programId)
      const bidderUsdc = await getAssociatedTokenAddress(usdcMint, walletPubkey)

      const instructions = [new TransactionInstruction({
        programId,
        keys: [
          { pubkey: auctionStatePda, isSigner: false, isWritable: true },
          { pubkey: bidPda, isSigner: false, isWritable: true },
          { pubkey: bidderUsdc, isSigner: false, isWritable: true },
          { pubkey: escrowPda, isSigner: false, isWritable: true },
          { pubkey: usdcMint, isSigner: false, isWritable: false },
          { pubkey: walletPubkey, isSigner: true, isWritable: true },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        data: Buffer.from(WITHDRAW_BID_DISCRIMINATOR),
      })]

      const sig = await buildAndSponsor(instructions)
      setTxSig(sig)
      setActiveBid(null)
    } catch (err) {
      const msg = (err as Error).message
      if (msg.includes('User rejected')) setError('Transaction cancelled.')
      else setError(msg)
    } finally {
      setLoading(false)
    }
  }

  return { placeBid, updateBid, withdrawBid, loading, error, txSig, activeBid, usdcBalance, walletAddress: bidder?.toBase58() ?? null }
}
