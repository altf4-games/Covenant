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
 * Usage:
 *   npx tsx scripts/deploy.ts
 * Env:
 *   DEPLOYER_PRIVATE_KEY, ORACLE_UPDATER_ADDRESS, AGENT_ADDRESS   required
 *   BSC_RPC_URL                    default https://bsc-mainnet.public.blastapi.io
 *   MANDATE_TOKEN_ADDRESS          default real NVDAB (verified-facts.md)
 *   MANDATE_MAX_NOTIONAL_USD       default "1"   (per trade, dollars)
 *   MANDATE_MAX_TRADES_PER_DAY     default 5
 *   MANDATE_DURATION_DAYS          default 30
 *   TOKEN_MAX_SLIPPAGE_BPS         default 100 (1%)
 *   TOKEN_MAX_POSITION_USD         default "2"   (dollars)
 *   TOKEN_MAX_CLOSED_MARKET_DRIFT_BPS  default 100 (1%; 0 turns the rule off)
 *   ORACLE_STALENESS_SECONDS       default 900
 *   DECISION_TTL_SECONDS           default 600
 */
import { ethers } from "ethers";
import covenantArtifact from "../artifacts/contracts/Covenant.sol/Covenant.json" with { type: "json" };

export const BSC_USDT = "0x55d398326f99059fF775485246999027B3197955";
export const NVDAB = "0x02fca66c1d1afb4e2a7884261eb00f63598a7436";

export interface DeployOptions {
  deployer: ethers.Signer;
  oracleUpdater: string;
  agent: string;
  quoteToken?: string;
  token?: string;
  maxNotionalUsd?: string;
  maxTradesPerDay?: bigint;
  durationDays?: number;
  maxSlippageBps?: number;
  maxPositionUsd?: string;
  maxClosedMarketDriftBps?: number;
  stalenessBound?: number;
  decisionTtl?: number;
  log?: (line: string) => void;
}

/** Polls for a real receipt instead of trusting the wrapper's promise chain. */
async function waitForReceipt(provider: ethers.Provider, hash: string) {
  for (let i = 0; i < 60; i++) {
    const receipt = await provider.getTransactionReceipt(hash);
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

  const factory = new ethers.ContractFactory(covenantArtifact.abi, covenantArtifact.bytecode, opts.deployer);
  const deployTx = await factory.getDeployTransaction(quoteToken, opts.oracleUpdater, opts.agent, stalenessBound, decisionTtl);
  const sent = await opts.deployer.sendTransaction(deployTx);
  const deployReceipt = await waitForReceipt(provider, sent.hash);
  const address = deployReceipt.contractAddress;
  if (!address) throw new Error("deploy receipt has no contractAddress");
  log(`deployed at ${address} (tx ${sent.hash})`);

  const covenant = new ethers.Contract(address, covenantArtifact.abi, opts.deployer);
  const configTx = await covenant.configureToken(token, true, slippageBps, maxPosition);
  await waitForReceipt(provider, configTx.hash);
  const driftTx = await covenant.setClosedMarketDrift(token, driftBps);
  await waitForReceipt(provider, driftTx.hash);

  const latest = (await provider.getBlock("latest"))!.timestamp;
  const expiry = latest + durationDays * 24 * 60 * 60;
  const mandateTx = await covenant.setMandate(maxNotional, maxTrades, expiry);
  await waitForReceipt(provider, mandateTx.hash);

  // Read everything back. No step above counts as done until chain agrees.
  const [chainOwner, chainUpdater, chainAgent, mandate, cfg] = await Promise.all([
    covenant.owner(),
    covenant.oracleUpdater(),
    covenant.agent(),
    covenant.mandate(),
    covenant.tokenConfig(token),
  ]);
  const checks: Array<[string, boolean]> = [
    ["owner", chainOwner.toLowerCase() === owner.toLowerCase()],
    ["oracleUpdater", chainUpdater.toLowerCase() === opts.oracleUpdater.toLowerCase()],
    ["agent", chainAgent.toLowerCase() === opts.agent.toLowerCase()],
    ["mandate.active", mandate.active === true],
    ["mandate.maxNotionalPerTradeUsd", mandate.maxNotionalPerTradeUsd === maxNotional],
    ["mandate.maxTradesPerDay", mandate.maxTradesPerDay === maxTrades],
    ["mandate.expiry", mandate.expiry === BigInt(expiry)],
    ["token.allowed", cfg.allowed === true],
    ["token.maxSlippageBps", Number(cfg.maxSlippageBps) === slippageBps],
    ["token.maxPositionUsd", cfg.maxPositionUsd === maxPosition],
    ["token.maxClosedMarketDriftBps", Number(cfg.maxClosedMarketDriftBps) === driftBps],
  ];
  const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
  if (failed.length > 0) throw new Error(`post-deploy read-back failed: ${failed.join(", ")}`);
  log(`read back from chain: ${checks.length}/${checks.length} values match`);

  return { address, deployTxHash: sent.hash, expiry };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    try {
      process.loadEnvFile();
    } catch {
      // no .env - real environment variables only
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
      new ethers.Wallet(key, new ethers.JsonRpcProvider(process.env.BSC_RPC_URL || "https://bsc-mainnet.public.blastapi.io")),
    );
    const result = await deployCovenant({
      deployer,
      oracleUpdater,
      agent,
      token: process.env.MANDATE_TOKEN_ADDRESS || undefined,
      maxNotionalUsd: process.env.MANDATE_MAX_NOTIONAL_USD || undefined,
      maxTradesPerDay: process.env.MANDATE_MAX_TRADES_PER_DAY ? BigInt(process.env.MANDATE_MAX_TRADES_PER_DAY) : undefined,
      durationDays: process.env.MANDATE_DURATION_DAYS ? Number(process.env.MANDATE_DURATION_DAYS) : undefined,
      maxSlippageBps: process.env.TOKEN_MAX_SLIPPAGE_BPS ? Number(process.env.TOKEN_MAX_SLIPPAGE_BPS) : undefined,
      maxPositionUsd: process.env.TOKEN_MAX_POSITION_USD || undefined,
      maxClosedMarketDriftBps: process.env.TOKEN_MAX_CLOSED_MARKET_DRIFT_BPS ? Number(process.env.TOKEN_MAX_CLOSED_MARKET_DRIFT_BPS) : undefined,
      stalenessBound: process.env.ORACLE_STALENESS_SECONDS ? Number(process.env.ORACLE_STALENESS_SECONDS) : undefined,
      decisionTtl: process.env.DECISION_TTL_SECONDS ? Number(process.env.DECISION_TTL_SECONDS) : undefined,
      log: (line) => console.log(line),
    });
    console.log(`\nSet this in .env:\nCOVENANT_ADDRESS=${result.address}`);
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
