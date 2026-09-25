/**
 * Shared setup for everything that runs against a real `hardhat node --fork`
 * child process over HTTP: the live test suites and scripts/chaos-fork.ts.
 *
 * `setupCovenant` deploys with the real scripts/deploy.ts code and posts
 * the oracle with the real scripts/oracle-updater.ts code, so every suite
 * that uses it also exercises the exact path the mainnet deploy will run.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { ethers } from "ethers";
import { deployCovenant, NVDAB } from "../deploy.js";
import { pushOracleUpdate, readLiveOracle } from "../oracle-updater.js";

export const BSC_FORK_URL = process.env.BSC_RPC_URL || "https://bsc-mainnet.public.blastapi.io";

// Hardhat node's well-known development keys #0-#2. Public, funded only on
// local nodes. Three distinct keys because Covenant rejects role overlap.
export const DEV_KEYS = {
  owner: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  updater: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  agent: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
};

export async function waitForRpc(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "eth_chainId", params: [], id: 1 }),
      });
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`RPC at ${url} did not become ready within ${timeoutMs}ms`);
}

export async function startForkNode(port: number): Promise<{ rpcUrl: string; process: ChildProcess; stop: () => void }> {
  const child = spawn("npx", ["hardhat", "node", "--fork", BSC_FORK_URL, "--chain-id", "56", "--port", String(port)], {
    cwd: new URL("../..", import.meta.url).pathname,
    stdio: "ignore",
  });
  const rpcUrl = `http://127.0.0.1:${port}`;
  await waitForRpc(rpcUrl, 60_000);
  return { rpcUrl, process: child, stop: () => child.kill() };
}

/**
 * Deploys Covenant v2 on a local fork with three distinct dev keys, and
 * posts the real live NVDAB price and real last-close price with the market
 * marked open and the session marked open, so allow paths can run whatever
 * the market is doing right now. Signers are
 * NonceManager-wrapped: many sequential sends from one key hit a real
 * NONCE_EXPIRED race with a bare Wallet (README, "Tests, and what they caught").
 */
export async function setupCovenant(
  rpcUrl: string,
  opts: { maxNotionalUsd?: string; maxPositionUsd?: string; maxSlippageBps?: number; maxTradesPerDay?: bigint; maxClosedMarketDriftBps?: number } = {},
) {
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const owner = new ethers.NonceManager(new ethers.Wallet(DEV_KEYS.owner, provider));
  const updater = new ethers.NonceManager(new ethers.Wallet(DEV_KEYS.updater, provider));
  const agent = new ethers.NonceManager(new ethers.Wallet(DEV_KEYS.agent, provider));
  const agentAddress = await agent.getAddress();

  const { address: covenantAddress } = await deployCovenant({
    deployer: owner,
    oracleUpdater: await updater.getAddress(),
    agent: agentAddress,
    maxNotionalUsd: opts.maxNotionalUsd ?? "50",
    maxPositionUsd: opts.maxPositionUsd ?? "100",
    maxSlippageBps: opts.maxSlippageBps ?? 100,
    maxTradesPerDay: opts.maxTradesPerDay ?? 10n,
    maxClosedMarketDriftBps: opts.maxClosedMarketDriftBps ?? 100,
  });

  const live = await readLiveOracle(56, NVDAB);
  await pushOracleUpdate({ signer: updater, covenantAddress, token: NVDAB, reading: { halted: false, priceUsd: live.priceUsd, sessionOpen: true, lastCloseUsd: live.lastCloseUsd } });

  return { provider, owner, updater, agent, agentAddress, covenantAddress, livePrice: live.priceUsd, liveReading: live };
}

/** A buy of `usd` dollars of NVDAB priced at `price`, minimum 0.5% below the quote. */
export function buyAt(price: bigint, usd: bigint) {
  const amountIn = usd;
  const quotedOut = (amountIn * 10n ** 18n) / price;
  return { amountIn, quotedOut, minOut: (quotedOut * 995n) / 1000n };
}
