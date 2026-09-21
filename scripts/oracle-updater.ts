/**
 * Pushes a live RWA asset-market-status read into a deployed Covenant
 * contract's on-chain oracle. Intended to run on a schedule (cron, or a
 * loop) against the real mainnet deployment in Phase 3; for now it also
 * works against the bscFork network for testing the full real-data pipeline
 * before any real money is involved.
 *
 * Usage:
 *   COVENANT_ADDRESS=0x... npx hardhat run scripts/oracle-updater.ts --network bscFork
 *
 * Env vars:
 *   COVENANT_ADDRESS        required - the deployed Covenant contract
 *   ORACLE_TOKEN_ADDRESS    optional - defaults to real NVDAB (verified-facts.md)
 *   ORACLE_BINANCE_CHAIN_ID optional - defaults to 56 (BSC)
 */
import { network } from "hardhat";
import { fetchAssetMarketStatus, isHalted } from "./lib/rwa-status.js";

const DEFAULT_BINANCE_CHAIN_ID = 56;
const DEFAULT_TOKEN_ADDRESS = "0x02fca66c1d1afb4e2a7884261eb00f63598a7436"; // real NVDAB, verified-facts.md

const COVENANT_ABI = [
  "function updateOracle(address token, bool halted) external",
  "function oracleStatus(address token) external view returns (bool halted, uint256 updatedAt)",
];

async function main() {
  const covenantAddress = process.env.COVENANT_ADDRESS;
  if (!covenantAddress) {
    throw new Error("Set COVENANT_ADDRESS to the deployed Covenant contract's address.");
  }
  const tokenAddress = process.env.ORACLE_TOKEN_ADDRESS ?? DEFAULT_TOKEN_ADDRESS;
  const binanceChainId = Number(process.env.ORACLE_BINANCE_CHAIN_ID ?? DEFAULT_BINANCE_CHAIN_ID);

  const { ethers } = await network.getOrCreate();
  const [signer] = await ethers.getSigners();
  const covenant = new ethers.Contract(covenantAddress, COVENANT_ABI, signer);

  console.log(`Fetching live RWA asset market status: chainId=${binanceChainId} contract=${tokenAddress}`);
  const status = await fetchAssetMarketStatus(binanceChainId, tokenAddress);
  const halted = isHalted(status);
  console.log(`Live: openState=${status.openState} reasonCode=${status.reasonCode} reasonMsg=${status.reasonMsg} -> halted=${halted}`);

  console.log(`Submitting updateOracle(${tokenAddress}, ${halted}) as ${signer.address}...`);
  const tx = await covenant.updateOracle(tokenAddress, halted);
  const receipt = await tx.wait();
  console.log(`Confirmed in tx ${receipt?.hash}`);

  const [onChainHalted, onChainUpdatedAt] = await covenant.oracleStatus(tokenAddress);
  console.log(`On-chain oracleStatus now: halted=${onChainHalted} updatedAt=${onChainUpdatedAt}`);
  if (onChainHalted !== halted) {
    throw new Error("On-chain state doesn't match what was just submitted - something is wrong.");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
