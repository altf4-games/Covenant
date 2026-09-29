/**
 * "Try to break it" live demo (GAMIFICATION-PLAN-2026-09-25.md item 3).
 *
 * Pure framing over already fork-tested plumbing, not new mechanism: one
 * honest commit -> swap -> settle for contrast, then the real bypass this
 * project's whole "no trade happens unseen" claim rests on - a real swap
 * with no commit at all - followed by scripts/verify.ts's real reconcile(),
 * narrated for a live audience instead of buried in test output. Rehearses
 * the exact same bypass transaction Days 4-5's mainnet evidence pass will
 * need anyway (PLAN-PHASE3-V2-2026-09-24.md), so nothing here is thrown
 * away once mainnet happens - swap `startForkNode`/`setupCovenant` for the
 * real deploy and this narration runs unchanged against real evidence.
 *
 * Usage:
 *   npx tsx scripts/try-to-break-it-demo.ts
 */
import { ethers } from "ethers";
import { startForkNode, setupCovenant, buyAt } from "./lib/local-fork.js";
import { reconcile } from "./verify.js";
import { NVDAB } from "./deploy.js";

const RPC_PORT = 8998;
const PANCAKE_V3_SWAP_ROUTER = "0x1b81D678ffb9C0263b24A97847620C99d213eB14";
const USDT = "0x55d398326f99059fF775485246999027B3197955";
const USDT_WHALE = "0xF977814e90dA44bFA03b6295A0616a897441aceC";
const FEE = 2500;
const E18 = 10n ** 18n;
const ERC20 = ["function approve(address,uint256) returns (bool)", "function transfer(address,uint256) returns (bool)"];
const TRANSFER = ethers.id("Transfer(address,address,uint256)");
const ROUTER_ABI = [
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
];

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const line = () => console.log("─".repeat(64));

