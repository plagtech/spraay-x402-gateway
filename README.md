# Spraay x402 Gateway

[![Live](https://img.shields.io/badge/status-live-brightgreen)](https://gateway.spraay.app)
[![Version](https://img.shields.io/badge/version-3.2.0-blue)](https://gateway.spraay.app)
[![Tools](https://img.shields.io/badge/tools-57%20(56%20active)-blueviolet)](https://gateway.spraay.app)
[![x402](https://img.shields.io/badge/protocol-x402-orange)](https://x402.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Full-stack DeFi infrastructure for AI agents — 57 pay-per-use endpoints (56 active) on Base with persistent Supabase storage.**

The Spraay x402 Gateway is a payment-gated API server where every endpoint costs USDC micropayments via the [x402 protocol](https://x402.org). No API keys. No accounts. Agents pay per request and get data back instantly.

- **Gateway**: [gateway.spraay.app](https://gateway.spraay.app)
- **MCP Server**: [mcp.spraay.app](https://mcp.spraay.app)
- **Bazaar Discovery**: [gateway.spraay.app/.well-known/x402.json](https://gateway.spraay.app/.well-known/x402.json)

---

## How It Works

1. Client sends request to a gateway endpoint
2. Gateway returns `402 Payment Required` with USDC amount + payment details
3. Client signs a USDC micropayment on Base mainnet
4. Gateway validates payment via Coinbase CDP facilitator
5. Gateway returns requested data

All payments settle on Base. Coinbase CDP handles facilitation. No API keys required on either side.

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

### AI ($0.001–$0.005)
| Endpoint | Method | Cost |
|----------|--------|------|
| `/api/v1/chat/completions` | POST | $0.005 |
| `/api/v1/models` | GET | $0.001 |

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
| `/api/v1/notify/sms` | POST | $0.005 | ⏳ Simulated (Twilio later) |
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

### Infrastructure — IPFS/Arweave ($0.001–$0.005)
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

## Tech Stack

- **Runtime**: Node.js / Express / TypeScript
- **Protocol**: x402 with Bazaar discovery
- **Facilitator**: Coinbase CDP
- **Chain**: Base mainnet
- **Payment token**: USDC
- **Database**: Supabase (Postgres) — persistent storage for escrow, invoices, webhooks, cron, auth, KYC, audit, tax, logs
- **Hosting**: Railway
- **Real providers**: Alchemy (RPC), AgentMail (email), Pinata (IPFS), XMTP (Fly.io), LI.FI (bridge), OpenRouter (AI)

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PAY_TO_ADDRESS` | Yes | Wallet to receive USDC payments |
| `X402_NETWORK` | Yes | `eip155:8453` for Base mainnet |
| `SUPABASE_URL` | Yes | Supabase project URL |
| `SUPABASE_KEY` | Yes | Supabase service_role key |
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

## Related

- **MCP Server**: [github.com/plagtech/spraay-x402-mcp](https://github.com/plagtech/spraay-x402-mcp) — connect any AI agent via MCP
- **Spraay App**: [spraay.app](https://spraay.app) — batch payments UI on 11 chains
- **StablePay**: [stablepay.me](https://stablepay.me) — crypto payroll dashboard
- **x402 Protocol**: [x402.org](https://x402.org)
- **Coinbase CDP**: [docs.cdp.coinbase.com](https://docs.cdp.coinbase.com)

## License

MIT
