import { expect } from "chai";
import { ethers } from "ethers";
import covenantArtifact from "../artifacts/contracts/Covenant.sol/Covenant.json" with { type: "json" };
import { verifyTx, runJudge, decodeCovenantLog, TOPICS } from "../scripts/judge.js";
import { startForkNode, setupCovenant, buyAt, isWeb3ApiGeoBlocked } from "../scripts/lib/local-fork.js";

// Real forked node, real Covenant deployed with the real deploy script,
// real commit/settle/cancel transactions from the agent key. judge.ts's job
// is re-deriving the truth from a raw receipt without trusting anything
// else, so it gets real receipts to check, the way a judge would hand it
// real mainnet hashes.
const RPC_PORT = 8992;
const NVDAB = "0x02fca66c1d1afb4e2a7884261eb00f63598a7436";
const IMPERSONATOR_BSTOCKS = "0x2F701b108a9aF5558960325A0239D0a13c2C4444";
const E18 = 10n ** 18n;
const SWAP_TX = ethers.keccak256(ethers.toUtf8Bytes("stand-in swap hash"));

describe("judge.ts (live, real transactions, independent re-derivation from real receipts)", function () {
  this.timeout(180_000);

  let node: Awaited<ReturnType<typeof startForkNode>>;
  let env: Awaited<ReturnType<typeof setupCovenant>>;
  let covenant: ethers.Contract;
  let allowedTx: string;
  let deniedTx: string;
  let settleTx: string;
  let cancelTx: string;
  let a: ReturnType<typeof buyAt>;

  before(async function () {
    node = await startForkNode(RPC_PORT);
    try {
      env = await setupCovenant(node.rpcUrl);
    } catch (err) {
      if (isWeb3ApiGeoBlocked(err)) return this.skip();
      throw err;
    }
    covenant = new ethers.Contract(env.covenantAddress, covenantArtifact.abi, env.agent);
    a = buyAt(env.livePrice, E18);
    const quoteRef = ethers.keccak256(ethers.toUtf8Bytes("real quote json"));

    allowedTx = (await (await covenant.commit(0, NVDAB, a.amountIn, a.quotedOut, a.minOut, quoteRef, ethers.ZeroHash)).wait()).hash;
    settleTx = (await (await covenant.settle(1n, SWAP_TX, a.quotedOut, 3)).wait()).hash;
    deniedTx = (await (await covenant.commit(0, IMPERSONATOR_BSTOCKS, a.amountIn, a.quotedOut, a.minOut, quoteRef, ethers.ZeroHash)).wait()).hash;
    await (await covenant.commit(0, NVDAB, a.amountIn, a.quotedOut, a.minOut, quoteRef, ethers.ZeroHash)).wait();
    cancelTx = (await (await covenant.cancel(3n)).wait()).hash;
  });

  after(function () {
    node?.stop();
  });

  it("the hardcoded topic hashes match the compiled ABI", function () {
    const iface = new ethers.Interface(covenantArtifact.abi);
    expect(TOPICS.DecisionCommitted).to.equal(iface.getEvent("DecisionCommitted")!.topicHash);
    expect(TOPICS.DecisionSettled).to.equal(iface.getEvent("DecisionSettled")!.topicHash);
    expect(TOPICS.DecisionCancelled).to.equal(iface.getEvent("DecisionCancelled")!.topicHash);
  });

  it("decodes a real allowed commit, field for field identical to ethers' own event parsing", async function () {
    const result = await verifyTx(node.rpcUrl, env.covenantAddress, allowedTx);
    expect(result.ok).to.equal(true);
    const decoded = result.events![0];
    expect(decoded.kind).to.equal("commit");

    const receipt = await env.provider.getTransactionReceipt(allowedTx);
    const theirs = covenant.interface.parseLog(receipt!.logs[0])!.args;
    if (decoded.kind !== "commit") throw new Error("unreachable");
    expect(decoded.id).to.equal(theirs.id.toString());
    expect(decoded.token.toLowerCase()).to.equal(theirs.token.toLowerCase());
    expect(decoded.side).to.equal("buy");
    expect(decoded.allowed).to.equal(theirs.allowed);
    expect(decoded.reason).to.equal("None");
    expect(decoded.amountIn).to.equal(theirs.amountIn.toString());
    expect(decoded.quotedOut).to.equal(theirs.quotedOut.toString());
    expect(decoded.minOut).to.equal(theirs.minOut.toString());
    expect(decoded.quoteRef).to.equal(theirs.quoteRef);
    expect(decoded.researchRef).to.equal(theirs.researchRef);
    expect(decoded.expiresAt).to.equal(Number(theirs.expiresAt));
  });

  it("decodes a real denied commit with its real reason", async function () {
    const result = await verifyTx(node.rpcUrl, env.covenantAddress, deniedTx);
    const decoded = result.events![0];
    if (decoded.kind !== "commit") throw new Error("expected a commit");
    expect(decoded.allowed).to.equal(false);
    expect(decoded.reason).to.equal("TokenNotAllowed");
    expect(decoded.token.toLowerCase()).to.equal(IMPERSONATOR_BSTOCKS.toLowerCase());
  });

  it("decodes a real settle and a real cancel", async function () {
    const settled = (await verifyTx(node.rpcUrl, env.covenantAddress, settleTx)).events![0];
    if (settled.kind !== "settle") throw new Error("expected a settle");
    expect(settled.id).to.equal("1");
    expect(settled.swapTxHash).to.equal(SWAP_TX);
    expect(settled.amountOut).to.equal(a.quotedOut.toString());
    expect(settled.executionMode).to.equal("aggregator");
    expect(settled.belowMin).to.equal(false);

    const cancelled = (await verifyTx(node.rpcUrl, env.covenantAddress, cancelTx)).events![0];
    expect(cancelled).to.deep.equal({ kind: "cancel", id: "3" });
  });

  it("reports a real failure, not a false pass, for a hash never mined and for a receipt from another contract", async function () {
    const never = await verifyTx(node.rpcUrl, env.covenantAddress, "0x" + "ab".repeat(32));
    expect(never.ok).to.equal(false);
    expect(never.detail).to.include("no receipt found");

    // A real receipt, but checked against the wrong contract address.
    const wrong = await verifyTx(node.rpcUrl, "0x000000000000000000000000000000000000dEaD", allowedTx);
    expect(wrong.ok).to.equal(false);
    expect(wrong.detail).to.include("no Covenant decision event");
  });

  it("ignores logs that aren't Covenant decision events", function () {
    expect(decodeCovenantLog({ address: env.covenantAddress, topics: [ethers.ZeroHash], data: "0x" })).to.equal(null);
  });

  it("runJudge reads the live mandate and verifies every listed transaction", async function () {
    const { mandate, results, allVerified } = await runJudge(node.rpcUrl, env.covenantAddress, [allowedTx, settleTx, deniedTx, cancelTx]);
    expect(mandate.active).to.equal(true);
    expect(mandate.maxNotionalPerTradeUsd).to.equal((50n * E18).toString());
    expect(results).to.have.length(4);
    expect(allVerified).to.equal(true);
  });

  it("falls back past a genuinely dead RPC instead of failing the whole run", async function () {
    const { allVerified } = await runJudge(["http://127.0.0.1:1", node.rpcUrl], env.covenantAddress, [allowedTx]);
    expect(allVerified).to.equal(true);
  });
});