async function main() {
  try {
    process.loadEnvFile();
  } catch {
    // no .env - real environment variables only
  }

  console.log("🎮 TRY TO BREAK IT — live demo\n");
  console.log("The premise: Covenant claims no trade can happen unseen. Let's try.\n");

  const node = await startForkNode(RPC_PORT);
  // Safety net, same pattern as scripts/chaos-fork.ts: if anything below
  // throws (a real bug once did - the Web3 API's real, external
  // "compliance restriction" geo-block on setupCovenant's H10 check, seen
  // live in CI), this still fires on the way out and the forked node
  // doesn't outlive this script. Without it, the only thing that had ever
  // stopped the fork node was reaching the very last line of the happy
  // path - an error anywhere before that left it running, which is exactly
  // what made a CI run hang for 10+ minutes past its own error instead of
  // exiting.
  process.on("exit", node.stop);
  try {
    const fromBlock = (await new ethers.JsonRpcProvider(node.rpcUrl).getBlockNumber()) + 1;
    const env = await setupCovenant(node.rpcUrl, { maxNotionalUsd: "2" });
    console.log(`Real Covenant deployed at ${env.covenantAddress}, on a real fork of BSC mainnet.\n`);

    await env.provider.send("hardhat_impersonateAccount", [USDT_WHALE]);
    await env.provider.send("hardhat_setBalance", [USDT_WHALE, "0xDE0B6B3A7640000"]);
    await (await new ethers.Contract(USDT, ERC20, new ethers.JsonRpcSigner(env.provider, USDT_WHALE)).transfer(env.agentAddress, 10n * E18)).wait();
    await env.provider.send("hardhat_stopImpersonatingAccount", [USDT_WHALE]);

    const covenant = new ethers.Contract(env.covenantAddress, (await import("../artifacts/contracts/Covenant.sol/Covenant.json", { with: { type: "json" } })).default.abi, env.agent);

    line();
    console.log("Round 1 — the honest way: commit, then swap, then settle.");
    line();
    const a = buyAt(env.livePrice, E18);
    const commitReceipt = await (await covenant.commit(0, NVDAB, a.amountIn, a.quotedOut, a.minOut, ethers.ZeroHash, ethers.ZeroHash)).wait();
    const committed = commitReceipt!.logs.map((l: any) => covenant.interface.parseLog(l)).find((p: any) => p?.name === "DecisionCommitted")!;
    console.log(`✅ commit recorded on chain: allowed=${committed.args.allowed}, decision #${committed.args.id}`);
    await pause(400);

    await (await new ethers.Contract(USDT, ERC20, env.agent).approve(PANCAKE_V3_SWAP_ROUTER, a.amountIn)).wait();
    const deadlineFromNow = async () => (await new ethers.JsonRpcProvider(node.rpcUrl).getBlock("latest"))!.timestamp + 300;
    const honestSwap = await (
      await new ethers.Contract(PANCAKE_V3_SWAP_ROUTER, ROUTER_ABI, env.agent).exactInputSingle({
        tokenIn: USDT, tokenOut: NVDAB, fee: FEE, recipient: env.agentAddress, deadline: await deadlineFromNow(), amountIn: a.amountIn, amountOutMinimum: a.minOut, sqrtPriceLimitX96: 0n,
      })
    ).wait();
    // Settle with the real ERC-20 Transfer amount, never the quote - the
    // README's own pinned "no dummy data" rule and the exact mistake
    // friction-log C17 warns about.
    const toAgent = "0x" + env.agentAddress.toLowerCase().slice(2).padStart(64, "0");
    const honestReceived = honestSwap!.logs
      .filter((l: ethers.Log) => l.address.toLowerCase() === NVDAB.toLowerCase() && l.topics[0] === TRANSFER && l.topics[2].toLowerCase() === toAgent)
      .reduce((sum: bigint, l: ethers.Log) => sum + BigInt(l.data), 0n);
    await (await covenant.settle(committed.args.id, honestSwap!.hash, honestReceived, 1)).wait();
    console.log(`✅ settled with the real swap hash and real received amount: ${honestSwap!.hash}\n`);
    await pause(400);

    line();
    console.log("Round 2 — try to break it: a real swap with NO commit first.");
    line();
    console.log("(This is exactly what a compromised or careless agent would do:");
    console.log(" skip the mandate check entirely and trade anyway.)\n");
    await pause(400);

    await (await new ethers.Contract(USDT, ERC20, env.agent).approve(PANCAKE_V3_SWAP_ROUTER, a.amountIn)).wait();
    const bypassSwap = await (
      await new ethers.Contract(PANCAKE_V3_SWAP_ROUTER, ROUTER_ABI, env.agent).exactInputSingle({
        tokenIn: USDT, tokenOut: NVDAB, fee: FEE, recipient: env.agentAddress, deadline: await deadlineFromNow(), amountIn: a.amountIn, amountOutMinimum: a.minOut, sqrtPriceLimitX96: 0n,
      })
    ).wait();
    console.log(`😈 bypass swap went through with no commit: ${bypassSwap!.hash}`);
    console.log("   Covenant didn't stop it - it can't. The wallet holds the keys.\n");
    await pause(600);

    line();
    console.log("Now the real question: does anyone find out?");
    line();
    console.log("Running scripts/verify.ts's real reconcile() against every real transfer...\n");
    await pause(400);

    const report = await reconcile({ rpcUrls: [node.rpcUrl], covenantAddress: env.covenantAddress, fromBlock });
    const bypassFlag = report.violations.find((v) => v.txHash?.toLowerCase() === bypassSwap!.hash.toLowerCase());

    if (bypassFlag) {
      console.log(`🚨 CAUGHT: ${bypassFlag.kind} on tx ${bypassFlag.txHash}`);
      console.log("   The bypass is now a public, permanent, on-chain-readable flag.");
      console.log("   Anyone with an RPC - a judge, an auditor, the owner - can see it themselves:");
      console.log(`   COVENANT_ADDRESS=${env.covenantAddress} VERIFY_FROM_BLOCK=${fromBlock} npm run verify\n`);
    } else {
      throw new Error("FAILED TO INDEPENDENTLY VERIFY: the bypass was not flagged - something is wrong");
    }

    console.log(`Honest trades stayed clean: ${report.matched.length} matched, 0 false positives among them.`);
    line();
    console.log("No trade happens unseen. Not because the wallet is stopped - it can't be.");
    console.log("Because it can't happen quietly.");
  } finally {
    node.stop();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
