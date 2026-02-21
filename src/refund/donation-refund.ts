/**
 * One-time donation refund — returning unsolicited USDC to its originators.
 *
 * Context: A third party deployed an ERC-20 token ("Sovra Fund") on Base
 * without authorization from Sovra or its creators. The token contract
 * (0x6b6F…5b) collects a 3% buy/sell tax and forwards the proceeds as
 * USDC to this agent's wallet (0x150E…0f). Sovra did not create, endorse,
 * or request this token. We do not want the funds.
 *
 * This module traces every on-chain swap that contributed to those tax
 * proceeds, identifies each wallet that paid fees, calculates their
 * proportional share of the total USDC received, and batch-refunds them
 * via Disperse.app.
 *
 * It runs once on startup. The completed state is persisted to a JSON
 * file (backed up to Postgres) so restarts never re-execute the refund.
 * Batch-level progress is saved after each successful batch to prevent
 * double-sends if the process crashes mid-execution.
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  parseAbiItem,
  erc20Abi,
  decodeEventLog,
  formatUnits,
  type Address,
  zeroAddress,
} from 'viem'
import { base } from 'viem/chains'
import { mnemonicToAccount } from 'viem/accounts'
import { join } from 'path'
import { existsSync } from 'fs'
import { EventBus } from '../console/events.js'
import { JsonStore } from '../store/json-store.js'

// --- Constants ---

/** The unauthorized token contract that sends tax proceeds to this agent. */
const DONATION_TOKEN = '0x6b6F165d098b30088C0C92F5981f9da0B6214b5b' as Address
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address
const UNISWAP_ROUTER = '0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24' as Address
/** Disperse.app — batch ERC-20 transfer contract, deployed on Base. */
const DISPERSE = '0xD152f549545093347A162Dce210e7293f1452150' as Address

const TRANSFER_EVENT = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
)

const disperseAbi = parseAbi([
  'function disperseToken(address token, address[] recipients, uint256[] values)',
])

const LOG_CHUNK_SIZE = 10_000n

// --- Types ---
interface RefundRecipient {
  address: string
  taxTokens: string
  sharePercent: number
  usdcAmount: string
  usdcAmountRaw: string
}

interface RefundState {
  completed: boolean
  reason: string
  approvalTxHash: string | null
  disperseTxHashes: string[]
  batchCount: number
  /** Index into recipients array — batches before this are already sent. */
  completedRecipientIndex: number
  timestamp: number
  blockNumber: number
  totalRefundedUsdc: string
  recipientCount: number
  recipients: RefundRecipient[]
}

// --- Helpers ---

