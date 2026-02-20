# 💧 Spraay — Multi-Chain Batch Crypto Payments

Send crypto to 200+ recipients in a single transaction. Deployed on **Base** and **Plasma**.

🔗 [spraay.app](https://spraay.app) | [Plasma](https://spraay.app/plasma) | [Bittensor](https://spraay.app/tao)

---

## Deployed Contracts

| Chain | Contract | Explorer | Status |
|-------|----------|----------|--------|
| Base | `0x1646452F98E36A3c9Cfc3eDD8868221E207B5eEC` | [BaseScan](https://basescan.org/address/0x1646452F98E36A3c9Cfc3eDD8868221E207B5eEC) | ✅ Verified |
| Plasma | `0x08fA5D1c16CD6E2a16FC0E4839f262429959E073` | [Plasmascan](https://plasmascan.to/address/0x08fA5D1c16CD6E2a16FC0E4839f262429959E073) | ✅ Verified |

## Features

- **Batch ETH/Native Sends** — Send ETH, XPL, or any native token to up to 200 wallets in one transaction
- **ERC-20 Token Sprays** — Batch distribute USDC, USDT0, DAI, or any ERC-20 with automatic approval handling
- **Equal Splits** — Gas-optimized `sprayEqual` function for sending the same amount to all recipients
- **0.3% Protocol Fee** — Transparent, on-chain fee collection
- **Security** — OpenZeppelin ReentrancyGuard, Pausable, and Ownable. Owner-pausable for emergencies.

## Supported Tokens

| Chain | Native | Stablecoins |
|-------|--------|-------------|
| Base | ETH | USDC, DAI |
| Plasma | XPL | USDT0 + any ERC-20 |

## Contract Functions

| Function | Description |
|----------|-------------|
| `sprayETH` | Send native token to multiple recipients with variable amounts |
| `sprayERC20` | Send any ERC-20 token to multiple recipients (requires approval) |
| `sprayEqual` | Gas-optimized: same amount to all recipients (ETH or ERC-20) |

## Integrations

- 🤖 [Coinbase AgentKit](https://github.com/coinbase/agentkit/pull/944) — AI agents can batch-send via Spraay
- 🧠 [Bankr](https://bankr.bot) — Natural language batch payments (69K+ users)
- 💵 First batch payment tool on Plasma L1

## Project Structure

```
spray-app/
├── contracts/          # Hardhat project with SprayContract
│   ├── contracts/      # Solidity source
│   ├── scripts/        # Deploy and test scripts
│   └── hardhat.config.js
├── frontend/           # Next.js frontend (WIP)
├── index.html          # Base landing page (GitHub Pages)
├── tao.html            # Bittensor landing page
├── plasma.html         # Plasma landing page
└── CNAME               # spraay.app domain
```

## Quick Start

```bash
cd contracts
npm install
npx hardhat compile

# Deploy to Base
npx hardhat run scripts/deploy.js --network base

# Deploy to Plasma
npx hardhat run scripts/deploy.js --network plasma
```

## Links

- **Website**: [spraay.app](https://spraay.app)
- **Plasma**: [spraay.app/plasma](https://spraay.app/plasma)
- **Bittensor**: [spraay.app/tao](https://spraay.app/tao)
- **Twitter**: [@lostpoet](https://twitter.com/lostpoet)
- **Farcaster**: [@plag](https://warpcast.com/plag)

---

<div align="center">
  <sub>Built by <a href="https://github.com/plagtech">Plag</a> — Batch payments, multi-chain 🔵⚡🟢</sub>
</div>
