import { useState, useEffect, useCallback } from 'react'
import { usePrivy, useSendTransaction } from '@privy-io/react-auth'
import {
  createPublicClient,
  http,
  parseAbi,
  encodeFunctionData,
  formatUnits,
  formatEther,
  parseUnits,
  type Address,
} from 'viem'
import { base } from 'viem/chains'
import { config } from '../config'

const USDC_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
])

const AUCTION_ABI = parseAbi([
  'function placeBid(uint256 amount) external',
  'function updateBid(int256 amountChange) external',
  'function withdrawBid() external',
  'function getBid(address bidder) view returns (uint256 amount, uint64 createdAt, uint64 updatedAt, bool active)',
])

interface ActiveBid {
  amount: number
  requestText: string
  active: boolean
}

const publicClient = createPublicClient({
  chain: base,
  transport: http(config.base.rpcUrl),
})

const MIN_ETH_FOR_GAS = 0.0001

export function useBaseBid() {
  const { user } = usePrivy()
  const { sendTransaction } = useSendTransaction()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [txSig, setTxSig] = useState<string | null>(null)
  const [activeBid, setActiveBid] = useState<ActiveBid | null>(null)
  const [usdcBalance, setUsdcBalance] = useState<number | null>(null)
  const [ethBalance, setEthBalance] = useState<number | null>(null)

  const walletAddress = (user?.linkedAccounts?.find(
    (a) => a.type === 'wallet' && (a as any).chainType === 'ethereum',
  ) as { address: string } | undefined)?.address as Address | undefined

  const needsGas = ethBalance !== null && ethBalance < MIN_ETH_FOR_GAS

  const loadActiveBid = useCallback(async () => {
    if (!walletAddress || !config.base.auctionAddress) { setActiveBid(null); return }

    try {
      const [amount, , , active] = await publicClient.readContract({
        address: config.base.auctionAddress as Address,
        abi: AUCTION_ABI,
        functionName: 'getBid',
        args: [walletAddress],
      })

      if (active && amount > 0n) {
        let requestText = ''
        try {
          const res = await fetch(`/api/auction/request/${walletAddress}`)
          const reqData = await res.json()
          requestText = reqData.requestText ?? ''
        } catch {}
        setActiveBid({
          amount: Number(formatUnits(amount, config.base.usdcDecimals)),
          requestText,
          active: true,
        })
      } else {
        setActiveBid(null)
      }
    } catch {
      setActiveBid(null)
    }
  }, [walletAddress])

  const loadBalance = useCallback(async () => {
    if (!walletAddress) { setUsdcBalance(null); setEthBalance(null); return }

    try {
      const [usdcBal, ethBal] = await Promise.all([
        publicClient.readContract({
          address: config.base.usdcAddress,
          abi: USDC_ABI,
          functionName: 'balanceOf',
          args: [walletAddress],
        }),
        publicClient.getBalance({ address: walletAddress }),
      ])
      setUsdcBalance(Number(formatUnits(usdcBal, config.base.usdcDecimals)))
      setEthBalance(Number(formatEther(ethBal)))
    } catch {
      setUsdcBalance(0)
      setEthBalance(0)
    }
  }, [walletAddress])

  useEffect(() => {
    loadActiveBid()
    loadBalance()
    const interval = setInterval(() => { loadActiveBid(); loadBalance() }, 15_000)
    return () => clearInterval(interval)
  }, [loadActiveBid, loadBalance])

  async function sendTx(to: string, data: `0x${string}`, waitForConfirmation = false): Promise<string> {
    const receipt = await sendTransaction({ to, data, chainId: config.base.chainId })
    if (waitForConfirmation) {
      await publicClient.waitForTransactionReceipt({ hash: receipt.hash as `0x${string}` })
    }
    return receipt.hash
  }

  async function ensureAllowance(amount: bigint): Promise<void> {
    if (!walletAddress) throw new Error('No EVM wallet found')

    const allowance = await publicClient.readContract({
      address: config.base.usdcAddress,
      abi: USDC_ABI,
      functionName: 'allowance',
      args: [walletAddress, config.base.auctionAddress as Address],
    })

    if (allowance >= amount) return

    const approveData = encodeFunctionData({
      abi: USDC_ABI,
      functionName: 'approve',
      args: [config.base.auctionAddress as Address, amount * 100n],
    })

    await sendTx(config.base.usdcAddress, approveData, true)
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
    if (!walletAddress) {
      setError('No EVM wallet found. Sign in first.')
      return
    }

    setLoading(true)
    setError(null)
    setTxSig(null)

    try {
      const amountRaw = parseUnits(String(amountUsdc), config.base.usdcDecimals)

      await ensureAllowance(amountRaw)

      const data = encodeFunctionData({
        abi: AUCTION_ABI,
        functionName: 'placeBid',
        args: [amountRaw],
      })

      const hash = await sendTx(config.base.auctionAddress, data)
      setTxSig(hash)

      await fetch('/api/auction/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bidder: walletAddress, requestText }),
      })

      await loadActiveBid()
    } catch (err) {
      const msg = (err as Error).message
      if (msg.includes('User rejected') || msg.includes('user rejected')) setError('Transaction cancelled.')
      else setError(msg)
    } finally {
      setLoading(false)
    }
  }

  async function updateBid(newRequestText: string, amountChangeUsdc: number) {
    if (!walletAddress) {
      setError('No EVM wallet found.')
      return
    }

    setLoading(true)
    setError(null)

    try {
      if (amountChangeUsdc === 0) {
        await fetch('/api/auction/request', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ bidder: walletAddress, requestText: newRequestText }),
        })
        setTxSig('text-only-update')
        await loadActiveBid()
        return
      }

      const amountChangeRaw = parseUnits(String(Math.abs(amountChangeUsdc)), config.base.usdcDecimals)
      const signedChange = amountChangeUsdc >= 0 ? amountChangeRaw : -amountChangeRaw

      if (amountChangeUsdc > 0) {
        await ensureAllowance(amountChangeRaw)
      }

      const data = encodeFunctionData({
        abi: AUCTION_ABI,
        functionName: 'updateBid',
        args: [signedChange],
      })

      const hash = await sendTx(config.base.auctionAddress, data)
      setTxSig(hash)

      await fetch('/api/auction/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bidder: walletAddress, requestText: newRequestText }),
      })

      await loadActiveBid()
    } catch (err) {
      const msg = (err as Error).message
      if (msg.includes('User rejected') || msg.includes('user rejected')) setError('Transaction cancelled.')
      else setError(msg)
    } finally {
      setLoading(false)
    }
  }

  async function withdrawBid() {
    if (!walletAddress) {
      setError('No EVM wallet found.')
      return
    }

    setLoading(true)
    setError(null)

    try {
      const data = encodeFunctionData({
        abi: AUCTION_ABI,
        functionName: 'withdrawBid',
      })

      const hash = await sendTx(config.base.auctionAddress, data)
      setTxSig(hash)
      setActiveBid(null)
    } catch (err) {
      const msg = (err as Error).message
      if (msg.includes('User rejected') || msg.includes('user rejected')) setError('Transaction cancelled.')
      else setError(msg)
    } finally {
      setLoading(false)
    }
  }

  return {
    placeBid,
    updateBid,
    withdrawBid,
    loading,
    error,
    txSig,
    activeBid,
    usdcBalance,
    ethBalance,
    needsGas,
    walletAddress: walletAddress ?? null,
  }
}