/**
 * Query Transfer event logs in chunks. Throws if any chunk fails —
 * we cannot tolerate partial data for a financial operation.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getLogsChunked(
  client: any,
  address: Address,
  args: Record<string, Address>,
  fromBlock: bigint,
  toBlock: bigint,
) {
  const all: any[] = []
  for (let start = fromBlock; start <= toBlock; start += LOG_CHUNK_SIZE) {
    const end = start + LOG_CHUNK_SIZE - 1n > toBlock ? toBlock : start + LOG_CHUNK_SIZE - 1n
    try {
      const logs = await client.getLogs({
        address,
        event: TRANSFER_EVENT,
        args,
        fromBlock: start,
        toBlock: end,
      })
      all.push(...logs)
    } catch {
      // Retry with smaller chunks — but if ANY sub-chunk fails, throw
      const small = 2_000n
      for (let s = start; s <= end; s += small) {
        const e = s + small - 1n > end ? end : s + small - 1n
        const logs = await client.getLogs({
          address,
          event: TRANSFER_EVENT,
          args,
          fromBlock: s,
          toBlock: e,
        })
        all.push(...logs)
      }
    }
  }
  return all
}

// --- Main ---
export async function refundDonationProceeds(
  events: EventBus,
  rpcUrl: string,
  mnemonic: string,
  dataDir: string,
): Promise<void> {
  const statePath = join(dataDir, 'donation-refund-state.json')
  const stateStore = new JsonStore<RefundState>(statePath)

  // Robust idempotency: distinguish "file missing" from "file corrupt"
  if (existsSync(statePath)) {
    const existing = await stateStore.read()
    if (existing === null) {
      // File exists but failed to parse — do NOT proceed, could double-send
      throw new Error(
        `Refund state file exists at ${statePath} but could not be read. ` +
        `Refusing to proceed to avoid potential double-send. Check the file manually.`,
      )
    }
    if (existing.completed) {
      events.monologue(
        `[Refund] Already completed on ${new Date(existing.timestamp).toISOString()} ` +
        `| ${existing.batchCount} batch(es) | ${existing.totalRefundedUsdc} USDC to ${existing.recipientCount} wallets`,
      )
      return
    }
    // Partial state exists — we'll resume from completedRecipientIndex below
    events.monologue(
      `[Refund] Found partial state — ${existing.completedRecipientIndex} recipients already refunded, resuming...`,
    )
  }

  const account = mnemonicToAccount(mnemonic)
  const agentAddress = account.address

  events.monologue(`[Refund] Checking for unsolicited token-tax USDC to return...`)
  events.monologue(`[Refund] Agent: ${agentAddress} | Token contract: ${DONATION_TOKEN}`)

  const publicClient = createPublicClient({ chain: base, transport: http(rpcUrl) })
  const walletClient = createWalletClient({ account, chain: base, transport: http(rpcUrl) })

  const currentBlock = await publicClient.getBlockNumber()
  const searchFrom = currentBlock > 500_000n ? currentBlock - 500_000n : 0n

  // ── 1. Total USDC received from the token contract ──
  const usdcInLogs = await getLogsChunked(publicClient, USDC, { from: DONATION_TOKEN, to: agentAddress }, searchFrom, currentBlock)
  const totalUsdcReceived = usdcInLogs.reduce((s: bigint, l: any) => s + (l.args.value ?? 0n), 0n)

  if (totalUsdcReceived === 0n) {
    events.monologue('[Refund] No USDC received from token contract — nothing to return')
    return
  }

  events.monologue(`[Refund] USDC received from token contract: ${formatUnits(totalUsdcReceived, 6)}`)

  // ── 2. Check balances ──
  const usdcBalance = await publicClient.readContract({
    address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [agentAddress],
  })
  const ethBalance = await publicClient.getBalance({ address: agentAddress })

  events.monologue(`[Refund] USDC balance: ${formatUnits(usdcBalance, 6)} | ETH: ${formatUnits(ethBalance, 18)}`)

  if (usdcBalance === 0n) {
    events.monologue('[Refund] USDC balance is 0 — cannot refund')
    return
  }

  if (ethBalance === 0n) {
    throw new Error('Agent has 0 ETH on Base — cannot pay gas for refund transactions')
  }

  // ── 3. Find the Uniswap pair for the token ──
  const routerAbi = parseAbi(['function factory() view returns (address)', 'function WETH() view returns (address)'])
  const factoryAbi = parseAbi(['function getPair(address, address) view returns (address)'])

  const [factoryAddr, weth] = await Promise.all([
    publicClient.readContract({ address: UNISWAP_ROUTER, abi: routerAbi, functionName: 'factory' }),
    publicClient.readContract({ address: UNISWAP_ROUTER, abi: routerAbi, functionName: 'WETH' }),
  ])
  const pair = await publicClient.readContract({
    address: factoryAddr as Address, abi: factoryAbi, functionName: 'getPair', args: [DONATION_TOKEN, weth as Address],
  }) as Address

  events.monologue(`[Refund] Uniswap pair: ${pair}`)

  // ── 4. Index all tax-deduction Transfer events ──
  const taxLogs = await getLogsChunked(publicClient, DONATION_TOKEN, { to: DONATION_TOKEN }, searchFrom, currentBlock)
  const taxEvents = taxLogs.filter((l: any) => l.args.from !== zeroAddress)

  events.monologue(`[Refund] Found ${taxEvents.length} tax events — attributing to traders...`)

  // ── 5. Attribute each tax event to the trader who paid it ──
  const traderTax = new Map<string, bigint>()
  let totalTaxTokens = 0n
  let receiptErrors = 0

  for (const log of taxEvents) {
    const from = (log.args.from as string).toLowerCase()
    const value = log.args.value as bigint

    if (from === pair.toLowerCase()) {
      // Buy tax — tax tokens originate from the pair. The actual buyer is
      // identified by finding the other Transfer in the same tx where the
      // pair sends tokens to a non-contract address.
      const receipt = await publicClient.getTransactionReceipt({ hash: log.transactionHash })
      let buyer: string | null = null

      for (const rl of receipt.logs) {
        if (rl.address.toLowerCase() !== DONATION_TOKEN.toLowerCase()) continue
        if (!rl.topics || rl.topics.length < 3) continue
        try {
          const decoded = decodeEventLog({
            abi: [TRANSFER_EVENT],
            data: rl.data,
            topics: rl.topics as [`0x${string}`, ...`0x${string}`[]],
          })
          const dFrom = (decoded.args.from as string).toLowerCase()
          const dTo = (decoded.args.to as string).toLowerCase()
          if (dFrom === pair.toLowerCase() && dTo !== DONATION_TOKEN.toLowerCase() && dTo !== UNISWAP_ROUTER.toLowerCase() && dTo !== zeroAddress.toLowerCase()) {
            buyer = dTo
            break
          }
        } catch {
          // Non-Transfer log topic — safe to skip
        }
      }

      if (buyer) {
        traderTax.set(buyer, (traderTax.get(buyer) ?? 0n) + value)
        totalTaxTokens += value
      } else {
        receiptErrors++
        events.monologue(`[Refund] WARNING: Could not identify buyer in tx ${log.transactionHash}`)
      }
    } else if (from !== DONATION_TOKEN.toLowerCase() && from !== UNISWAP_ROUTER.toLowerCase() && from !== pair.toLowerCase()) {
      // Sell tax — `from` is the seller directly
      traderTax.set(from, (traderTax.get(from) ?? 0n) + value)
      totalTaxTokens += value
    }
  }

  if (receiptErrors > 0) {
    events.monologue(`[Refund] ${receiptErrors} buy-tax events could not be attributed — those shares will remain in wallet`)
  }

  if (totalTaxTokens === 0n || traderTax.size === 0) {
    events.monologue('[Refund] No attributable tax found — cannot distribute')
    return
  }

  events.monologue(`[Refund] ${traderTax.size} unique traders identified`)

  // ── 6. Calculate proportional USDC refunds ──
  // refundableUsdc is capped at the amount actually received from the token contract,
  // never exceeding the wallet's current balance. Integer division ensures the sum of
  // all individual amounts (totalToDisperse) is <= refundableUsdc.
  const refundableUsdc = totalUsdcReceived > usdcBalance ? usdcBalance : totalUsdcReceived

  const recipients: Address[] = []
  const amounts: bigint[] = []
  const refundDetails: RefundRecipient[] = []

  for (const [trader, tax] of traderTax) {
    const amount = (tax * refundableUsdc) / totalTaxTokens
    if (amount === 0n) continue

    recipients.push(trader as Address)
    amounts.push(amount)
    refundDetails.push({
      address: trader,
      taxTokens: tax.toString(),
      sharePercent: Number((tax * 10000n) / totalTaxTokens) / 100,
      usdcAmount: formatUnits(amount, 6),
      usdcAmountRaw: amount.toString(),
    })
  }

  const totalToDisperse = amounts.reduce((a, b) => a + b, 0n)

  events.monologue(
    `[Refund] Plan: return ${formatUnits(totalToDisperse, 6)} USDC to ${recipients.length} wallets via Disperse.app`,
  )

  // ── 7. Approve Disperse to spend the full USDC amount ──
  const currentAllowance = await publicClient.readContract({
    address: USDC, abi: erc20Abi, functionName: 'allowance', args: [agentAddress, DISPERSE],
  })

  let approvalTxHash: string | null = null

  if (currentAllowance < totalToDisperse) {
    events.monologue(`[Refund] Approving Disperse for ${formatUnits(totalToDisperse, 6)} USDC...`)

    const hash = await walletClient.writeContract({
      address: USDC,
      abi: erc20Abi,
      functionName: 'approve',
      args: [DISPERSE, totalToDisperse],
    })
    const receipt = await publicClient.waitForTransactionReceipt({ hash })
    approvalTxHash = hash

    if (receipt.status !== 'success') {
      throw new Error(`USDC approval reverted — TX: ${hash}`)
    }

    events.monologue(`[Refund] USDC approved — TX: ${hash}`)
  }

  // ── 8. Determine batch size via simulation ──
  const BATCH_SIZES = [recipients.length, 200, 100, 50] as const
  let batchSize = recipients.length

  for (const size of BATCH_SIZES) {
    const testRecipients = recipients.slice(0, Math.min(size, recipients.length))
    const testAmounts = amounts.slice(0, Math.min(size, amounts.length))

    try {
      await publicClient.simulateContract({
        account,
        address: DISPERSE,
        abi: disperseAbi,
        functionName: 'disperseToken',
        args: [USDC, testRecipients, testAmounts],
      })
      batchSize = size
      break
    } catch (err) {
      if (size === recipients.length) {
        events.monologue(`[Refund] Full batch (${recipients.length}) simulation failed — trying smaller batches...`)
      } else {
        events.monologue(`[Refund] Batch size ${size} simulation failed: ${(err as Error).message}`)
      }
      if (size === BATCH_SIZES[BATCH_SIZES.length - 1]) {
        throw new Error(`All batch sizes failed simulation — cannot proceed`)
      }
    }
  }

  const totalBatches = Math.ceil(recipients.length / batchSize)
  events.monologue(
    `[Refund] Batch size: ${batchSize} (${totalBatches} batch${totalBatches > 1 ? 'es' : ''})`,
  )

  // ── 9. Load partial progress (if resuming after crash) ──
  const partialState = await stateStore.read()
  const startFromIndex = partialState?.completedRecipientIndex ?? 0
  const disperseTxHashes = partialState?.disperseTxHashes ?? []

  if (startFromIndex > 0) {
    events.monologue(`[Refund] Resuming from recipient index ${startFromIndex} (${startFromIndex} already sent)`)
  }

  // ── 10. Simulate each batch, then execute — save progress after each ──
  let lastBlockNumber = 0n

  for (let i = startFromIndex; i < recipients.length; i += batchSize) {
    const batchRecipients = recipients.slice(i, i + batchSize)
    const batchAmounts = amounts.slice(i, i + batchSize)
    const batchNum = Math.floor(i / batchSize) + 1
    const batchUsdc = batchAmounts.reduce((a, b) => a + b, 0n)

    // Simulate this specific batch before executing
    events.monologue(`[Refund] Simulating batch ${batchNum}/${totalBatches}...`)
    try {
      await publicClient.simulateContract({
        account,
        address: DISPERSE,
        abi: disperseAbi,
        functionName: 'disperseToken',
        args: [USDC, batchRecipients, batchAmounts],
      })
    } catch (err) {
      throw new Error(
        `Batch ${batchNum} simulation failed — halting to protect funds. ` +
        `${disperseTxHashes.length} batch(es) already sent. Error: ${(err as Error).message}`,
      )
    }

    events.monologue(
      `[Refund] Executing batch ${batchNum}/${totalBatches} — ${batchRecipients.length} recipients, ${formatUnits(batchUsdc, 6)} USDC`,
    )

    const hash = await walletClient.writeContract({
      address: DISPERSE,
      abi: disperseAbi,
      functionName: 'disperseToken',
      args: [USDC, batchRecipients, batchAmounts],
    })

    const receipt = await publicClient.waitForTransactionReceipt({ hash })

    if (receipt.status !== 'success') {
      throw new Error(
        `Batch ${batchNum} reverted on-chain — TX: ${hash}. ` +
        `${disperseTxHashes.length} batch(es) already sent.`,
      )
    }

    disperseTxHashes.push(hash)
    lastBlockNumber = receipt.blockNumber
    events.monologue(`[Refund] Batch ${batchNum} confirmed — TX: ${hash}`)

    // Persist progress after every batch so restarts skip already-sent batches
    await stateStore.write({
      completed: false,
      reason: 'Returning unsolicited USDC from unauthorized third-party token "Sovra Fund" (0x6b6F…5b). Sovra did not create or endorse this token.',
      approvalTxHash,
      disperseTxHashes,
      batchCount: totalBatches,
      completedRecipientIndex: i + batchRecipients.length,
      timestamp: Date.now(),
      blockNumber: Number(lastBlockNumber),
      totalRefundedUsdc: formatUnits(totalToDisperse, 6),
      recipientCount: recipients.length,
      recipients: refundDetails,
    })
  }

  // ── 11. Mark fully complete ──
  await stateStore.write({
    completed: true,
    reason: 'Returning unsolicited USDC from unauthorized third-party token "Sovra Fund" (0x6b6F…5b). Sovra did not create or endorse this token.',
    approvalTxHash,
    disperseTxHashes,
    batchCount: totalBatches,
    completedRecipientIndex: recipients.length,
    timestamp: Date.now(),
    blockNumber: Number(lastBlockNumber),
    totalRefundedUsdc: formatUnits(totalToDisperse, 6),
    recipientCount: recipients.length,
    recipients: refundDetails,
  })

  events.monologue(
    `[Refund] COMPLETE — ${formatUnits(totalToDisperse, 6)} USDC returned to ${recipients.length} wallets in ${totalBatches} batch(es)`,
  )
}
