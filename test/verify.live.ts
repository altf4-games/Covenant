import { expect } from "chai";
import { ethers } from "ethers";
import covenantArtifact from "../artifacts/contracts/Covenant.sol/Covenant.json" with { type: "json" };
import { reconcile } from "../scripts/verify.js";
import { startForkNode, setupCovenant } from "../scripts/lib/local-fork.js";

// Real forked node, Covenant deployed with the real deploy script, and real
// swaps against live PancakeSwap liquidity from the agent key (on mainnet
// the swap is `baw market-order swap`; on a fork there's no Binance backend,
// so PancakeSwap V3 stands in). Quotes come from the real QuoterV2. Every
// verdict below is reconcile() reading real transfers back from chain.
const RPC_PORT = 8997;
const NVDAB = "0x02fca66c1d1afb4e2a7884261eb00f63598a7436";
const USDT = "0x55d398326f99059fF775485246999027B3197955";
const ROUTER = "0x1b81D678ffb9C0263b24A97847620C99d213eB14";
const QUOTER = "0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997";
const USDT_WHALE = "0xF977814e90dA44bFA03b6295A0616a897441aceC";
const FEE = 2500;
const E18 = 10n ** 18n;
const TRANSFER = ethers.id("Transfer(address,address,uint256)");

const ERC20 = ["function approve(address,uint256) returns (bool)", "function transfer(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"];
const ROUTER_ABI = [
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
];
const QUOTER_ABI = [
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160, uint32, uint256)",
];

