# Spraay x402 Gateway

[![Live](https://img.shields.io/badge/status-live-brightgreen)](https://gateway.spraay.app)
[![Version](https://img.shields.io/badge/version-3.3.0-blue)](https://gateway.spraay.app)
[![Endpoints](https://img.shields.io/badge/endpoints-62%20paid%20+%205%20free-blueviolet)](https://gateway.spraay.app)
[![x402](https://img.shields.io/badge/protocol-x402-orange)](https://x402.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Full-stack DeFi infrastructure for AI agents — 62 pay-per-use endpoints on Base with dual-provider AI inference and persistent Supabase storage.**

The Spraay x402 Gateway is a payment-gated API server where every endpoint costs USDC micropayments via the [x402 protocol](https://x402.org). No API keys. No accounts. Agents pay per request and get data back instantly.

- **Gateway**: [gateway.spraay.app](https://gateway.spraay.app)
- **MCP Server**: [mcp.spraay.app](https://mcp.spraay.app) · [GitHub](https://github.com/plagtech/spraay-x402-mcp)
- **Bazaar Discovery**: [gateway.spraay.app/.well-known/x402.json](https://gateway.spraay.app/.well-known/x402.json)
- **Agent Card (A2A)**: [agent.spraay.app](https://agent.spraay.app/.well-known/agent-card.json)

---

## How It Works

1. Client sends request to a gateway endpoint
2. Gateway returns `402 Payment Required` with USDC amount + payment details
3. Client signs a USDC micropayment on Base mainnet
4. Gateway validates payment via Coinbase CDP facilitator
5. Gateway returns requested data

All payments settle on Base. Coinbase CDP handles facilitation. No API keys required on either side.

---

## AI Inference — Dual Provider

The gateway offers AI inference through two providers. Agents choose with a single `provider` parameter:

| Provider | Models | Auth | Payment |
|----------|--------|------|---------|
| **OpenRouter** (default) | 50+ models | API key (server-side) | Agent → Spraay (x402) |
| **BlockRun** | 43+ models | x402 wallet (no API key) | Agent → Spraay (x402) → BlockRun (x402) |

### Smart Routing

Set `model: "blockrun/auto"` with `provider: "blockrun"` to let ClawRouter pick the cheapest capable model automatically. Saves up to 78% on inference costs.

```json
{
  "model": "blockrun/auto",
  "messages": [{ "role": "user", "content": "What is x402?" }],
  "provider": "blockrun",
  "routing_profile": "auto"
}
```

**Routing profiles:** `free` (NVIDIA free models) · `eco` (budget optimized) · `auto` (balanced, default) · `premium` (best quality)

### Direct Model Call

```json
{
  "model": "deepseek/deepseek-chat",
  "messages": [{ "role": "user", "content": "Hello" }],
  "provider": "blockrun"
}
```

Omit `provider` to use OpenRouter (backward compatible).

---

## Endpoints

### Free Discovery
| Endpoint | Description |
|----------|-------------|
| `GET /.well-known/x402.json` | Bazaar discovery manifest |
| `GET /health` | Gateway health check |
| `GET /api/v1/info` | Gateway info and version |
| `GET /api/v1/tokens` | Supported tokens and chains |
| `GET /stats` | Gateway statistics |

### AI ($0.001–$0.04)
| Endpoint | Method | Cost | Notes |
|----------|--------|------|-------|
| `/api/v1/chat/completions` | POST | $0.04 | Dual-provider: OpenRouter (default) or BlockRun |
| `/api/v1/models` | GET | $0.001 | Returns models from both providers |

### Payments ($0.001–$0.01)
| Endpoint | Method | Cost |
|----------|--------|------|
| `/api/v1/batch/execute` | POST | $0.01 |
| `/api/v1/batch/estimate` | POST | $0.001 |

### DeFi — Swap ($0.001–$0.01)
| Endpoint | Method | Cost |
|----------|--------|------|
| `/api/v1/swap/quote` | GET | $0.002 |
| `/api/v1/swap/tokens` | GET | $0.001 |
| `/api/v1/swap/execute` | POST | $0.01 |

### Oracle ($0.001–$0.003)
| Endpoint | Method | Cost |
|----------|--------|------|
| `/api/v1/oracle/prices` | GET | $0.003 |
| `/api/v1/oracle/gas` | GET | $0.001 |
| `/api/v1/oracle/fx` | GET | $0.002 |

### Bridge ($0.001–$0.005)
| Endpoint | Method | Cost |
|----------|--------|------|
| `/api/v1/bridge/quote` | GET | $0.005 |
| `/api/v1/bridge/chains` | GET | $0.001 |

### Payroll ($0.001–$0.02)
| Endpoint | Method | Cost |
|----------|--------|------|
| `/api/v1/payroll/execute` | POST | $0.02 |
| `/api/v1/payroll/estimate` | POST | $0.002 |
| `/api/v1/payroll/tokens` | GET | $0.001 |

### Invoice ($0.001–$0.005) — Supabase persistent
| Endpoint | Method | Cost |
|----------|--------|------|
| `/api/v1/invoice/create` | POST | $0.005 |
| `/api/v1/invoice/list` | GET | $0.002 |
| `/api/v1/invoice/:id` | GET | $0.001 |

### Analytics ($0.003–$0.005)
| Endpoint | Method | Cost |
|----------|--------|------|
| `/api/v1/analytics/wallet` | GET | $0.005 |
| `/api/v1/analytics/txhistory` | GET | $0.003 |

### Escrow ($0.001–$0.008) — Supabase persistent
| Endpoint | Method | Cost |
|----------|--------|------|
| `/api/v1/escrow/create` | POST | $0.008 |
| `/api/v1/escrow/list` | GET | $0.002 |
| `/api/v1/escrow/:id` | GET | $0.001 |
| `/api/v1/escrow/fund` | POST | $0.002 |
| `/api/v1/escrow/release` | POST | $0.005 |
| `/api/v1/escrow/cancel` | POST | $0.002 |

### AI Inference ($0.008–$0.01)
| Endpoint | Method | Cost |
|----------|--------|------|
| `/api/v1/inference/classify-address` | POST | $0.008 |
| `/api/v1/inference/classify-tx` | POST | $0.008 |
| `/api/v1/inference/explain-contract` | POST | $0.01 |
| `/api/v1/inference/summarize` | POST | $0.008 |

### Communication — Email/SMS ($0.001–$0.005)
| Endpoint | Method | Cost | Status |
|----------|--------|------|--------|
| `/api/v1/notify/email` | POST | $0.003 | ✅ Live (AgentMail) |
| `/api/v1/notify/sms` | POST | $0.005 | ⏳ Simulated (Twilio pending) |
| `/api/v1/notify/status` | GET | $0.001 | ✅ Live |

### Communication — Webhook ($0.001–$0.003) — Supabase persistent
| Endpoint | Method | Cost |
|----------|--------|------|
| `/api/v1/webhook/register` | POST | $0.003 |
| `/api/v1/webhook/test` | POST | $0.002 |
| `/api/v1/webhook/list` | GET | $0.001 |
| `/api/v1/webhook/delete` | POST | $0.001 |

### Communication — XMTP ($0.002–$0.003)
| Endpoint | Method | Cost |
|----------|--------|------|
| `/api/v1/xmtp/send` | POST | $0.003 |
| `/api/v1/xmtp/inbox` | GET | $0.002 |

### Infrastructure — RPC ($0.001)
| Endpoint | Method | Cost |
|----------|--------|------|
| `/api/v1/rpc/call` | POST | $0.001 |
| `/api/v1/rpc/chains` | GET | $0.001 |

### Infrastructure — IPFS ($0.001–$0.005)
| Endpoint | Method | Cost |
|----------|--------|------|
| `/api/v1/storage/pin` | POST | $0.005 |
| `/api/v1/storage/get` | GET | $0.002 |
| `/api/v1/storage/status` | GET | $0.001 |

### Infrastructure — Cron/Scheduler ($0.001–$0.005) — Supabase persistent
| Endpoint | Method | Cost |
|----------|--------|------|
| `/api/v1/cron/create` | POST | $0.005 |
| `/api/v1/cron/list` | GET | $0.001 |
| `/api/v1/cron/cancel` | POST | $0.001 |

### Infrastructure — Logging ($0.001–$0.003) — Supabase persistent
| Endpoint | Method | Cost |
|----------|--------|------|
| `/api/v1/logs/ingest` | POST | $0.001 |
| `/api/v1/logs/query` | GET | $0.003 |

### Identity & Access — KYC ($0.005–$0.05) — Supabase persistent
| Endpoint | Method | Cost |
|----------|--------|------|
| `/api/v1/kyc/verify` | POST | $0.05 |
| `/api/v1/kyc/status` | GET | $0.005 |

### Identity & Access — Auth/SSO ($0.001–$0.005) — Supabase persistent
| Endpoint | Method | Cost |
|----------|--------|------|
| `/api/v1/auth/session` | POST | $0.005 |
| `/api/v1/auth/verify` | GET | $0.001 |

### Compliance — Audit Trail ($0.001–$0.005) — Supabase persistent
| Endpoint | Method | Cost |
|----------|--------|------|
| `/api/v1/audit/log` | POST | $0.001 |
| `/api/v1/audit/query` | GET | $0.005 |

### Compliance — Tax ($0.01–$0.02) — Supabase persistent
| Endpoint | Method | Cost |
|----------|--------|------|
| `/api/v1/tax/calculate` | POST | $0.01 |
| `/api/v1/tax/report` | GET | $0.02 |

### Data ($0.001–$0.002)
| Endpoint | Method | Cost |
|----------|--------|------|
| `/api/v1/prices` | GET | $0.002 |
| `/api/v1/balances` | GET | $0.002 |
| `/api/v1/resolve` | GET | $0.001 |

---

## Agent Registrations

| Registry | ID / Link |
|----------|-----------|
| **Dexter (ERC-8004)** | Agent #27567 |
| **Virtuals ACP** | Provider on [agdp.io](https://agdp.io) — batch payments as a service |
| **ERC-8004 Agents** | MangoSwap #26345, Spraay #26346 |
| **XMTP** | Agent Mango — inbound/outbound on Fly.io |
| **Bazaar** | [gateway.spraay.app/.well-known/x402.json](https://gateway.spraay.app/.well-known/x402.json) |
| **A2A** | [agent.spraay.app](https://agent.spraay.app/.well-known/agent-card.json) |

---

## Tech Stack

- **Runtime**: Node.js / Express / TypeScript
- **Protocol**: x402 with Bazaar discovery
- **Facilitator**: Coinbase CDP
- **Chain**: Base mainnet
- **Payment token**: USDC
- **AI Providers**: BlockRun (`@blockrun/llm` — x402 wallet auth), OpenRouter (API key)
- **Database**: Supabase (Postgres) — persistent storage for escrow, invoices, webhooks, cron, auth, KYC, audit, tax, logs
- **Hosting**: Railway
- **Real providers**: Alchemy (RPC across 7 chains), AgentMail (email), Pinata (IPFS), XMTP via Fly.io (messaging), LI.FI (bridge), OpenRouter (AI), BlockRun (AI)

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PAY_TO_ADDRESS` | Yes | Wallet to receive USDC payments |
| `X402_NETWORK` | Yes | `eip155:8453` for Base mainnet |
| `SUPABASE_URL` | Yes | Supabase project URL |
| `SUPABASE_KEY` | Yes | Supabase service_role key |
| `OPENROUTER_API_KEY` | Yes | OpenRouter API key for AI (default provider) |
| `BLOCKRUN_WALLET_KEY` | No | Private key for BlockRun x402 payments (enables dual-provider AI) |
| `BLOCKRUN_ENABLED` | No | Set to `"false"` to disable BlockRun (default: enabled if wallet key exists) |
| `ALCHEMY_API_KEY` | Yes | Alchemy API key for multi-chain RPC |
| `AGENTMAIL_API_KEY` | Yes | AgentMail API key for email |
| `AGENTMAIL_INBOX_ID` | Yes | AgentMail inbox ID |
| `PINATA_API_KEY` | Yes | Pinata API key for IPFS |
| `PINATA_API_SECRET` | Yes | Pinata API secret |
| `PORT` | No | Server port (default: 3402) |

---

## Local Development

```bash
git clone https://github.com/plagtech/spraay-x402-gateway
cd spraay-x402-gateway
npm install
cp .env.example .env
# Fill in all environment variables
npm start
```

---

## Ecosystem

**Merged PRs:**
- [coinbase/x402](https://github.com/coinbase/x402) — ecosystem listing
- [punkpeye/awesome-mcp-servers](https://github.com/punkpeye/awesome-mcp-servers)
- [Block Goose #7525](https://github.com/block/goose/pull/7525)

**Open PRs:**
- [Coinbase AgentKit #944](https://github.com/coinbase/agentkit/pull/944)
- [LangChain #557](https://github.com/langchain-ai/langchain/pull/557)
- [ElizaOS #274](https://github.com/elizaos/eliza/pull/274)
- [CrewAI #314](https://github.com/crewAIInc/crewAI/pull/314)
- [smolagents #1997](https://github.com/huggingface/smolagents/pull/1997)
- [BlockRun awesome-blockrun](https://github.com/BlockRunAI/awesome-blockrun/pulls)
- [BlockRun awesome-OpenClaw-Money-Maker](https://github.com/BlockRunAI/awesome-OpenClaw-Money-Maker/pulls)

---

## Related

- **MCP Server**: [github.com/plagtech/spraay-x402-mcp](https://github.com/plagtech/spraay-x402-mcp) — 60 tools, connect any AI agent via MCP
- **Spraay App**: [spraay.app](https://spraay.app) — batch payments UI on 11 chains
- **Spraay Base App**: [spraay-base-dapp.vercel.app](https://spraay-base-dapp.vercel.app) — Farcaster mini app + onramp
- **StablePay**: [stablepay.me](https://stablepay.me) — crypto payroll dashboard
- **MangoSwap**: [mangoswap.xyz](https://mangoswap.xyz) — DEX on Base
- **x402 Protocol**: [x402.org](https://x402.org)
- **BlockRun**: [blockrun.ai](https://blockrun.ai)

## License

MIT
