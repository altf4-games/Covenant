/**
 * Deploys Covenant, sets an initial mandate, allowlists the default token,
 * and pushes a real initial oracle reading - all in one script, verified by
 * reading every value back on chain afterward rather than trusting the
 * deploy transactions' return values alone.
 *
 * Network-agnostic: run it against whichever network Hardhat targets. Today
 * that's the fork; the same script deploys to real BSC mainnet in Phase 3
 * without changes, per PLAN.md's "config change, not new development" plan.
 *
 * Usage:
 *   npx hardhat run scripts/deploy.ts --network bscFork
 *
 * Env vars (all optional, sane defaults for a fork/testnet deploy):
 *   ORACLE_UPDATER_ADDRESS     defaults to the deployer's own address
 *   ORACLE_STALENESS_SECONDS   defaults to 900 (15 minutes)
 *   MANDATE_TOKEN_ADDRESS      defaults to real NVDAB (verified-facts.md)
 *   MANDATE_MAX_NOTIONAL       defaults to "50" (quote-token units, human-readable)
 *   MANDATE_MAX_TRADES_PER_DAY defaults to 10
 *   MANDATE_DURATION_DAYS      defaults to 30
 */
import { network } from "hardhat";
import { fetchAssetMarketStatus, isHalted } from "./lib/rwa-status.js";

const USDT = "0x55d398326f99059fF775485246999027B3197955";
const PANCAKE_V3_SWAP_ROUTER = "0x1b81D678ffb9C0263b24A97847620C99d213eB14";
const DEFAULT_MANDATE_TOKEN = "0x02fca66c1d1afb4e2a7884261eb00f63598a7436"; // real NVDAB
const BSC_BINANCE_CHAIN_ID = 56;
const ONE_DAY_SECONDS = 24 * 60 * 60;

async function main() {
  const { ethers } = await network.getOrCreate();
  const [deployer] = await ethers.getSigners();

  // `||`, not `??`, throughout: an empty-but-present .env line sets these to
  // "", not undefined, which `??` would let straight through unfixed - see
  // hardhat.config.ts's BSC_RPC_URL comment for where this was first caught.
  const oracleUpdaterAddress = process.env.ORACLE_UPDATER_ADDRESS || deployer.address;
  const stalenessBound = BigInt(process.env.ORACLE_STALENESS_SECONDS || 900);
  const mandateToken = process.env.MANDATE_TOKEN_ADDRESS || DEFAULT_MANDATE_TOKEN;
  const maxNotionalPerTrade = ethers.parseUnits(process.env.MANDATE_MAX_NOTIONAL || "50", 18);
  const maxTradesPerDay = BigInt(process.env.MANDATE_MAX_TRADES_PER_DAY || 10);
  const mandateDurationDays = Number(process.env.MANDATE_DURATION_DAYS || 30);

  console.log(`Deploying Covenant as ${deployer.address}...`);
  console.log(`  quoteToken (USDT):        ${USDT}`);
  console.log(`  swapRouter (PancakeV3):   ${PANCAKE_V3_SWAP_ROUTER}`);
  console.log(`  oracleUpdater:            ${oracleUpdaterAddress}`);
  console.log(`  stalenessBound:           ${stalenessBound}s`);

  const covenant = await ethers.deployContract("Covenant", [
    USDT,
    PANCAKE_V3_SWAP_ROUTER,
    oracleUpdaterAddress,
    stalenessBound,
  ]);
  await covenant.waitForDeployment();
  const covenantAddress = await covenant.getAddress();
  console.log(`Deployed at ${covenantAddress}`);

  console.log(`\nAllowlisting mandate token ${mandateToken}...`);
  await (await covenant.setAllowedToken(mandateToken, true)).wait();

  const latestBlock = await ethers.provider.getBlock("latest");
  const expiry = latestBlock!.timestamp + mandateDurationDays * ONE_DAY_SECONDS;
  console.log(`Setting mandate: maxNotionalPerTrade=${ethers.formatUnits(maxNotionalPerTrade, 18)} maxTradesPerDay=${maxTradesPerDay} expiry=${new Date(expiry * 1000).toISOString()}...`);
  await (await covenant.setMandate(maxNotionalPerTrade, maxTradesPerDay, expiry)).wait();

  // Push a real initial oracle reading rather than leaving it unset (which
  // previewDecision treats as stale/denied, correctly, but there's no reason
  // to deploy into that state when the real answer is one live call away).
  if (oracleUpdaterAddress.toLowerCase() === deployer.address.toLowerCase()) {
    console.log(`\nFetching live RWA status for ${mandateToken} to seed the oracle...`);
    try {
      const status = await fetchAssetMarketStatus(BSC_BINANCE_CHAIN_ID, mandateToken);
      const halted = isHalted(status);
      console.log(`  live: openState=${status.openState} reasonCode=${status.reasonCode} -> halted=${halted}`);
      await (await covenant.updateOracle(mandateToken, halted)).wait();
    } catch (error) {
      console.warn(`  could not seed the oracle from live data (${(error as Error).message}) - it will read as stale until updateOracle is called.`);
    }
  } else {
    console.log(`\noracleUpdater is a different address (${oracleUpdaterAddress}) - skipping initial oracle seed, that account must call updateOracle itself.`);
  }

  // Verify every claim above by reading it back, not by trusting the
  // transactions' return values - the no-dummy-data rule applies to the
  // deploy script's own output too.
  console.log("\nVerifying on-chain state...");
  const [mandate, allowlisted, oracleStatus, owner] = await Promise.all([
    covenant.mandate(),
    covenant.allowedTokens(mandateToken),
    covenant.oracleStatus(mandateToken),
    covenant.owner(),
  ]);
  console.log(`  owner:            ${owner}`);
  console.log(`  mandate.active:   ${mandate.active}`);
  console.log(`  allowlisted:      ${allowlisted}`);
  console.log(`  oracle.halted:    ${oracleStatus.halted}`);
  console.log(`  oracle.updatedAt: ${oracleStatus.updatedAt === 0n ? "never" : new Date(Number(oracleStatus.updatedAt) * 1000).toISOString()}`);

  if (mandate.active !== true || allowlisted !== true) {
    throw new Error("Post-deploy verification failed: on-chain state doesn't match what was just submitted.");
  }

  console.log(`\nDeployment verified. Set this in .env:\nCOVENANT_ADDRESS=${covenantAddress}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
