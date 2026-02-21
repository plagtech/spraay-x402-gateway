# 🥭 Spraay x402 Gateway

**Earn USDC 24/7 by selling AI model access, batch payments, and DeFi data to autonomous agents on Base.**

Built on the [x402 protocol](https://x402.org) — agents discover your endpoints via the Bazaar, pay USDC per request, and get instant results. No API keys, no accounts, no human in the loop.

## 💰 Revenue Streams

| Endpoint | Price | What It Does |
|----------|-------|-------------|
| `POST /api/v1/chat/completions` | $0.005/req | AI chat via 200+ models (OpenAI-compatible) |
| `GET /api/v1/models` | $0.001/req | List available AI models |
| `POST /api/v1/batch/execute` | $0.01/req | Batch USDC payments via Spraay |
| `POST /api/v1/batch/estimate` | $0.001/req | Estimate batch payment costs |
| `GET /api/v1/swap/quote` | $0.002/req | Swap quotes via MangoSwap routing |
| `GET /api/v1/swap/tokens` | $0.001/req | List tradeable tokens on Base |

**Revenue math**: An agent making 1,000 AI requests/day = $5/day = $150/month from just ONE customer. The Bazaar brings customers to you automatically.

## 🚀 Quick Start

### 1. Clone & Install

```bash
git clone https://github.com/plagtech/spraay-x402-gateway.git
cd spraay-x402-gateway
npm install
```

### 2. Configure

```bash
cp .env.example .env
```

Edit `.env`:
```
PAY_TO_ADDRESS=0xYourBaseWalletAddress    # Where you receive USDC
OPENROUTER_API_KEY=sk-or-v1-xxx          # Get one at openrouter.ai
X402_NETWORK=eip155:84532                 # testnet (change to eip155:8453 for mainnet)
X402_FACILITATOR_URL=https://www.x402.org/facilitator
```

### 3. Run (Testnet)

```bash
npx ts-node src/index.ts
```

You should see:
```
🥭 Spraay x402 Gateway running on port 3402
📡 Network: eip155:84532
💰 Payments to: 0xYour...
🔗 Facilitator: https://www.x402.org/facilitator
🌐 Endpoints ready for agent discovery via x402 Bazaar
```

### 4. Test It

Visit `http://localhost:3402` to see the API info page.

An x402-enabled agent/client would:
1. Call your endpoint
2. Get back HTTP 402 with payment requirements
3. Pay USDC on Base
4. Retry the request with payment proof
5. Get the response

### 5. Go to Mainnet 🔥

When ready for real money, just change two values in `.env`:

```
X402_NETWORK=eip155:8453
X402_FACILITATOR_URL=https://api.cdp.coinbase.com/platform/v2/x402
```

That's it. Your endpoints are now accepting real USDC on Base mainnet.

## 🌐 Bazaar Discovery

The x402 Bazaar is how agents find your services automatically. When using the CDP facilitator on mainnet, your endpoints are indexed and discoverable.

Agents query the Bazaar like this:
```typescript
const response = await client.extensions.discovery.listResources({ type: "http" });
// Your endpoints appear in the results with pricing, descriptions, and schemas
```

## 📁 Project Structure

```
spraay-x402-gateway/
├── src/
│   ├── index.ts                 # Main server + x402 middleware config
│   └── routes/
│       ├── ai-gateway.ts        # AI model proxy (OpenRouter)
│       ├── batch-payments.ts    # Spraay batch payment endpoints
│       ├── swap-data.ts         # MangoSwap quote/token endpoints
│       └── health.ts            # Health check + stats tracking
├── .env.example                 # Environment template
├── package.json
├── tsconfig.json
└── README.md
```

## 🔧 Deployment

### Railway (Recommended)
```bash
# Install Railway CLI
npm i -g @railway/cli

# Deploy
railway login
railway init
railway up
```

### Docker
```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npx tsc
CMD ["node", "dist/index.js"]
```

### Vercel (Serverless)
Works with Next.js middleware variant — see `@x402/next` package.

## 🛠️ Production Checklist

- [ ] Set `X402_NETWORK=eip155:8453` (Base mainnet)
- [ ] Set `X402_FACILITATOR_URL=https://api.cdp.coinbase.com/platform/v2/x402`
- [ ] Add your real `PAY_TO_ADDRESS` (wallet you control)
- [ ] Add `OPENROUTER_API_KEY` with credits loaded
- [ ] Connect Spraay contract for real batch payment execution
- [ ] Connect MangoSwap router for live swap quotes
- [ ] Add Redis for persistent stats tracking
- [ ] Set up monitoring/alerting
- [ ] Deploy to always-on server (Railway, Render, VPS)

## 🔗 Related Projects

- [Spraay](https://spraay-base-dapp.vercel.app) — Multi-chain batch payment protocol
- [MangoSwap](https://mangoswap.xyz) — DEX on Base (Uniswap V3 + Aerodrome routing)
- [x402 Protocol](https://x402.org) — Internet-native payment standard
- [x402 Bazaar](https://x402.gitbook.io/x402/core-concepts/bazaar-discovery-layer) — Service discovery for agents
- **[Spraay x402 MCP Server](https://github.com/plagtech/spraay-x402-mcp)** — MCP server wrapping all 9 gateway endpoints. Compatible with Claude Desktop, Cursor, and any MCP client.

## 📊 How the Money Flows

```
Agent discovers your endpoint via Bazaar
    ↓
Agent calls POST /api/v1/chat/completions
    ↓
x402 middleware returns HTTP 402 + payment requirements
    ↓
Agent pays $0.005 USDC to your wallet on Base
    ↓
Agent retries request with payment proof
    ↓
x402 facilitator verifies payment (settled on Base)
    ↓
Your handler proxies to OpenRouter (costs ~$0.002)
    ↓
Response returned to agent
    ↓
You profit $0.003 per request 💰
```

Built by [@lostpoet](https://twitter.com/lostpoet) | Base Builder | 2026
