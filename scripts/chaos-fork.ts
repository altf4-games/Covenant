/**
 * Chaos-fork demo (cross-hackathon-action-items.md #2, modeled on noyeet's
 * scripts/chaos-fork.sh from KeeperHub's Agents Onchain Hackathon).
 *
 * One command: spins up a real `hardhat node --fork` of BSC mainnet,
 * deploys Covenant with the real deploy script, posts the real live NVDAB
 * price, then commits trades built to break the mandate - an impersonator
 * token, a notional over the cap, a trade during a halt, a minimum
 * smuggled in behind an understated quote, a buy past the position cap,
 * and a stranger trying to commit at all - plus one legitimate trade.
 *
 * Covenant's commit doesn't revert on a denial; it records the refusal as
 * an event. So each result is re-read from the transaction's receipt by
 * scripts/judge.ts's verifyTx, the way a judge would, not printed from this
 * script's memory of what it sent.
 *
 * Usage:
 *   npm run chaos-fork
 */
import { ethers } from "ethers";
import covenantArtifact from "../artifacts/contracts/Covenant.sol/Covenant.json" with { type: "json" };
import { verifyTx } from "./judge.js";
import { startForkNode, setupCovenant, buyAt, BSC_FORK_URL } from "./lib/local-fork.js";
import { NVDAB } from "./deploy.js";

const RPC_PORT = 8993;
const IMPERSONATOR_BSTOCKS = "0x2F701b108a9aF5558960325A0239D0a13c2C4444"; // real, confirmed impersonator (verified-facts.md)
const E18 = 10n ** 18n;

async function commitAndVerify(label: string, rpcUrl: string, covenant: ethers.Contract, args: [number, string, bigint, bigint, bigint]) {
  const receipt = await (await covenant.commit(...args, ethers.ZeroHash, ethers.ZeroHash)).wait();
  const verified = await verifyTx(rpcUrl, await covenant.getAddress(), receipt.hash);
  console.log(`\n[${label}]`);
  console.log(`  tx:      ${receipt.hash}`);
  if (!verified.ok) {
    console.log(`  FAILED TO INDEPENDENTLY VERIFY: ${verified.detail}`);
    return null;
  }
  const decision = verified.events!.find((e) => e.kind === "commit");
  if (!decision || decision.kind !== "commit") return null;
  console.log(`  block:   ${verified.blockNumber}`);
  console.log(`  allowed: ${decision.allowed}`);
  console.log(`  reason:  ${decision.reason}`);
  console.log(`  amountIn=${decision.amountIn} minOut=${decision.minOut}`);
  return decision;
}

