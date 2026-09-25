/**
 * Deploys a Covenant to an already-running local fork node and records a
 * few real decisions (a denial, a settled trade, a cancelled one), so the
 * status page has something to show.
 *
 * Usage:
 *   npx hardhat node --fork https://bsc-mainnet.public.blastapi.io --chain-id 56   (separately)
 *   npx tsx scripts/seed-status-page-demo.ts
 */
import { ethers } from "ethers";
import covenantArtifact from "../artifacts/contracts/Covenant.sol/Covenant.json" with { type: "json" };
import { setupCovenant, buyAt } from "./lib/local-fork.js";
import { NVDAB } from "./deploy.js";

const RPC_URL = process.env.RPC_URL || "http://127.0.0.1:8545";
const IMPERSONATOR = "0x2F701b108a9aF5558960325A0239D0a13c2C4444";

async function main() {
  try {
    process.loadEnvFile();
  } catch {
    // no .env - real environment variables only
  }
  const firstBlock = await new ethers.JsonRpcProvider(RPC_URL).getBlockNumber();
  const env = await setupCovenant(RPC_URL, { maxNotionalUsd: "1", maxPositionUsd: "2" });
  const covenant = new ethers.Contract(env.covenantAddress, covenantArtifact.abi, env.agent);
  const small = buyAt(env.livePrice, 10n ** 18n / 2n); // $0.50
  const big = buyAt(env.livePrice, 5n * 10n ** 18n); // $5, over the $1 cap

  await (await covenant.commit(0, IMPERSONATOR, small.amountIn, small.quotedOut, small.minOut, ethers.ZeroHash, ethers.ZeroHash)).wait();
  await (await covenant.commit(0, NVDAB, big.amountIn, big.quotedOut, big.minOut, ethers.ZeroHash, ethers.ZeroHash)).wait();
  await (await covenant.commit(0, NVDAB, small.amountIn, small.quotedOut, small.minOut, ethers.ZeroHash, ethers.ZeroHash)).wait();
  await (await covenant.settle(3n, ethers.keccak256(ethers.toUtf8Bytes("demo swap")), small.quotedOut, 3)).wait();
  await (await covenant.commit(0, NVDAB, small.amountIn, small.quotedOut, small.minOut, ethers.ZeroHash, ethers.ZeroHash)).wait();
  await (await covenant.cancel(4n)).wait();

  const page = new URL("../status-page/index.html", import.meta.url).pathname;
  console.log(`COVENANT_ADDRESS=${env.covenantAddress}`);
  console.log(`status page: file://${page}?rpc=${encodeURIComponent(RPC_URL)}&contract=${env.covenantAddress}&fromBlock=${firstBlock + 1}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
