import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { PrivyProvider } from '@privy-io/react-auth'
import { base } from 'viem/chains'
import { createSolanaRpc, createSolanaRpcSubscriptions } from '@solana/kit'
import './index.css'
import App from './App'
import { config } from './config'

const solanaRpcUrl = config.solana.rpcUrl
const solanaWssUrl = solanaRpcUrl.replace('https://', 'wss://')
const rpc = createSolanaRpc(solanaRpcUrl) as never
const rpcSubs = createSolanaRpcSubscriptions(solanaWssUrl) as never

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PrivyProvider
      appId={config.privy.appId}
      config={{
        appearance: {
          theme: 'light',
          accentColor: '#c23616',
        },
        embeddedWallets: {
          solana: { createOnLogin: 'all-users' },
          ethereum: { createOnLogin: 'all-users' },
          showWalletUIs: false,
        },
        supportedChains: [base],
        solana: {
          rpcs: {
            'solana:mainnet': { rpc, rpcSubscriptions: rpcSubs },
          },
        },
      }}
    >
      <App />
    </PrivyProvider>
  </StrictMode>,
)
