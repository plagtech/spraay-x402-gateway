// scripts/deploy-spray.mjs
// Deploy SprayContract (the Spraay batch payment contract) to Robinhood Chain.
//
// Self-contained: compiles contracts/spray-contract.input.json (the exact
// standard-JSON input recovered from the Sourcify verification of the Base
// deployment 0x1646452F98E36A3c9Cfc3eDD8868221E207B5eEC) with the pinned
// solc 0.8.20 devDependency, proves the compiled runtime bytecode is
// byte-identical to the live Base contract, then deploys with ethers.
// No hardhat required.
//
// Usage:
//   $env:DEPLOYER_PRIVATE_KEY="0x..."          # must be the unichain/plasma deployer
//   node scripts/deploy-spray.mjs --network testnet [--dry-run]
//   node scripts/deploy-spray.mjs --network mainnet --i-approve-mainnet-spend
//
// The mainnet path refuses to run without --i-approve-mainnet-spend.

import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { ethers } from "ethers";

const require = createRequire(import.meta.url);
const solc = require("solc");

// Runtime bytecode of the verified Base deployment (exact_match on Sourcify).
const EXPECTED_RUNTIME_KECCAK = "0x7c4b82ffe3cccab5b886d57f868de66adc3aa3aaff54460f7d207ade4d942035";
const BASE_CONTRACT = "0x1646452F98E36A3c9Cfc3eDD8868221E207B5eEC";
// Wallet that deployed the Unichain + Plasma instances (0x08fA5D1c...E073).
const EXPECTED_DEPLOYER = "0x75F3F4C27BB8DB5d72E82a5359674084025Fc82b";
const FEE_BPS = 30; // matches every existing deployment

const NETWORKS = {
  testnet: {
    chainId: 46630,
    rpcUrl: process.env.ROBINHOOD_TESTNET_RPC_URL || "https://rpc.testnet.chain.robinhood.com",
    explorer: "https://explorer.testnet.chain.robinhood.com",
  },
  mainnet: {
    chainId: 4663,
    rpcUrl: process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com",
    explorer: "https://robinhoodchain.blockscout.com",
  },
};

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const networkName = args[args.indexOf("--network") + 1];
const net = NETWORKS[networkName];

const die = (msg) => { console.error("\n✗ " + msg); process.exit(1); };

if (!net) die("--network testnet | mainnet is required");
if (networkName === "mainnet" && !flag("--i-approve-mainnet-spend"))
  die("mainnet deploy refused: pass --i-approve-mainnet-spend only after LP has approved real spend");

