/**
 * Deploys Covenant v2 (the reconciled mandate), configures one token and a
 * mandate, then reads every value back from chain before reporting success.
 *
 * Roles: the deployer becomes the owner. The oracle updater and the agent
 * (the Binance Agentic Wallet) must be two other addresses; the contract
 * rejects any overlap. There is deliberately no default for either: the v1
 * script defaulted the updater to the deployer, which the red-team flagged
 * (docs/research/opus-2026-09-24/a-redteam.md H6).
 *
 * Uses a raw ethers.Wallet + JsonRpcProvider, not hardhat-ethers's wrapped
 * signer: on this RPC a contract-creation receipt comes back with `to: ""`,
 * which crashes the wrapper after a successful deploy (friction-log.md C16).
 *
 * Build first with the production profile (the optimizer on), which is
 * what `npm run deploy` does: the default profile leaves the optimizer off
 * and produces bytecode more than twice the size (about 17 KB against 7 KB),
 * which costs more gas to deploy and won't match a BscScan verification done
 * with the production settings. This script deploys whatever artifact was
 * built last, so it warns when that looks like the default profile.
 *
 * Usage:
 *   npm run deploy      (builds with the production profile, then runs this)
 * Env:
 *   DEPLOYER_PRIVATE_KEY, ORACLE_UPDATER_ADDRESS, AGENT_ADDRESS   required
 *   BSC_RPC_URL                    default: several free endpoints behind a fallback provider
 *   MANDATE_TOKEN_ADDRESS          default real NVDAB (verified-facts.md)
 *   MANDATE_MAX_NOTIONAL_USD       default "1"   (per trade, dollars)
 *   MANDATE_MAX_TRADES_PER_DAY     default 5
 *   MANDATE_MAX_DAILY_NOTIONAL_USD default unset (dollars; unset/"0" leaves the cap off - red-team fix H7)
 *   MANDATE_DURATION_DAYS          default 30
 *   TOKEN_MAX_SLIPPAGE_BPS         default 100 (1%)
 *   TOKEN_MAX_POSITION_USD         default "2"   (dollars)
 *   TOKEN_MAX_CLOSED_MARKET_DRIFT_BPS  default 100 (1%; 0 turns the rule off)
 *   ORACLE_STALENESS_SECONDS       default 900
 *   DECISION_TTL_SECONDS           default 600
 *   RESUME_ADDRESS + RESUME_TX     finish configuring an already-deployed contract (skips the deploy transaction)
 */
import { ethers } from "ethers";
import { bscProvider } from "./lib/bsc-provider.js";
import covenantArtifact from "../artifacts/contracts/Covenant.sol/Covenant.json" with { type: "json" };

export const BSC_USDT = "0x55d398326f99059fF775485246999027B3197955";
/** The optimized build is ~7.4 KB and the unoptimized one ~17 KB; anything over this is the latter. */
const UNOPTIMIZED_BYTECODE_BYTES = 12_000;

export const NVDAB = "0x02fca66c1d1afb4e2a7884261eb00f63598a7436";

export interface DeployOptions {
  deployer: ethers.Signer;
  oracleUpdater: string;
  agent: string;
  quoteToken?: string;
  token?: string;
  maxNotionalUsd?: string;
  maxTradesPerDay?: bigint;
  /** Red-team fix H7. Undefined or "0" leaves the cap off. */
  maxDailyNotionalUsd?: string;
  durationDays?: number;
  maxSlippageBps?: number;
  maxPositionUsd?: string;
  maxClosedMarketDriftBps?: number;
  stalenessBound?: number;
  decisionTtl?: number;
  /** Finish configuring a Covenant already deployed at this address (e.g. after a crash between deploy and config) instead of deploying a new one. */
  resume?: { address: string; deployTxHash: string };
  log?: (line: string) => void;
}

