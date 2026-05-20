// scripts/deploy-compute-futures.js
// Deploy SpraayComputeFutures to Base mainnet
//
// Usage:
//   $env:DEPLOYER_PRIVATE_KEY="0xYourKey"
//   npx hardhat run scripts/deploy-compute-futures.js --network base

const hre = require("hardhat");

async function main() {
  const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  const OPERATOR = "0xAd62f03C7514bb8c51f1eA70C2b75C37404695c8"; // Spraay gateway wallet

  console.log("\n💧 Deploying SpraayComputeFutures to Base mainnet...\n");
  console.log("  USDC:", USDC_BASE);
  console.log("  Operator:", OPERATOR);

  const [deployer] = await hre.ethers.getSigners();
  console.log("  Deployer:", deployer.address);
  
  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log("  Balance:", hre.ethers.formatEther(balance), "ETH\n");

  const Factory = await hre.ethers.getContractFactory("SpraayComputeFutures");
  const contract = await Factory.deploy(USDC_BASE, OPERATOR);
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  console.log("  ✅ SpraayComputeFutures deployed to:", address);
  console.log("\n  Next steps:");
  console.log("  1. Verify on Basescan:");
  console.log(`     npx hardhat verify --network base ${address} ${USDC_BASE} ${OPERATOR}`);
  console.log("  2. Set COMPUTE_FUTURES_CONTRACT in Railway env vars");
  console.log("  3. Wire gateway endpoints to call the contract\n");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
