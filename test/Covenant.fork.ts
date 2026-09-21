import { expect } from "chai";
import { network } from "hardhat";

const { ethers, networkHelpers } = await network.getOrCreate("bscFork");

// Every address below was read from live BSC mainnet state before this file
// was written, not assumed - see docs/research/verified-facts.md for the
// name()/symbol()/decimals()/factory() calls that verified each one, and
// docs/partner-feedback/friction-log.md B12/B13 for what it took to get a
// fork that can actually serve this state.
const USDT = "0x55d398326f99059fF775485246999027B3197955";
const NVDAB = "0x02fca66c1d1afb4e2a7884261eb00f63598a7436"; // real bStocks NVDA
const NVDAB_ON = "0xa9ee28c80f960b889dfbd1902055218cba016f75"; // Ondo's NVDA - same underlying, different provider
const IMPERSONATOR_BSTOCKS = "0x2F701b108a9aF5558960325A0239D0a13c2C4444"; // scam token, verified fake
const PANCAKE_V3_SWAP_ROUTER = "0x1b81D678ffb9C0263b24A97847620C99d213eB14";
const PANCAKE_V3_QUOTER = "0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997";
const NVDAB_USDT_FEE_TIER = 2500; // 0.25% pool, per verified-facts.md

// A real USDT-rich BSC address (Binance-associated hot wallet). Its balance
// was checked live via eth_call before this test was written (~24.7M USDT at
// the time). Impersonated only long enough to fund our own test signers with
// real USDT for real swaps; it never signs anything on its own behalf here.
const USDT_WHALE = "0xF977814e90dA44bFA03b6295A0616a897441aceC";

const STALENESS_BOUND_SECONDS = 15 * 60;
const THIRTY_DAYS_SECONDS = 30 * 24 * 60 * 60;

const Reason = {
  None: 0n,
  TokenNotAllowed: 3n,
  OracleHalted: 7n,
};

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function transfer(address,uint256) returns (bool)",
];

const QUOTER_ABI = [
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
];

/**
 * Decodes Covenant's Attestation event straight from a transaction receipt's
 * logs, which `tx.wait()` already returned. `contract.queryFilter(...)` looks
 * like the obvious way to read it back, but it issues its own `eth_getLogs`
 * call - a second remote RPC round trip for data already sitting in hand.
 * Against a free-tier RPC forking BSC (heavy eth_getProof responses, see
 * friction-log.md B14) that extra call is exactly what pushed this suite into
 * 429 Too Many Requests. Reading the receipt instead removes an unforced RPC
 * dependency, not just works around a rate limit.
 */
function parseAttestation(covenant: { interface: { parseLog: (log: unknown) => { name: string; args: any } | null } }, receipt: { logs: readonly unknown[] } | null) {
  if (!receipt) throw new Error("guardedSwap transaction produced no receipt");
  for (const log of receipt.logs) {
    const parsed = covenant.interface.parseLog(log as any);
    if (parsed?.name === "Attestation") return parsed.args;
  }
  throw new Error("no Attestation event found in transaction receipt");
}

