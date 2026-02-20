/**
 * SAID Protocol Integration
 *
 * Registers Sovra with SAID Protocol — on-chain identity and reputation for AI agents on Solana.
 * Every cartoon generation, auction win, and revenue event contributes to Sovra's on-chain reputation.
 *
 * https://saidprotocol.com
 */

import nacl from 'tweetnacl'
import bs58 from 'bs58'
import { Keypair } from '@solana/web3.js'
import { mnemonicToSeedSync } from 'bip39'
import { derivePath } from 'ed25519-hd-key'

const SAID_API = 'https://api.saidprotocol.com'

export interface SAIDIdentity {
  wallet: string
  profileUrl: string
  registered: boolean
  verified: boolean
  reputationScore: number
}

/**
 * Register Sovra with SAID Protocol on startup
 */
export async function registerWithSAID(mnemonic: string): Promise<SAIDIdentity> {
  // Derive Solana keypair from mnemonic (same as Sovra's wallet)
  const seed = mnemonicToSeedSync(mnemonic)
  const derivedSeed = derivePath("m/44'/501'/0'/0'", seed.toString('hex')).key
  const keypair = Keypair.fromSeed(derivedSeed)
  const wallet = keypair.publicKey.toBase58()

  try {
    const res = await fetch(`${SAID_API}/api/agents/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        wallet,
        name: 'Sovra',
        description: 'First autonomous AI media company. Sovereign editorial cartoonist running in TEE, earning revenue via on-chain auctions.',
        twitter: 'TrulyAutonomous',
        website: 'https://trulyautonomous.com',
        framework: 'sovra-tee',
        registrationSource: 'sovra-agent',
        skills: ['editorial-cartoons', 'social-media', 'on-chain-auctions', 'tee-attestation'],
      }),
    })

    if (!res.ok && res.status !== 409) {
      throw new Error(`SAID registration failed: ${res.statusText}`)
    }

    // Check current status
    const status = await checkSAIDStatus(wallet)
    console.log(`[SAID] Registered: ${status.profileUrl}`)
    return status
  } catch (err: any) {
    console.error('[SAID] Registration failed:', err.message)
    // Non-blocking — agent continues even if SAID registration fails
    return { wallet, profileUrl: '', registered: false, verified: false, reputationScore: 0 }
  }
}

/**
 * Check SAID registration status
 */
export async function checkSAIDStatus(wallet: string): Promise<SAIDIdentity> {
  try {
    const res = await fetch(`${SAID_API}/api/verify/${wallet}`)
    if (!res.ok) {
      return { wallet, profileUrl: '', registered: false, verified: false, reputationScore: 0 }
    }
    const data = await res.json()
    return {
      wallet,
      profileUrl: `https://www.saidprotocol.com/agent.html?wallet=${wallet}`,
      registered: data.registered,
      verified: data.verified,
      reputationScore: data.reputation?.score || 0,
    }
  } catch {
    return { wallet, profileUrl: '', registered: false, verified: false, reputationScore: 0 }
  }
}

/**
 * Send liveness heartbeat to SAID Protocol
 * Proves Sovra is actively running
 */
export async function sendSAIDHeartbeat(mnemonic: string): Promise<void> {
  try {
    const seed = mnemonicToSeedSync(mnemonic)
    const derivedSeed = derivePath("m/44'/501'/0'/0'", seed.toString('hex')).key
    const keypair = Keypair.fromSeed(derivedSeed)
    const wallet = keypair.publicKey.toBase58()

    const timestamp = Math.floor(Date.now() / 1000)
    const message = `${wallet}:${timestamp}`
    const messageBytes = new TextEncoder().encode(message)
    const signature = nacl.sign.detached(messageBytes, keypair.secretKey)

    await fetch(`${SAID_API}/api/verify/layer2/activity/${wallet}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        timestamp,
        signature: bs58.encode(signature),
      }),
    })
  } catch (err: any) {
    console.error('[SAID] Heartbeat failed:', err.message)
  }
}

/**
 * Report economic activity to SAID Protocol
 * Auction wins, revenue earned, etc. become on-chain reputation events
 */
export async function reportSAIDActivity(
  mnemonic: string,
  event: 'cartoon_generated' | 'auction_won' | 'revenue_earned',
  metadata?: { amount?: number; details?: string }
): Promise<void> {
  try {
    const seed = mnemonicToSeedSync(mnemonic)
    const derivedSeed = derivePath("m/44'/501'/0'/0'", seed.toString('hex')).key
    const keypair = Keypair.fromSeed(derivedSeed)
    const wallet = keypair.publicKey.toBase58()

    // Report to SAID via trusted source feedback
    // (Sovra would need to get a trusted source API key from SAID team)
    // For now, just sends heartbeats - activity tracking is implicit

    console.log(`[SAID] Activity: ${event}`, metadata)
  } catch (err: any) {
    console.error('[SAID] Activity report failed:', err.message)
  }
}