/** Polls for a real receipt instead of trusting the wrapper's promise chain. */
async function waitForReceipt(provider: ethers.Provider, hash: string) {
  for (let i = 0; i < 60; i++) {
    // A free RPC can answer a lookup for a just-sent transaction with an
    // error (publicnode: 403 "archive requests require a token") instead of
    // null. That crashed the first mainnet deploy right after its deploy
    // transaction mined, so an error here is just "not yet": poll again.
    const receipt = await provider.getTransactionReceipt(hash).catch(() => null);
    if (receipt) {
      if (receipt.status !== 1) throw new Error(`tx ${hash} reverted`);
      return receipt;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`tx ${hash} not mined within 120s`);
}

export async function deployCovenant(opts: DeployOptions) {
  const log = opts.log ?? (() => {});
  const provider = opts.deployer.provider!;
  const quoteToken = opts.quoteToken ?? BSC_USDT;
  const token = opts.token ?? NVDAB;
  const maxNotional = ethers.parseUnits(opts.maxNotionalUsd ?? "1", 18);
  const maxTrades = opts.maxTradesPerDay ?? 5n;
  const maxDailyNotional = ethers.parseUnits(opts.maxDailyNotionalUsd ?? "0", 18);
  const durationDays = opts.durationDays ?? 30;
  const slippageBps = opts.maxSlippageBps ?? 100;
  const maxPosition = ethers.parseUnits(opts.maxPositionUsd ?? "2", 18);
  const driftBps = opts.maxClosedMarketDriftBps ?? 100;
  const stalenessBound = opts.stalenessBound ?? 900;
  const decisionTtl = opts.decisionTtl ?? 600;
  const owner = await opts.deployer.getAddress();

  log(`owner (deployer):  ${owner}`);
  log(`oracle updater:    ${opts.oracleUpdater}`);
  log(`agent:             ${opts.agent}`);

  let sentHash: string;
  let address: string;
  let deployBlock: number;
  if (opts.resume) {
    const receipt = await waitForReceipt(provider, opts.resume.deployTxHash);
    if (receipt.contractAddress?.toLowerCase() !== opts.resume.address.toLowerCase()) throw new Error("resume: that transaction didn't create that address");
    sentHash = opts.resume.deployTxHash;
    address = receipt.contractAddress;
    deployBlock = receipt.blockNumber;
    log(`resuming at ${address} (tx ${sentHash})`);
  } else {
    const factory = new ethers.ContractFactory(covenantArtifact.abi, covenantArtifact.bytecode, opts.deployer);
    const deployTx = await factory.getDeployTransaction(quoteToken, opts.oracleUpdater, opts.agent, stalenessBound, decisionTtl);
    const sent = await opts.deployer.sendTransaction(deployTx);
    const deployReceipt = await waitForReceipt(provider, sent.hash);
    if (!deployReceipt.contractAddress) throw new Error("deploy receipt has no contractAddress");
    sentHash = sent.hash;
    address = deployReceipt.contractAddress;
    deployBlock = deployReceipt.blockNumber;
    log(`deployed at ${address} (tx ${sentHash})`);
  }

  const covenant = new ethers.Contract(address, covenantArtifact.abi, opts.deployer);
  const configTx = await covenant.configureToken(token, true, slippageBps, maxPosition);
  await waitForReceipt(provider, configTx.hash);
  const driftTx = await covenant.setClosedMarketDrift(token, driftBps);
  await waitForReceipt(provider, driftTx.hash);

  const latest = (await provider.getBlock("latest"))!.timestamp;
  const expiry = latest + durationDays * 24 * 60 * 60;
  const mandateTx = await covenant.setMandate(maxNotional, maxTrades, expiry);
  await waitForReceipt(provider, mandateTx.hash);

  // Red-team fix H7: a separate setter, not part of setMandate, so
  // tightening it later never requires re-setting expiry and the rest of
  // the mandate. Always called (even to explicitly set 0/disabled) so the
  // read-back below proves the deployed value, not just the default.
  const dailyNotionalTx = await covenant.setMaxDailyNotionalUsd(maxDailyNotional);
  await waitForReceipt(provider, dailyNotionalTx.hash);

  // Read everything back. No step above counts as done until chain agrees.
  const [chainOwner, chainUpdater, chainAgent, mandate, cfg, chainMaxDailyNotional] = await Promise.all([
    covenant.owner(),
    covenant.oracleUpdater(),
    covenant.agent(),
    covenant.mandate(),
    covenant.tokenConfig(token),
    covenant.maxDailyNotionalUsd(),
  ]);
  const checks: Array<[string, boolean]> = [
    ["owner", chainOwner.toLowerCase() === owner.toLowerCase()],
    ["oracleUpdater", chainUpdater.toLowerCase() === opts.oracleUpdater.toLowerCase()],
    ["agent", chainAgent.toLowerCase() === opts.agent.toLowerCase()],
    ["mandate.active", mandate.active === true],
    ["mandate.maxNotionalPerTradeUsd", mandate.maxNotionalPerTradeUsd === maxNotional],
    ["mandate.maxTradesPerDay", mandate.maxTradesPerDay === maxTrades],
    ["mandate.expiry", mandate.expiry === BigInt(expiry)],
    ["maxDailyNotionalUsd", chainMaxDailyNotional === maxDailyNotional],
    ["token.allowed", cfg.allowed === true],
    ["token.maxSlippageBps", Number(cfg.maxSlippageBps) === slippageBps],
    ["token.maxPositionUsd", cfg.maxPositionUsd === maxPosition],
    ["token.maxClosedMarketDriftBps", Number(cfg.maxClosedMarketDriftBps) === driftBps],
  ];
  const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
  if (failed.length > 0) throw new Error(`post-deploy read-back failed: ${failed.join(", ")}`);
  log(`read back from chain: ${checks.length}/${checks.length} values match`);

  return { address, deployTxHash: sentHash, deployBlock, expiry };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    try {
      process.loadEnvFile();
    } catch {
      // no .env - real environment variables only
    }
    const runtimeBytes = (covenantArtifact.deployedBytecode.length - 2) / 2;
    if (runtimeBytes > UNOPTIMIZED_BYTECODE_BYTES && !process.env.ALLOW_UNOPTIMIZED_DEPLOY) {
      throw new Error(
        `artifacts/ holds ${runtimeBytes} bytes of runtime bytecode - that's the unoptimized default profile ` +
          `(the production build is about 7,400). Run \`npm run deploy\`, or \`npm run build:production\` first, ` +
          `or set ALLOW_UNOPTIMIZED_DEPLOY=1 to deploy it anyway.`,
      );
    }
    const key = process.env.DEPLOYER_PRIVATE_KEY;
    const oracleUpdater = process.env.ORACLE_UPDATER_ADDRESS;
    const agent = process.env.AGENT_ADDRESS;
    if (!key || !oracleUpdater || !agent) {
      throw new Error("Set DEPLOYER_PRIVATE_KEY, ORACLE_UPDATER_ADDRESS and AGENT_ADDRESS (three different keys).");
    }
    // `||`, not `??`: .env.example ships these present but blank.
    // NonceManager: three sequential sends from one key hit a real
    // NONCE_EXPIRED race with a bare Wallet (README, chaos-fork.ts).
    const deployer = new ethers.NonceManager(
      new ethers.Wallet(key, bscProvider(process.env.BSC_RPC_URL || undefined)),
    );
    const result = await deployCovenant({
      deployer,
      oracleUpdater,
      agent,
      token: process.env.MANDATE_TOKEN_ADDRESS || undefined,
      maxNotionalUsd: process.env.MANDATE_MAX_NOTIONAL_USD || undefined,
      maxTradesPerDay: process.env.MANDATE_MAX_TRADES_PER_DAY ? BigInt(process.env.MANDATE_MAX_TRADES_PER_DAY) : undefined,
      maxDailyNotionalUsd: process.env.MANDATE_MAX_DAILY_NOTIONAL_USD || undefined,
      durationDays: process.env.MANDATE_DURATION_DAYS ? Number(process.env.MANDATE_DURATION_DAYS) : undefined,
      maxSlippageBps: process.env.TOKEN_MAX_SLIPPAGE_BPS ? Number(process.env.TOKEN_MAX_SLIPPAGE_BPS) : undefined,
      maxPositionUsd: process.env.TOKEN_MAX_POSITION_USD || undefined,
      maxClosedMarketDriftBps: process.env.TOKEN_MAX_CLOSED_MARKET_DRIFT_BPS ? Number(process.env.TOKEN_MAX_CLOSED_MARKET_DRIFT_BPS) : undefined,
      stalenessBound: process.env.ORACLE_STALENESS_SECONDS ? Number(process.env.ORACLE_STALENESS_SECONDS) : undefined,
      decisionTtl: process.env.DECISION_TTL_SECONDS ? Number(process.env.DECISION_TTL_SECONDS) : undefined,
      resume: process.env.RESUME_ADDRESS && process.env.RESUME_TX ? { address: process.env.RESUME_ADDRESS, deployTxHash: process.env.RESUME_TX } : undefined,
      log: (line) => console.log(line),
    });
    console.log(`\nSet this in .env (verify.ts and the status page both need the deployment block):\nCOVENANT_ADDRESS=${result.address}\nVERIFY_FROM_BLOCK=${result.deployBlock}`);
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