const main = async () => {
  // 1. Compile the exact verified input
  console.log("▸ Compiling contracts/spray-contract.input.json with solc", solc.version());
  const input = JSON.parse(readFileSync("contracts/spray-contract.input.json", "utf8"));
  input.settings.outputSelection = { "*": { "*": ["evm.bytecode.object", "evm.deployedBytecode.object", "abi"] } };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (out.errors || []).filter((e) => e.severity === "error");
  if (errors.length) die("solc errors:\n" + errors.map((e) => e.formattedMessage).join("\n"));
  const artifact = out.contracts["contracts/SprayContract.sol"]["SprayContract"];
  const runtime = "0x" + artifact.evm.deployedBytecode.object;

  // 2. Prove artifact == verified Base deployment
  if (ethers.keccak256(runtime) !== EXPECTED_RUNTIME_KECCAK)
    die("compiled runtime bytecode does not match the verified Base deployment — do not deploy");
  console.log("  ✓ runtime bytecode matches Base", BASE_CONTRACT);
  try {
    const base = new ethers.JsonRpcProvider("https://mainnet.base.org");
    const live = await base.getCode(BASE_CONTRACT);
    if (live.toLowerCase() !== runtime.toLowerCase()) die("live Base bytecode differs from compiled artifact");
    console.log("  ✓ re-confirmed against live Base getCode");
  } catch (e) {
    console.log("  ! could not re-fetch live Base code (" + e.message + ") — relying on pinned hash");
  }

  // 3. Wallet + network guards
  const pk = process.env.DEPLOYER_PRIVATE_KEY;
  if (!pk) die("DEPLOYER_PRIVATE_KEY env var is required");
  const provider = new ethers.JsonRpcProvider(net.rpcUrl);
  const wallet = new ethers.Wallet(pk, provider);
  if (wallet.address.toLowerCase() !== EXPECTED_DEPLOYER.toLowerCase())
    die(`deployer is ${wallet.address}, expected the unichain/plasma deployer ${EXPECTED_DEPLOYER}`);
  const { chainId } = await provider.getNetwork();
  if (Number(chainId) !== net.chainId)
    die(`RPC reports chainId ${chainId}, expected ${net.chainId} (${networkName})`);
  const balance = await provider.getBalance(wallet.address);
  console.log(`▸ Network ${networkName} (chainId ${net.chainId})`);
  console.log(`  deployer ${wallet.address}  balance ${ethers.formatEther(balance)} ETH`);
  if (balance === 0n) die("deployer has zero ETH on this network — fund it first");

  // 4. Deploy: constructor(feeRecipient = deployer, feeBps = 30), as on Unichain
  const factory = new ethers.ContractFactory(artifact.abi, "0x" + artifact.evm.bytecode.object, wallet);
  const deployTx = await factory.getDeployTransaction(wallet.address, FEE_BPS);
  const gas = await provider.estimateGas({ ...deployTx, from: wallet.address });
  const feeData = await provider.getFeeData();
  console.log(`  constructor(feeRecipient=${wallet.address}, feeBps=${FEE_BPS})`);
  console.log(`  estimated gas ${gas} @ ${ethers.formatUnits(feeData.gasPrice ?? 0n, "gwei")} gwei`);
  if (flag("--dry-run")) { console.log("\n--dry-run: stopping before deployment."); return; }

  const contract = await factory.deploy(wallet.address, FEE_BPS);
  console.log("  deploy tx:", contract.deploymentTransaction().hash);
  await contract.waitForDeployment();
  const address = await contract.getAddress();

  // 5. Post-deploy sanity
  const deployed = new ethers.Contract(address, artifact.abi, provider);
  const [fr, fb] = [await deployed.feeRecipient(), await deployed.feeBps()];
  const code = await provider.getCode(address);
  console.log("\n  ✅ SprayContract deployed to:", address);
  console.log("  feeRecipient:", fr, " feeBps:", fb.toString());
  console.log("  on-chain runtime matches artifact:", code.toLowerCase() === runtime.toLowerCase());
  console.log("  explorer:", `${net.explorer}/address/${address}`);

  // 6. Blockscout verification (standard-input). Cloudflare may block
  //    non-browser calls — fall back to manual instructions if so.
  try {
    const form = new FormData();
    form.append("compiler_version", "v0.8.20+commit.a1b79de6");
    form.append("license_type", "mit");
    form.append("contract_name", "SprayContract");
    form.append("autodetect_constructor_args", "false");
    form.append("constructor_args", ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [wallet.address, FEE_BPS]).slice(2));
    form.append("files[0]", new Blob([readFileSync("contracts/spray-contract.input.json")], { type: "application/json" }), "input.json");
    const resp = await fetch(`${net.explorer}/api/v2/smart-contracts/${address}/verification/via/standard-input`, { method: "POST", body: form });
    console.log("  Blockscout verification submit:", resp.status, (await resp.text()).slice(0, 200));
  } catch (e) {
    console.log("  Blockscout API unreachable (" + e.message + ").");
    console.log("  Verify manually: explorer → address → Verify & Publish → Standard JSON input,");
    console.log("  compiler v0.8.20+commit.a1b79de6, upload contracts/spray-contract.input.json.");
  }

  writeFileSync(
    `scripts/spray-deploy-${networkName}-${net.chainId}.json`,
    JSON.stringify({ network: networkName, chainId: net.chainId, address, deployer: wallet.address, feeRecipient: fr, feeBps: Number(fb), tx: contract.deploymentTransaction().hash, deployedAt: new Date().toISOString() }, null, 2),
  );
  console.log(`  record written: scripts/spray-deploy-${networkName}-${net.chainId}.json`);
};

main().catch((e) => { console.error(e); process.exit(1); });