// This suite deploys and funds once in `before`, not once per `it` via
// loadFixture. Each `it` here talks to a real remote RPC (fork + impersonate
// + real ERC20 transfers), and loadFixture's per-test snapshot revert turned
// out to be extremely slow against it - one run took over 4 minutes and
// still timed out. See docs/partner-feedback/friction-log.md B12. Sharing
// one fork setup cuts the network round trips roughly 4x; the tests below
// are ordered so state mutated by one (the oracle halt flag) is restored
// before the next test that depends on it runs.
describe("Covenant (fork, real BSC mainnet state)", function () {
  this.timeout(180_000);

  let oracleUpdater: Awaited<ReturnType<typeof ethers.getSigners>>[number];
  let trader: Awaited<ReturnType<typeof ethers.getSigners>>[number];
  let haltTrader: Awaited<ReturnType<typeof ethers.getSigners>>[number];
  let covenant: Awaited<ReturnType<typeof ethers.deployContract>>;
  let covenantAddress: string;
  let fundAmount: bigint;

  before(async function () {
    [, oracleUpdater, trader, haltTrader] = await ethers.getSigners();

    covenant = await ethers.deployContract("Covenant", [
      USDT,
      PANCAKE_V3_SWAP_ROUTER,
      oracleUpdater.address,
      STALENESS_BOUND_SECONDS,
    ]);
    covenantAddress = await covenant.getAddress();

    await covenant.setAllowedToken(NVDAB, true);
    const latest = await networkHelpers.time.latest();
    await covenant.setMandate(ethers.parseUnits("50", 18), 10n, latest + THIRTY_DAYS_SECONDS);
    await covenant.connect(oracleUpdater).updateOracle(NVDAB, false);

    // Fund both trading signers with real USDT by impersonating a real,
    // verified-rich holder - this is a fully real token and a fully real
    // balance; the only thing that isn't "organic" is how the balance got
    // there, exactly like using a faucet.
    fundAmount = ethers.parseUnits("5", 18); // ~$5: verified-facts.md shows ~0% slippage at this size
    await networkHelpers.impersonateAccount(USDT_WHALE);
    await networkHelpers.setBalance(USDT_WHALE, ethers.parseEther("1"));
    const whale = await ethers.getSigner(USDT_WHALE);
    const usdtAsWhale = new ethers.Contract(USDT, ERC20_ABI, whale);
    await usdtAsWhale.transfer(trader.address, fundAmount);
    await usdtAsWhale.transfer(haltTrader.address, fundAmount);
    await networkHelpers.stopImpersonatingAccount(USDT_WHALE);
  });

  it("denies Ondo's NVDA token even though it's the same underlying stock - provider pinning, not ticker matching", async function () {
    // Only the real NVDAB address was allowlisted in `before`; NVDAB_ON never was.
    expect(await covenant.previewDecision(NVDAB_ON, 1n)).to.equal(Reason.TokenNotAllowed);
    expect(await covenant.previewDecision(NVDAB, 1n)).to.equal(Reason.None);
  });

  it("denies the real bStocks impersonator contract from docs/research/verified-facts.md", async function () {
    expect(await covenant.previewDecision(IMPERSONATOR_BSTOCKS, 1n)).to.equal(Reason.TokenNotAllowed);
  });

  it("denies a real trade once the oracle reports a halt, and moves no real funds", async function () {
    await covenant.connect(oracleUpdater).updateOracle(NVDAB, true);
    expect(await covenant.previewDecision(NVDAB, fundAmount)).to.equal(Reason.OracleHalted);

    const usdt = new ethers.Contract(USDT, ERC20_ABI, haltTrader);
    await usdt.approve(covenantAddress, fundAmount);
    const usdtBefore: bigint = await usdt.balanceOf(haltTrader.address);

    const tx = await covenant.connect(haltTrader).guardedSwap(NVDAB, NVDAB_USDT_FEE_TIER, fundAmount, 0n);
    const receipt = await tx.wait();

    const attestation = parseAttestation(covenant, receipt);
    expect(attestation.allowed).to.equal(false);
    expect(attestation.reason).to.equal(Reason.OracleHalted);
    expect(attestation.amountOut).to.equal(0n);

    // The denial cost gas only - no principal moved, real USDT balance untouched.
    expect(await usdt.balanceOf(haltTrader.address)).to.equal(usdtBefore);

    // Restore for the next test - the halt was this test's concern, not theirs.
    await covenant.connect(oracleUpdater).updateOracle(NVDAB, false);
  });

  it("executes a real guarded swap against live PancakeSwap V3 liquidity", async function () {
    const quoter = new ethers.Contract(PANCAKE_V3_QUOTER, QUOTER_ABI, ethers.provider);
    const quoted = await quoter.quoteExactInputSingle.staticCall({
      tokenIn: USDT,
      tokenOut: NVDAB,
      amountIn: fundAmount,
      fee: NVDAB_USDT_FEE_TIER,
      sqrtPriceLimitX96: 0n,
    });
    const quotedAmountOut: bigint = quoted[0];
    // Sanity check that we're actually quoting a live, liquid pool right now,
    // not a zero-liquidity pair that would make this test meaningless.
    expect(quotedAmountOut).to.be.greaterThan(0n);

    const amountOutMinimum = (quotedAmountOut * 95n) / 100n; // 5% slippage tolerance

    const usdt = new ethers.Contract(USDT, ERC20_ABI, trader);
    const nvdab = new ethers.Contract(NVDAB, ERC20_ABI, trader);
    await usdt.approve(covenantAddress, fundAmount);

    const nvdabBefore: bigint = await nvdab.balanceOf(trader.address);
    const usdtBefore: bigint = await usdt.balanceOf(trader.address);

    const tx = await covenant.connect(trader).guardedSwap(NVDAB, NVDAB_USDT_FEE_TIER, fundAmount, amountOutMinimum);
    const receipt = await tx.wait();

    const attestation = parseAttestation(covenant, receipt);
    expect(attestation.allowed).to.equal(true);
    expect(attestation.reason).to.equal(Reason.None);
    expect(attestation.amountOut).to.be.greaterThanOrEqual(amountOutMinimum);

    const nvdabAfter: bigint = await nvdab.balanceOf(trader.address);
    const usdtAfter: bigint = await usdt.balanceOf(trader.address);
    expect(nvdabAfter - nvdabBefore).to.equal(attestation.amountOut);
    expect(usdtBefore - usdtAfter).to.equal(fundAmount);

    // Non-custodial: nothing left behind in Covenant itself.
    expect(await usdt.balanceOf(covenantAddress)).to.equal(0n);
    expect(await nvdab.balanceOf(covenantAddress)).to.equal(0n);
  });
});
