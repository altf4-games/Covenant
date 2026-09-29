import { expect } from "chai";
import { ethers } from "ethers";
import covenantArtifact from "../artifacts/contracts/Covenant.sol/Covenant.json" with { type: "json" };
import { COMMANDS } from "../skills/covenant-mandate/scripts/cli.mjs";
import { startForkNode, setupCovenant, buyAt, isWeb3ApiGeoBlocked } from "../scripts/lib/local-fork.js";

// The skill's cli.mjs is a standalone, zero-dep script meant to run against
// a real HTTP RPC endpoint exactly like it would in production - not against
// Hardhat's in-process EDR provider, which isn't reachable over HTTP from
// another process. So this suite spawns a real `hardhat node --fork ...`
// child process, deploys a real Covenant to it with the real deploy script,
// and drives the skill's own exported command functions against it.
const RPC_PORT = 8989;
const NVDAB = "0x02fca66c1d1afb4e2a7884261eb00f63598a7436";
const IMPERSONATOR_BSTOCKS = "0x2F701b108a9aF5558960325A0239D0a13c2C4444";
const E18 = 10n ** 18n;

describe("covenant-mandate skill CLI (live, against a real spawned JSON-RPC node)", function () {
  this.timeout(180_000);

  let node: Awaited<ReturnType<typeof startForkNode>>;
  let env: Awaited<ReturnType<typeof setupCovenant>>;
  let rpcUrl: string;

  before(async function () {
    node = await startForkNode(RPC_PORT);
    rpcUrl = node.rpcUrl;
    try {
      env = await setupCovenant(rpcUrl, { maxNotionalUsd: "50" });
    } catch (err) {
      if (isWeb3ApiGeoBlocked(err)) return this.skip();
      throw err;
    }
  });

  after(function () {
    node?.stop();
  });

  describe("resolve (real, live ticker data)", function () {
    it("refuses to guess when a ticker spans multiple providers (real NVDA)", async function () {
      try {
        await COMMANDS.resolve({ ticker: "NVDA" });
        expect.fail("expected resolve to refuse an ambiguous ticker");
      } catch (err: any) {
        expect(err.exitCode).to.equal(2);
        expect(err.matches.length).to.be.greaterThan(1);
      }
    });

    it("resolves DRAM to the real bStock address when provider is given (matches verified-facts.md)", async function () {
      const { resolved } = await COMMANDS.resolve({ ticker: "DRAM", provider: "bstock" });
      expect(resolved.contractAddress.toLowerCase()).to.equal("0x93862d63fd9fd488b1328e9b47717d75e994a84b");
      expect(resolved.chainId).to.equal("56");
    });

    it("defaults to BSC only when that alone disambiguates, never silently picks another chain", async function () {
      // Regression test for a real bug caught while building this skill: providing
      // provider=ondo alone used to silently return the Ethereum-mainnet address
      // instead of BSC's, because only the provider axis was checked for
      // ambiguity, not the chain axis. NVDA-on-Ondo exists on Ethereum, BSC,
      // and Solana simultaneously - this must resolve to BSC (56), not chain 1.
      const { resolved } = await COMMANDS.resolve({ ticker: "NVDA", provider: "ondo" });
      expect(resolved.chainId).to.equal("56");
      expect(resolved.contractAddress.toLowerCase()).to.equal("0xa9ee28c80f960b889dfbd1902055218cba016f75");
    });
  });

  describe("survey (real ticker data, real on-chain verification against Binance's own reported figures)", function () {
    it("shows a real, nearly-idle xStock as a sliver of its bStock's on-chain activity, however large Binance's reported volume", async function () {
      // Binance's own API reports a large tokenInfo.volume24h for TSLAx even
      // though real eth_getLogs against real BSC state finds almost no
      // Transfer events for it (friction-log.md B17). survey trusts the
      // on-chain count, not the reported figure. Over the original 3000-block
      // window that count was 0 ("dead"); the wider window survey now scans
      // (red-team round 5: 3000 blocks is only minutes on BSC) finds a handful,
      // so the stable, honest assertion is the ratio, not a label.
      const result: any = await COMMANDS.survey({ ticker: "TSLA" });
      const xstock = result.providers.find((p: any) => p.provider === "xstock");
      const bstock = result.providers.find((p: any) => p.provider === "bstock");
      expect(xstock.onChainVerified.transferCount).to.be.lessThan(bstock.onChainVerified.transferCount / 10);
      expect(xstock.onChainVerified.blocksScanned).to.be.greaterThan(3000);
      expect(xstock.contractAddress.toLowerCase()).to.equal("0x8ad3c73f833d3f9a523ab01476625f269aeb7cf0");
    });

    it("reports real liquid providers as live, with real, differentiated transfer counts", async function () {
      const result: any = await COMMANDS.survey({ ticker: "NVDA" });
      const bstock = result.providers.find((p: any) => p.provider === "bstock");
      const xstock = result.providers.find((p: any) => p.provider === "xstock");
      expect(bstock.status).to.equal("live");
      expect(bstock.onChainVerified.transferCount).to.be.greaterThan(0);
      // Real, not staged, from the same live run this test asserts on: bStock's
      // NVDAB is dramatically more liquid than xStock's NVDAx in the exact same
      // window - the whole point of surfacing the real count, not just a label.
      expect(bstock.onChainVerified.transferCount).to.be.greaterThan(xstock.onChainVerified.transferCount);
    });

    it("reports GME's real split: bstock is the dominant venue, xstock stays dead", async function () {
      // Originally written with ondo also asserted dead - re-verified live
      // on 2026-09-22 and found ondo's GMEon had picked up real Transfer
      // activity (3 events / 3000 blocks) that didn't exist when this test
      // was first written. That's a genuine on-chain state change, not a
      // flaky test: liveness is a moving target, not something safe to
      // pin to one point-in-time snapshot. Keep the assertion on what's
      // actually stable - bstock dominates, xstock stays dead - and check
      // ondo's own reported fields are internally consistent instead of
      // hardcoding a liveness label that can flip under us.
      const result: any = await COMMANDS.survey({ ticker: "GME" });
      const byProvider = Object.fromEntries(result.providers.map((p: any) => [p.provider, p]));
      expect(byProvider.bstock.status).to.equal("live");
      expect(byProvider.bstock.onChainVerified.transferCount).to.be.greaterThan(0);
      expect(byProvider.xstock.status).to.equal("dead");
      expect(byProvider.xstock.onChainVerified.transferCount).to.equal(0);
      expect(byProvider.ondo.status).to.equal(
        byProvider.ondo.onChainVerified.transferCount > 0 ? "live" : "dead",
      );
      expect(byProvider.bstock.onChainVerified.transferCount).to.be.greaterThan(
        byProvider.ondo.onChainVerified.transferCount,
      );
    });
  });

  describe("check (real read calls against a real deployed Covenant)", function () {
    it("reports the real allowed decision for a $1 NVDAB buy at the live price", async function () {
      const a = buyAt(env.livePrice, E18);
      const result = await COMMANDS.check({
        rpcUrl,
        covenantAddress: env.covenantAddress,
        side: "buy",
        tokenAddress: NVDAB,
        amountIn: a.amountIn.toString(),
        quotedOut: a.quotedOut.toString(),
        minOut: a.minOut.toString(),
      });
      expect(result.token.allowed).to.equal(true);
      expect(result.oracle.priceUsd).to.equal(env.livePrice.toString());
      expect(result.mandate.decisionOpen).to.equal(false);
      expect(result.decision.allowed).to.equal(true);
      expect(result.decision.reason).to.equal("None");
    });

    it("reports NotionalExceeded for a real amount above the real mandate cap", async function () {
      const a = buyAt(env.livePrice, 999n * E18);
      const result = await COMMANDS.check({ rpcUrl, covenantAddress: env.covenantAddress, side: "buy", tokenAddress: NVDAB, amountIn: a.amountIn.toString(), quotedOut: a.quotedOut.toString(), minOut: a.minOut.toString() });
      expect(result.decision.reason).to.equal("NotionalExceeded");
    });

    it("reports SlippageTooLoose for the amountOutMinimum=\"1\" pattern the old skill docs used (red-team H5)", async function () {
      const a = buyAt(env.livePrice, E18);
      const result = await COMMANDS.check({ rpcUrl, covenantAddress: env.covenantAddress, side: "buy", tokenAddress: NVDAB, amountIn: a.amountIn.toString(), quotedOut: a.quotedOut.toString(), minOut: "1" });
      expect(result.decision.reason).to.equal("SlippageTooLoose");
    });

    it("reports TokenNotAllowed for the real verified impersonator address", async function () {
      const result = await COMMANDS.check({ rpcUrl, covenantAddress: env.covenantAddress, side: "buy", tokenAddress: IMPERSONATOR_BSTOCKS, amountIn: "1", quotedOut: "1", minOut: "1" });
      expect(result.token.allowed).to.equal(false);
      expect(result.decision.reason).to.equal("TokenNotAllowed");
    });

    it("rejects a side that isn't buy or sell instead of guessing", async function () {
      try {
        await COMMANDS.check({ rpcUrl, covenantAddress: env.covenantAddress, side: "short" as never, tokenAddress: NVDAB, amountIn: "1", quotedOut: "1", minOut: "1" });
        expect.fail("expected check to reject an unknown side");
      } catch (err: any) {
        expect(err.message).to.include("buy");
      }
    });
  });

  describe("calldata builders: byte-identical to ethers, and accepted by the real contract", function () {
    const iface = new ethers.Interface(covenantArtifact.abi);
    const quoteRef = ethers.keccak256(ethers.toUtf8Bytes("real quote json"));

    it("build-commit-calldata matches ethers' own encoder", async function () {
      const a = buyAt(env.livePrice, E18);
      const { calldata } = await COMMANDS.buildCommitCalldata({
        side: "buy",
        tokenAddress: NVDAB,
        amountIn: a.amountIn.toString(),
        quotedOut: a.quotedOut.toString(),
        minOut: a.minOut.toString(),
        quoteRef,
      });
      expect(calldata).to.equal(iface.encodeFunctionData("commit", [0, NVDAB, a.amountIn, a.quotedOut, a.minOut, quoteRef, ethers.ZeroHash]));
    });

    it("the skill's own commit, settle and cancel calldata drive the real contract end to end", async function () {
      // The same bytes `baw contract-call --inputData` would carry on
      // mainnet, sent here as real transactions from the agent key.
      const covenant = new ethers.Contract(env.covenantAddress, covenantArtifact.abi, env.provider);
      const a = buyAt(env.livePrice, E18);

      const commitData = (await COMMANDS.buildCommitCalldata({ side: "buy", tokenAddress: NVDAB, amountIn: a.amountIn.toString(), quotedOut: a.quotedOut.toString(), minOut: a.minOut.toString(), quoteRef })).calldata;
      const commitReceipt = await (await env.agent.sendTransaction({ to: env.covenantAddress, data: commitData })).wait();
      const committed = commitReceipt!.logs.map((l) => covenant.interface.parseLog(l)).find((p) => p?.name === "DecisionCommitted")!;
      expect(committed.args.allowed).to.equal(true);
      const id = committed.args.id;

      const swapTxHash = ethers.keccak256(ethers.toUtf8Bytes("stand-in swap hash for this calldata test"));
      const settleData = (await COMMANDS.buildSettleCalldata({ decisionId: id.toString(), swapTxHash, amountOut: a.quotedOut.toString(), executionMode: "rfq" })).calldata;
      expect(settleData).to.equal(iface.encodeFunctionData("settle", [id, swapTxHash, a.quotedOut, 2]));
      await (await env.agent.sendTransaction({ to: env.covenantAddress, data: settleData })).wait();
      const stored = await covenant.getDecision(id);
      expect(stored.settled).to.equal(true);
      expect(stored.executionMode).to.equal(2n);

      // A second decision, then abandoned with the skill's cancel calldata.
      const second = await (await env.agent.sendTransaction({ to: env.covenantAddress, data: commitData })).wait();
      const secondId = second!.logs.map((l) => covenant.interface.parseLog(l)).find((p) => p?.name === "DecisionCommitted")!.args.id;
      const cancelData = (await COMMANDS.buildCancelCalldata({ decisionId: secondId.toString() })).calldata;
      await (await env.agent.sendTransaction({ to: env.covenantAddress, data: cancelData })).wait();
      expect((await covenant.getDecision(secondId)).cancelled).to.equal(true);
      expect(await covenant.openDecisionId()).to.equal(0n);
    });

    it("rejects a malformed 32-byte reference and an unknown execution mode", async function () {
      try {
        await COMMANDS.buildCommitCalldata({ side: "buy", tokenAddress: NVDAB, amountIn: "1", quotedOut: "1", minOut: "1", quoteRef: "0x1234" });
        expect.fail("expected a short quoteRef to be rejected");
      } catch (err: any) {
        expect(err.message).to.include("quoteRef");
      }
      try {
        await COMMANDS.buildSettleCalldata({ decisionId: "1", swapTxHash: ethers.ZeroHash, amountOut: "1", executionMode: "darkpool" as never });
        expect.fail("expected an unknown execution mode to be rejected");
      } catch (err: any) {
        expect(err.message).to.include("executionMode");
      }
    });
  });

  describe("compile-mandate (Feature 2, redesigned - theme-map.json, not the dead RWA sector filter)", function () {
    async function expectRefusal(text: string, pattern: RegExp) {
      try {
        await COMMANDS.compileMandate({ text });
        expect.fail(`expected compile-mandate to refuse "${text}"`);
      } catch (err: any) {
        expect(err.message).to.match(pattern);
      }
    }

    it("refuses to guess a theme, or a missing dollar/trade-count/percentage field, rather than defaulting silently", async function () {
      await expectRefusal("Only quantum computing stocks, $1 per trade, 3 trades a day, premium over 1%", /no known theme/);
      await expectRefusal("Only AI-chip stocks, 3 trades a day, premium over 1%", /per trade/);
      await expectRefusal("Only AI-chip stocks, $1 per trade, premium over 1%", /trades a day/);
      await expectRefusal("Only AI-chip stocks, $1 per trade, 3 trades a day", /premium over/);
    });

    it("compiles the plain-English example sentence into one real setMandateForTokens transaction that configures every token", async function () {
      const text = "Only AI-chip stocks, at most $1 per trade, 3 trades a day, no weekend premium over 1%.";
      const result = await COMMANDS.compileMandate({ text });
      expect(result.theme).to.equal("ai-chips");
      expect(result.tickers).to.include.members(["NVDA", "AMD", "AVGO", "ARM", "INTC", "QCOM", "TSM", "MU"]);
      expect(result.tokens.length).to.equal(result.tickers.length);

      // Sent from the owner key - setMandateForTokens is onlyOwner - as one
      // real transaction, exactly the "one owner transaction sets the whole
      // mandate" claim this feature is built on.
      const receipt = await (await env.owner.sendTransaction({ to: env.covenantAddress, data: result.calldata })).wait();
      expect(receipt!.status).to.equal(1);

      const covenant = new ethers.Contract(env.covenantAddress, covenantArtifact.abi, env.provider);
      const mandate = await covenant.mandate();
      expect(mandate.active).to.equal(true);
      expect(mandate.maxNotionalPerTradeUsd).to.equal(ethers.parseUnits("1", 18));
      expect(mandate.maxTradesPerDay).to.equal(3n);

      for (const token of result.tokens) {
        const cfg = await covenant.tokenConfig(token);
        expect(cfg.allowed, `token ${token} should be allowed`).to.equal(true);
        expect(cfg.maxSlippageBps).to.equal(100n);
        expect(cfg.maxPositionUsd).to.equal(ethers.parseUnits("10", 18));
        expect(cfg.maxClosedMarketDriftBps).to.equal(100n);
      }
    });
  });

  describe("classify-execution-mode (RFQ vs pool - real router addresses, never a guessed rfq)", function () {
    it("classifies the real Day-1 fill's router as aggregator, PancakeSwap V3's as pool, and anything else as unknown", async function () {
      // docs/evidence/day1-gate-swap.json's real swap `to`.
      expect((await COMMANDS.classifyExecutionMode({ to: "0xb300000b72deaeb607a12d5f54773d1c19c7028d" })).executionMode).to.equal("aggregator");
      // Same address, different case - addresses aren't case-sensitive.
      expect((await COMMANDS.classifyExecutionMode({ to: "0xB300000B72DEAEB607A12D5F54773D1C19C7028D" })).executionMode).to.equal("aggregator");
      // PancakeSwap V3 SwapRouter, used directly in test/Covenant.fork.ts and scripts/chaos-fork.ts.
      expect((await COMMANDS.classifyExecutionMode({ to: "0x1b81D678ffb9C0263b24A97847620C99d213eB14" })).executionMode).to.equal("pool");
      // Never guesses "rfq", and anything unrecognized is "unknown", not a default guess.
      expect((await COMMANDS.classifyExecutionMode({ to: NVDAB })).executionMode).to.equal("unknown");
    });
  });
});