describe("verify.ts (live, real swaps, real reconciliation)", function () {
  this.timeout(360_000);

  let node: Awaited<ReturnType<typeof startForkNode>>;
  let env: Awaited<ReturnType<typeof setupCovenant>>;
  let covenant: ethers.Contract;
  let fromBlock: number;
  let cleanUpTo: number;
  const tx: Record<string, string> = {};

  async function quote(tokenIn: string, tokenOut: string, amountIn: bigint): Promise<bigint> {
    const quoter = new ethers.Contract(QUOTER, QUOTER_ABI, env.provider);
    const [out] = await quoter.quoteExactInputSingle.staticCall({ tokenIn, tokenOut, amountIn, fee: FEE, sqrtPriceLimitX96: 0n });
    return out;
  }

  /** A real swap from the agent; returns its hash and what really arrived, read from the receipt's Transfer log. */
  async function swap(tokenIn: string, tokenOut: string, amountIn: bigint, minOut: bigint) {
    await (await new ethers.Contract(tokenIn, ERC20, env.agent).approve(ROUTER, amountIn)).wait();
    // Raw eth_getBlockByNumber, not ethers' getBlock("latest"): after
    // tx.wait() polling, ethers resolves "latest" to its own cached block
    // number. Measured here: 709s stale right after an evm_increaseTime,
    // which made the router reject the late swap as "Transaction too old".
    const rawLatest = Number(BigInt((await env.provider.send("eth_getBlockByNumber", ["latest", false])).timestamp));
    const receipt = await (
      await new ethers.Contract(ROUTER, ROUTER_ABI, env.agent).exactInputSingle({
        tokenIn, tokenOut, fee: FEE, recipient: env.agentAddress, deadline: rawLatest + 3600, amountIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n,
      })
    ).wait();
    const toAgent = "0x" + env.agentAddress.toLowerCase().slice(2).padStart(64, "0");
    const received = receipt!.logs
      .filter((l) => l.address.toLowerCase() === tokenOut.toLowerCase() && l.topics[0] === TRANSFER && l.topics[2].toLowerCase() === toAgent)
      .reduce((sum, l) => sum + BigInt(l.data), 0n);
    return { hash: receipt!.hash, received };
  }

  async function commit(side: number, amountIn: bigint, quotedOut: bigint, minOut: bigint): Promise<bigint> {
    const receipt = await (await covenant.commit(side, NVDAB, amountIn, quotedOut, minOut, ethers.ZeroHash, ethers.ZeroHash)).wait();
    const ev = receipt!.logs.map((l: any) => covenant.interface.parseLog(l)).find((p: any) => p?.name === "DecisionCommitted")!;
    expect(ev.args.allowed, `commit denied: reason ${ev.args.reason}`).to.equal(true);
    return ev.args.id;
  }

  before(async function () {
    node = await startForkNode(RPC_PORT);
    fromBlock = (await new ethers.JsonRpcProvider(node.rpcUrl).getBlockNumber()) + 1; // after the fork point (friction-log B16)
    // A 5% slippage bound: the pool's real price can sit a little away from
    // the RWA endpoint's, and this suite is about reconciliation.
    env = await setupCovenant(node.rpcUrl, { maxSlippageBps: 500 });
    covenant = new ethers.Contract(env.covenantAddress, covenantArtifact.abi, env.agent);

    // Real USDT for the agent, from a real holder.
    await env.provider.send("hardhat_impersonateAccount", [USDT_WHALE]);
    await env.provider.send("hardhat_setBalance", [USDT_WHALE, "0xDE0B6B3A7640000"]);
    await (await new ethers.Contract(USDT, ERC20, new ethers.JsonRpcSigner(env.provider, USDT_WHALE)).transfer(env.agentAddress, 10n * E18)).wait();
    await env.provider.send("hardhat_stopImpersonatingAccount", [USDT_WHALE]);

    // 1. An honest buy: commit, swap, settle with the real Transfer amount.
    let q = await quote(USDT, NVDAB, E18);
    let id = await commit(0, E18, q, (q * 995n) / 1000n);
    let s = await swap(USDT, NVDAB, E18, (q * 995n) / 1000n);
    await (await covenant.settle(id, s.hash, s.received, 1)).wait();
    tx.honestBuy = s.hash;

    // 2. An honest sell of half of it.
    const half = s.received / 2n;
    q = await quote(NVDAB, USDT, half);
    id = await commit(1, half, q, (q * 995n) / 1000n);
    s = await swap(NVDAB, USDT, half, (q * 995n) / 1000n);
    await (await covenant.settle(id, s.hash, s.received, 1)).wait();
    tx.honestSell = s.hash;
    cleanUpTo = s.hash ? Number((await env.provider.getTransactionReceipt(s.hash))!.blockNumber) + 1 : 0;

    // 3. A bypass: a real swap with no decision at all.
    q = await quote(USDT, NVDAB, E18);
    tx.bypass = (await swap(USDT, NVDAB, E18, (q * 995n) / 1000n)).hash;

    // 4. A false settle: an approved decision settled against a hash that moved nothing.
    q = await quote(USDT, NVDAB, E18);
    id = await commit(0, E18, q, (q * 995n) / 1000n);
    tx.falseSettle = ethers.keccak256(ethers.toUtf8Bytes("a swap that never happened"));
    await (await covenant.settle(id, tx.falseSettle, q, 1)).wait();

    // 5. Settling with Binance's share-unit fill instead of the real
    //    Transfer amount (friction-log C17): off by NVDAB's multiplier.
    q = await quote(USDT, NVDAB, E18);
    id = await commit(0, E18, q, (q * 995n) / 1000n);
    s = await swap(USDT, NVDAB, E18, (q * 995n) / 1000n);
    await (await covenant.settle(id, s.hash, (s.received * 1_000_778n) / 1_000_000n, 1)).wait();
    tx.shareUnits = s.hash;

    // 6. A swap after the decision expired (TTL 600s), then settled anyway.
    q = await quote(USDT, NVDAB, E18);
    id = await commit(0, E18, q, (q * 990n) / 1000n);
    await env.provider.send("evm_increaseTime", [700]);
    await env.provider.send("evm_mine", []);
    s = await swap(USDT, NVDAB, E18, (q * 990n) / 1000n);
    await (await covenant.settle(id, s.hash, s.received, 1)).wait();
    tx.late = s.hash;
  });

  after(function () {
    node?.stop();
  });

  it("is clean while every trade maps to an approved, honestly settled decision", async function () {
    const report = await reconcile({ rpcUrls: [node.rpcUrl], covenantAddress: env.covenantAddress, fromBlock, toBlock: cleanUpTo });
    expect(report.violations).to.deep.equal([]);
    expect(report.clean).to.equal(true);
    expect(report.matched.map((m) => m.txHash)).to.have.members([tx.honestBuy.toLowerCase(), tx.honestSell.toLowerCase()]);
    expect(report.matched.find((m) => m.txHash === tx.honestSell.toLowerCase())!.side).to.equal("sell");
  });

  it("flags every kind of problem it's supposed to, and nothing else", async function () {
    const report = await reconcile({ rpcUrls: [node.rpcUrl], covenantAddress: env.covenantAddress, fromBlock });
    const byKind = (kind: string) => report.violations.filter((v) => v.kind === kind).map((v) => v.txHash!.toLowerCase());

    expect(byKind("UNMATCHED_TRADE")).to.deep.equal([tx.bypass.toLowerCase()]);
    expect(byKind("FALSE_SETTLE")).to.deep.equal([tx.falseSettle.toLowerCase()]);
    expect(byKind("AMOUNT_MISMATCH")).to.deep.equal([tx.shareUnits.toLowerCase()]);
    expect(byKind("SWAP_AFTER_EXPIRY")).to.deep.equal([tx.late.toLowerCase()]);
    expect(report.violations).to.have.length(4);
    expect(report.clean).to.equal(false);

    // The two honest trades still reconcile in the full run.
    expect(report.matched.map((m) => m.txHash)).to.have.members([tx.honestBuy.toLowerCase(), tx.honestSell.toLowerCase()]);
    expect(report.trades).to.equal(5);
  });
});
