import { expect } from "chai";
import { network } from "hardhat";
import { readLiveOracle } from "../scripts/oracle-updater.js";
import { isWeb3ApiGeoBlocked } from "../scripts/lib/local-fork.js";

const { ethers, networkHelpers } = await network.getOrCreate("bscFork");

// Every address below was read from live BSC mainnet state, not assumed -
// see docs/research/verified-facts.md.
const USDT = "0x55d398326f99059fF775485246999027B3197955";
const NVDAB = "0x02fca66c1d1afb4e2a7884261eb00f63598a7436"; // real bStocks NVDA
const NVDA_ON = "0xa9ee28c80f960b889dfbd1902055218cba016f75"; // Ondo's NVDA - same stock, different provider
const IMPERSONATOR_BSTOCKS = "0x2F701b108a9aF5558960325A0239D0a13c2C4444"; // verified scam token
const PANCAKE_V3_SWAP_ROUTER = "0x1b81D678ffb9C0263b24A97847620C99d213eB14";
const NVDAB_USDT_FEE_TIER = 2500;
const USDT_WHALE = "0xF977814e90dA44bFA03b6295A0616a897441aceC";

// The real Binance Agentic Wallet this project uses. On a fork of current
// mainnet it genuinely holds the NVDAB bought in Phase 3's Day-1 gate
// (docs/evidence/day1-gate-swap.json), so the position check below reads
// a real balance, not a minted one.
const AGENTIC_WALLET = "0xaa963e1b4f913975Ee81139F4BA2953951E45844";

const E18 = 10n ** 18n;
const Reason = { None: 0n, TokenNotAllowed: 3n, OracleHalted: 7n, PositionLimit: 9n, DecisionOpen: 10n };
const Side = { Buy: 0, Sell: 1 };
const Mode = { Pool: 1 };

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function transfer(address,uint256) returns (bool)",
];
const ROUTER_ABI = [
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
];
const QUOTE_REF = ethers.keccak256(ethers.toUtf8Bytes("fork quote"));

function parseCommitted(covenant: any, receipt: any) {
  for (const log of receipt.logs) {
    const parsed = covenant.interface.parseLog(log);
    if (parsed?.name === "DecisionCommitted") return parsed.args.toObject();
  }
  throw new Error("no DecisionCommitted event in receipt");
}