async function main() {
  console.log(`Forking BSC mainnet via ${BSC_FORK_URL}...`);
  const node = await startForkNode(RPC_PORT);
  process.on("exit", node.stop);

  try {
    // A deliberately tight mandate: NVDAB only, $2 per trade, a $3 position cap, 1% slippage.
    const env = await setupCovenant(node.rpcUrl, { maxNotionalUsd: "2", maxPositionUsd: "3", maxSlippageBps: 100 });
    console.log(`Deployed real Covenant at ${env.covenantAddress}`);
    console.log(`Mandate: NVDAB only, $2 per trade, $3 position cap, 1% slippage. Live NVDAB price: $${ethers.formatUnits(env.livePrice, 18)}`);

    const covenant = new ethers.Contract(env.covenantAddress, covenantArtifact.abi, env.agent);
    const asUpdater = new ethers.Contract(env.covenantAddress, covenantArtifact.abi, env.updater);
    const one = buyAt(env.livePrice, E18);

    console.log("\n--- Deliberately violating the mandate, on real deployed bytecode ---");

    await commitAndVerify("attempt: scam impersonator token (not allowlisted)", node.rpcUrl, covenant, [0, IMPERSONATOR_BSTOCKS, one.amountIn, one.quotedOut, one.minOut]);

    const big = buyAt(env.livePrice, 50n * E18);
    await commitAndVerify("attempt: $50, above the $2 per-trade cap", node.rpcUrl, covenant, [0, NVDAB, big.amountIn, big.quotedOut, big.minOut]);

    const fakeQuote = one.quotedOut / 10n;
    await commitAndVerify("attempt: understated quote to smuggle in a loose minimum", node.rpcUrl, covenant, [0, NVDAB, one.amountIn, fakeQuote, (fakeQuote * 995n) / 1000n]);

    await (await asUpdater.updateOracle(NVDAB, true, env.livePrice)).wait();
    await commitAndVerify("attempt: trade NVDAB while the oracle reports a halt", node.rpcUrl, covenant, [0, NVDAB, one.amountIn, one.quotedOut, one.minOut]);
    await (await asUpdater.updateOracle(NVDAB, false, env.livePrice)).wait();

    // The agent key holds no NVDAB on this fork, and there's no Binance
    // backend here to execute a swap, so a real NVDAB holder sends it some.
    // The holder is the contract that supplied the real Day-1 fill
    // (docs/evidence/day1-gate-swap.json), checked on 2026-09-25 to hold
    // ~86.7 NVDAB on mainnet.
    console.log("\n--- Position cap (Feature 3), read from the wallet's real balance ---");
    const holder = "0xc6448de0b0ae196e5602e349b8a1a1a7a7c10af7";
    // ~$1.69 held: +$2 crosses the $3 cap, +$1 stays under it. (An earlier
    // draft sent $3.38, already over the cap on its own, so the "legitimate"
    // trade below was correctly denied too - the contract was right, the
    // scenario wasn't.)
    const agentNvdab = await fundAgentWithRealNvdab(node.rpcUrl, env.agentAddress, (75n * E18) / 10_000n, holder);
    console.log(`  agent now really holds ${ethers.formatUnits(agentNvdab, 18)} NVDAB (~$${ethers.formatUnits((agentNvdab * env.livePrice) / E18, 18).slice(0, 5)})`);
    const buyTwo = buyAt(env.livePrice, 2n * E18);
    await commitAndVerify("attempt: $2 more NVDAB, which would pass the $3 position cap", node.rpcUrl, covenant, [0, NVDAB, buyTwo.amountIn, buyTwo.quotedOut, buyTwo.minOut]);

    console.log("\n[attempt: a stranger commits a trade under the owner's mandate]");
    const stranger = new ethers.Contract(env.covenantAddress, covenantArtifact.abi, ethers.Wallet.createRandom().connect(env.provider));
    try {
      await stranger.commit.staticCall(0, NVDAB, one.amountIn, one.quotedOut, one.minOut, ethers.ZeroHash, ethers.ZeroHash);
      console.log("  UNEXPECTED: the call did not revert");
    } catch (error: any) {
      console.log(`  reverted: ${covenant.interface.parseError(error.data)?.name ?? error.shortMessage}`);
    }

    console.log("\n--- For contrast: one legitimate trade, same contract, same mandate ---");
    await commitAndVerify("attempt: $1 of NVDAB, within every limit", node.rpcUrl, covenant, [0, NVDAB, one.amountIn, one.quotedOut, one.minOut]);

    console.log("\nEvery decision above was re-derived from a real transaction receipt by scripts/judge.ts's verifyTx.");
  } finally {
    node.stop();
  }
}

/** Moves real NVDAB to the agent from a real holder on the fork, and returns the agent's real balance. */
async function fundAgentWithRealNvdab(rpcUrl: string, agent: string, amount: bigint, holder: string): Promise<bigint> {
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const erc20 = ["function balanceOf(address) view returns (uint256)", "function transfer(address,uint256) returns (bool)"];
  const nvdab = new ethers.Contract(NVDAB, erc20, provider);
  if ((await nvdab.balanceOf(holder)) < amount) throw new Error(`holder ${holder} doesn't have ${amount} NVDAB on this fork`);
  await provider.send("hardhat_impersonateAccount", [holder]);
  await provider.send("hardhat_setBalance", [holder, "0xDE0B6B3A7640000"]);
  await (await nvdab.connect(new ethers.JsonRpcSigner(provider, holder)).getFunction("transfer")(agent, amount)).wait();
  await provider.send("hardhat_stopImpersonatingAccount", [holder]);
  return nvdab.balanceOf(agent);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
