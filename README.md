# Spraay x402 Gateway

[![Live](https://img.shields.io/badge/status-live-brightgreen)](https://gateway.spraay.app)
[![Version](https://img.shields.io/badge/version-3.0.0-blue)](https://gateway.spraay.app)
[![x402](https://img.shields.io/badge/protocol-x402-orange)](https://x402.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Full-stack DeFi infrastructure for AI agents — 33 pay-per-use endpoints on Base.**

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
| `GET /api/v1/models` | List available AI models |
| `GET /api/v1/swap/tokens` | List supported swap tokens |
| `GET /api/v1/bridge/chains` | List supported bridge chains |

### AI ($0.001–$0.005)
| Endpoint | Method | Cost |
|----------|--------|------|
| `/api/v1/chat` | POST | $0.005 |
| `/api/v1/models/list` | GET | $0.001 |

### Payments ($0.001–$0.01)
| Endpoint | Method | Cost |
|----------|--------|------|
| `/api/v1/batch/execute` | POST | $0.01 |
| `/api/v1/batch/estimate` | POST | $0.001 |

### DeFi — Swap ($0.001–$0.01)
| Endpoint | Method | Cost |
|----------|--------|------|
| `/api/v1/swap/quote` | POST | $0.002 |
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
| `/api/v1/bridge/quote` | POST | $0.005 |

### Payroll ($0.001–$0.02)
| Endpoint | Method | Cost |
|----------|--------|------|
| `/api/v1/payroll/execute` | POST | $0.02 |
| `/api/v1/payroll/estimate` | POST | $0.002 |
| `/api/v1/payroll/tokens` | GET | $0.001 |

### Invoice ($0.001–$0.005)
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

### Escrow ($0.001–$0.008)
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

### Data ($0.001–$0.002)
| Endpoint | Method | Cost |
|----------|--------|------|
| `/api/v1/prices` | GET | $0.002 |
| `/api/v1/balances` | GET | $0.002 |
| `/api/v1/resolve` | GET | $0.001 |

---

## Tech Stack

- **Runtime**: Node.js / Express
- **Protocol**: x402 v2 with lifecycle hooks
- **Facilitator**: Coinbase CDP
- **Chain**: Base mainnet
- **Payment token**: USDC
- **Hosting**: Railway
- **Discovery**: Bazaar (`.well-known/x402.json`)

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `CDP_API_KEY_NAME` | Yes | Coinbase CDP API key name |
| `CDP_API_KEY_PRIVATE_KEY` | Yes | Coinbase CDP private key |
| `PAY_TO_ADDRESS` | Yes | Wallet to receive USDC payments |
| `PORT` | No | Server port (default: 8080) |

---

## Local Development

```bash
git clone https://github.com/plagtech/spraay-x402-gateway
cd spraay-x402-gateway
npm install
cp .env.example .env
# Fill in CDP credentials and PAY_TO_ADDRESS
npm start
```

---

## Related

- **MCP Server**: [github.com/plagtech/spraay-x402-mcp](https://github.com/plagtech/spraay-x402-mcp) — connect any AI agent via MCP
- **Spraay App**: [spraay.app](https://spraay.app) — batch payments UI
- **x402 Protocol**: [x402.org](https://x402.org)
- **Coinbase CDP**: [docs.cdp.coinbase.com](https://docs.cdp.coinbase.com)

## License

MIT