// One fork setup for the whole suite: every step here costs real remote
// RPC round trips (friction-log.md B12, B14), and loadFixture per test was
// measured at over 4 minutes. Tests are ordered so each leaves the state
// the next one expects.
describe("Covenant v2 (fork, real BSC mainnet state)", function () {
  this.timeout(240_000);

  let covenant: any;
  let updater: any;
  let agent: any;
  let livePrice: bigint;
  let realNvdabHeld: bigint;

  before(async function () {
    const signers = await ethers.getSigners();
    updater = signers[1];

    await networkHelpers.impersonateAccount(AGENTIC_WALLET);
    await networkHelpers.setBalance(AGENTIC_WALLET, ethers.parseEther("1"));
    agent = await ethers.getSigner(AGENTIC_WALLET);

    covenant = await ethers.deployContract("Covenant", [USDT, updater.address, AGENTIC_WALLET, 900, 600]);

    // The oracle price is the real live one. The halt flag is set to open
    // here on purpose so the allow path can run whatever the market is
    // doing right now; the live halt signal itself is tested in
    // test/oracle-updater.live.ts, and a halt is exercised explicitly below.
    try {
      livePrice = (await readLiveOracle(56, NVDAB)).priceUsd;
    } catch (err) {
      if (isWeb3ApiGeoBlocked(err)) return this.skip();
      throw err;
    }
    await covenant.connect(updater).updateOracle(NVDAB, false, livePrice, true, livePrice);

    const latest = await networkHelpers.time.latest();
    await covenant.setMandate(5n * E18, 10n, latest + 30 * 24 * 60 * 60);

    realNvdabHeld = await new ethers.Contract(NVDAB, ERC20_ABI, ethers.provider).balanceOf(AGENTIC_WALLET);
  });

  it("the Agentic Wallet really holds NVDAB on this fork (the Day-1 buy), so later checks read real state", async function () {
    expect(realNvdabHeld).to.be.greaterThan(0n);
    console.log(`      (real NVDAB held by the Agentic Wallet: ${ethers.formatUnits(realNvdabHeld, 18)}, ~$${ethers.formatUnits((realNvdabHeld * livePrice) / E18, 18).slice(0, 5)})`);
  });

  it("pins providers: Ondo's NVDA and the impersonator are denied even though NVDAB is allowed", async function () {
    await covenant.configureToken(NVDAB, true, 100, 10n * E18);
    const quotedOut = (E18 * E18) / livePrice;
    const minOut = (quotedOut * 995n) / 1000n;
    expect(await covenant.previewDecision(Side.Buy, NVDA_ON, E18, quotedOut, minOut)).to.equal(Reason.TokenNotAllowed);
    expect(await covenant.previewDecision(Side.Buy, IMPERSONATOR_BSTOCKS, E18, quotedOut, minOut)).to.equal(Reason.TokenNotAllowed);
    expect(await covenant.previewDecision(Side.Buy, NVDAB, E18, quotedOut, minOut)).to.equal(Reason.None);
  });

  it("Feature 3: the position cap counts the wallet's real NVDAB balance", async function () {
    const quotedOut = (E18 * E18) / livePrice; // a $1 buy
    const minOut = (quotedOut * 995n) / 1000n;
    const heldUsd = (realNvdabHeld * livePrice) / E18;

    // A cap of exactly $1 is fine for an empty wallet but not for this one:
    // the ~$0.35 it really holds plus $1 more is over the cap.
    await covenant.configureToken(NVDAB, true, 100, E18);
    expect(heldUsd).to.be.greaterThan(0n);
    expect(await covenant.previewDecision(Side.Buy, NVDAB, E18, quotedOut, minOut)).to.equal(Reason.PositionLimit);

    // Raise the cap to cover the real holding plus the new buy.
    await covenant.configureToken(NVDAB, true, 100, heldUsd + 2n * E18);
    expect(await covenant.previewDecision(Side.Buy, NVDAB, E18, quotedOut, minOut)).to.equal(Reason.None);
  });

  it("the full loop against real liquidity: commit, a real swap, settle with the real hash and real amount", async function () {
    // Fund the agent with real USDT from a real holder.
    await networkHelpers.impersonateAccount(USDT_WHALE);
    await networkHelpers.setBalance(USDT_WHALE, ethers.parseEther("1"));
    const whale = await ethers.getSigner(USDT_WHALE);
    await new ethers.Contract(USDT, ERC20_ABI, whale).transfer(AGENTIC_WALLET, 2n * E18);
    await networkHelpers.stopImpersonatingAccount(USDT_WHALE);

    const amountIn = E18; // $1
    const quotedOut = (amountIn * E18) / livePrice;
    // A 5% bound with the minimum at 4%: the V3 pool's real price can sit a
    // little away from the RWA endpoint's price, and this test is about the
    // loop, not slippage. (Not 3%/3%: `* 97 / 100` rounds down, putting the
    // minimum a hair under the floor, which the contract correctly denies.)
    await covenant.configureToken(NVDAB, true, 500, (realNvdabHeld * livePrice) / E18 + 2n * E18);
    const minOut = (quotedOut * 96n) / 100n;

    const commitReceipt = await (await covenant.connect(agent).commit(Side.Buy, NVDAB, amountIn, quotedOut, minOut, QUOTE_REF, ethers.ZeroHash)).wait();
    const decision = parseCommitted(covenant, commitReceipt);
    expect(decision.allowed).to.equal(true);
    expect(await covenant.openDecisionId()).to.equal(decision.id);

    // On a fork there's no Binance backend, so PancakeSwap V3 stands in as
    // the execution venue. On mainnet this step is `baw market-order swap`.
    const nvdab = new ethers.Contract(NVDAB, ERC20_ABI, ethers.provider);
    const before = await nvdab.balanceOf(AGENTIC_WALLET);
    await new ethers.Contract(USDT, ERC20_ABI, agent).approve(PANCAKE_V3_SWAP_ROUTER, amountIn);
    const router = new ethers.Contract(PANCAKE_V3_SWAP_ROUTER, ROUTER_ABI, agent);
    const latest = await networkHelpers.time.latest();
    const swapReceipt = await (
      await router.exactInputSingle({
        tokenIn: USDT,
        tokenOut: NVDAB,
        fee: NVDAB_USDT_FEE_TIER,
        recipient: AGENTIC_WALLET,
        deadline: latest + 300,
        amountIn,
        amountOutMinimum: minOut,
        sqrtPriceLimitX96: 0n,
      })
    ).wait();
    const received = (await nvdab.balanceOf(AGENTIC_WALLET)) - before;
    expect(received).to.be.greaterThanOrEqual(minOut);

    await expect(covenant.connect(agent).settle(decision.id, swapReceipt.hash, received, Mode.Pool))
      .to.emit(covenant, "DecisionSettled")
      .withArgs(decision.id, swapReceipt.hash, received, Mode.Pool, false);

    const stored = await covenant.getDecision(decision.id);
    expect(stored.settled).to.equal(true);
    expect(stored.swapTxHash).to.equal(swapReceipt.hash);
    expect(stored.amountOut).to.equal(received);
    expect(await covenant.openDecisionId()).to.equal(0n);
  });

  it("a guarded sell of the wallet's real NVDAB is allowed, measured through the live price", async function () {
    const held = await new ethers.Contract(NVDAB, ERC20_ABI, ethers.provider).balanceOf(AGENTIC_WALLET);
    const amountIn = held / 2n;
    const quotedOut = (amountIn * livePrice) / E18;
    const minOut = (quotedOut * 99n) / 100n;
    expect(await covenant.previewDecision(Side.Sell, NVDAB, amountIn, quotedOut, minOut)).to.equal(Reason.None);
  });

  it("denies once the oracle reports a halt; a denied commit records the refusal and opens nothing", async function () {
    await covenant.connect(updater).updateOracle(NVDAB, true, livePrice, true, livePrice);
    const quotedOut = (E18 * E18) / livePrice;
    const receipt = await (await covenant.connect(agent).commit(Side.Buy, NVDAB, E18, quotedOut, (quotedOut * 99n) / 100n, QUOTE_REF, ethers.ZeroHash)).wait();
    const decision = parseCommitted(covenant, receipt);
    expect(decision.allowed).to.equal(false);
    expect(decision.reason).to.equal(Reason.OracleHalted);
    expect(await covenant.openDecisionId()).to.equal(0n);
    await covenant.connect(updater).updateOracle(NVDAB, false, livePrice, true, livePrice);
  });

  it("nobody but the agent can commit - not even a real funded USDT holder (griefing closed)", async function () {
    await networkHelpers.impersonateAccount(USDT_WHALE);
    const whale = await ethers.getSigner(USDT_WHALE);
    await expect(
      covenant.connect(whale).commit(Side.Buy, NVDAB, 1n, 1n, 1n, QUOTE_REF, ethers.ZeroHash),
    ).to.be.revertedWithCustomError(covenant, "NotAgent");
    await networkHelpers.stopImpersonatingAccount(USDT_WHALE);
  });
});
