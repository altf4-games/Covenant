import { expect } from "chai";
import { ethers } from "ethers";
import covenantArtifact from "../artifacts/contracts/Covenant.sol/Covenant.json" with { type: "json" };
import { ABI, fetchDecisionEvents, joinDecisions, resolveFromBlock, DEFAULT_LOOKBACK_BLOCKS } from "../status-page/lib.mjs";
import { startForkNode, setupCovenant, buyAt } from "../scripts/lib/local-fork.js";

// This suite exists because the bug it guards against was found by actually
// driving the status page in a real browser, not by writing a test first -
// see docs/partner-feedback/friction-log.md B16. Against a forked RPC,
// Hardhat's eth_getLogs hangs forever (no error, no timeout) the instant a
// queried range includes even the fork's own pinned starting block - only
// blocks mined *after* that point, locally, are safe. We can't fix
// Hardhat's fork provider from here, so what's actually under test is our
// own defense: status-page/lib.mjs's fetchDecisionEvents wraps the call in a
// real timeout. This suite proves two things with real data and a real
// spawned node, not mocks: the safe path returns real events correctly and
// fast, and the unsafe path fails fast and explains why instead of hanging
// the caller forever.
//
// Test order matters here in a way it normally shouldn't: triggering the
// hang once appears to leave the *entire node* degraded for every request
// after it, not just that one call - confirmed by hitting this for real
// while writing this suite (an earlier draft ran the boundary-crossing test
// before the safe-range one, and the safe-range one started failing too,
// on a call that had worked moments earlier). The boundary-crossing test
// below runs last for exactly that reason.
const RPC_PORT = 8990;
const NVDAB = "0x02fca66c1d1afb4e2a7884261eb00f63598a7436";
const IMPERSONATOR_BSTOCKS = "0x2F701b108a9aF5558960325A0239D0a13c2C4444";
const SWAP_TX = ethers.keccak256(ethers.toUtf8Bytes("stand-in swap hash"));

describe("status page: real decision reads and the fork-boundary hang", function () {
  this.timeout(180_000);

  let node: Awaited<ReturnType<typeof startForkNode>>;
  let covenant: ethers.Contract;
  let forkStartBlock: number;
  let latestBlockAfterSeed: number;

  before(async function () {
    node = await startForkNode(RPC_PORT);
    const provider = new ethers.JsonRpcProvider(node.rpcUrl);
    forkStartBlock = await provider.getBlockNumber();

    const env = await setupCovenant(node.rpcUrl);
    covenant = new ethers.Contract(env.covenantAddress, ABI, provider);
    const asAgent = new ethers.Contract(env.covenantAddress, covenantArtifact.abi, env.agent);
    const a = buyAt(env.livePrice, 10n ** 18n);

    // Three real decisions, all mined locally after the fork point: a
    // denial, an allowed trade that settles, and one that's cancelled.
    await (await asAgent.commit(0, IMPERSONATOR_BSTOCKS, a.amountIn, a.quotedOut, a.minOut, ethers.ZeroHash, ethers.ZeroHash)).wait();
    await (await asAgent.commit(0, NVDAB, a.amountIn, a.quotedOut, a.minOut, ethers.ZeroHash, ethers.ZeroHash)).wait();
    await (await asAgent.settle(2n, SWAP_TX, a.quotedOut, 3)).wait();
    await (await asAgent.commit(0, NVDAB, a.amountIn, a.quotedOut, a.minOut, ethers.ZeroHash, ethers.ZeroHash)).wait();
    await (await asAgent.cancel(3n)).wait();

    latestBlockAfterSeed = await provider.getBlockNumber();
  });

  after(function () {
    node?.stop();
  });

  it("returns real events fast when the range stays within locally-mined, post-fork blocks, joined per decision", async function () {
    // forkStartBlock itself still needs the remote lookup (it's the fork's
    // pinned upstream block); only blocks mined after it are safe.
    const fromBlock = forkStartBlock + 1;

    const start = Date.now();
    const events = await fetchDecisionEvents(covenant, { fromBlock, timeoutMs: 5_000 });
    const elapsedMs = Date.now() - start;
    expect(elapsedMs).to.be.lessThan(2_000);
    expect(events).to.have.length(5); // 3 commits, 1 settle, 1 cancel

    const decisions = joinDecisions(events);
    expect(decisions.map((d: any) => d.id)).to.deep.equal(["1", "2", "3"]);

    const [denied, settled, cancelled] = decisions as any[];
    expect(denied.commit.allowed).to.equal(false);
    expect(denied.commit.reason).to.equal("TokenNotAllowed");
    expect(denied.commit.token.toLowerCase()).to.equal(IMPERSONATOR_BSTOCKS.toLowerCase());

    expect(settled.commit.allowed).to.equal(true);
    expect(settled.settle.swapTxHash).to.equal(SWAP_TX);
    expect(settled.settle.executionMode).to.equal("aggregator");

    expect(cancelled.commit.allowed).to.equal(true);
    expect(cancelled.cancelled).to.equal(true);
    expect(cancelled.settle).to.equal(null);
  });

  it("resolveFromBlock defaults to a window that would itself cross the fork boundary on a fresh fork", function () {
    // Why the default needs the timeout: on a chain this young, even the
    // page's own DEFAULT_LOOKBACK_BLOCKS reaches past the fork point. That's
    // reasonable for a long-lived mainnet deployment; the timeout is what
    // makes it safe here.
    const defaultFromBlock = resolveFromBlock(undefined, latestBlockAfterSeed);
    expect(latestBlockAfterSeed - forkStartBlock).to.be.lessThan(DEFAULT_LOOKBACK_BLOCKS);
    expect(defaultFromBlock).to.be.lessThanOrEqual(forkStartBlock);
  });

  it("fails fast with a clear, actionable error when the range crosses the fork boundary, instead of hanging forever", async function () {
    // Runs last deliberately - see the comment at the top.
    const fromBlock = Math.max(0, forkStartBlock - 5);
    const start = Date.now();
    let caught: Error | undefined;
    try {
      await fetchDecisionEvents(covenant, { fromBlock, timeoutMs: 3_000 });
    } catch (error) {
      caught = error as Error;
    }
    const elapsedMs = Date.now() - start;

    expect(caught, "expected fetchDecisionEvents to reject instead of hanging or resolving").to.not.equal(undefined);
    expect(caught!.message).to.include("eth_getLogs timed out");
    expect(caught!.message).to.include("friction-log.md B16");
    expect(elapsedMs).to.be.lessThan(4_000);
  });
});
