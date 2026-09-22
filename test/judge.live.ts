import { expect } from "chai";
import { spawn, ChildProcess } from "node:child_process";
import { ethers } from "ethers";
import covenantArtifact from "../artifacts/contracts/Covenant.sol/Covenant.json" with { type: "json" };
import { verifyAttestationTx, runJudge } from "../scripts/judge.js";

// Real forked node, real deployed Covenant, real transactions (one deny,
// one allow, funded by impersonating a real USDT holder) - judge.ts's job
// is to independently re-derive the truth from a real receipt without
// trusting anything else, so this test gives it real receipts to check
// itself against, the same way a judge on mainnet would hand it real tx
// hashes.
const RPC_PORT = 8992;
const RPC_URL = `http://127.0.0.1:${RPC_PORT}`;
const BSC_FORK_URL = "https://bsc-mainnet.public.blastapi.io";
const FUNDED_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // hardhat node's well-known account #0

const USDT = "0x55d398326f99059fF775485246999027B3197955";
const NVDAB = "0x02fca66c1d1afb4e2a7884261eb00f63598a7436";
const IMPERSONATOR_BSTOCKS = "0x2F701b108a9aF5558960325A0239D0a13c2C4444";
const PANCAKE_V3_SWAP_ROUTER = "0x1b81D678ffb9C0263b24A97847620C99d213eB14";
const USDT_WHALE = "0xF977814e90dA44bFA03b6295A0616a897441aceC";

async function waitForRpc(url: string, timeoutMs: number): Promise<void> {
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

describe("judge.ts (live, real transactions, independent re-derivation from real receipts)", function () {
  this.timeout(120_000);

  let nodeProcess: ChildProcess;
  let covenantAddress: string;
  let denyTxHash: string;
  let allowTxHash: string;
  let fakeTxHash: string;

  before(async function () {
    nodeProcess = spawn(
      "npx",
      ["hardhat", "node", "--fork", BSC_FORK_URL, "--chain-id", "56", "--port", String(RPC_PORT)],
      { cwd: new URL("..", import.meta.url).pathname, stdio: "ignore" },
    );
    await waitForRpc(RPC_URL, 60_000);

    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const signer = new ethers.Wallet(FUNDED_PRIVATE_KEY, provider);
    const factory = new ethers.ContractFactory(covenantArtifact.abi, covenantArtifact.bytecode, signer);
    const covenant = await factory.deploy(USDT, PANCAKE_V3_SWAP_ROUTER, signer.address, 900);
    await covenant.waitForDeployment();
    covenantAddress = await covenant.getAddress();

    await (await (covenant as any).setAllowedToken(NVDAB, true)).wait();
    const latest = (await provider.getBlock("latest"))!.timestamp;
    await (await (covenant as any).setMandate(ethers.parseUnits("50", 18), 10n, latest + 30 * 24 * 60 * 60)).wait();
    await (await (covenant as any).updateOracle(NVDAB, false)).wait();

    // A real deny, no funding needed.
    const denyTx = await (covenant as any).guardedSwap(IMPERSONATOR_BSTOCKS, 2500, 1n, 0n);
    denyTxHash = (await denyTx.wait()).hash;

    // A real allow, funded by impersonating a real USDT holder.
    await provider.send("hardhat_impersonateAccount", [USDT_WHALE]);
    await provider.send("hardhat_setBalance", [USDT_WHALE, "0xDE0B6B3A7640000"]);
    const whale = new ethers.JsonRpcSigner(provider, USDT_WHALE);
    const usdtAbi = ["function transfer(address,uint256) returns (bool)", "function approve(address,uint256) returns (bool)"];
    const usdtAsWhale = new ethers.Contract(USDT, usdtAbi, whale);
    const amountIn = ethers.parseUnits("5", 18);
    await (await usdtAsWhale.transfer(signer.address, amountIn)).wait();
    await provider.send("hardhat_stopImpersonatingAccount", [USDT_WHALE]);

    const usdtAsSigner = new ethers.Contract(USDT, usdtAbi, signer);
    await (await usdtAsSigner.approve(covenantAddress, amountIn)).wait();
    const allowTx = await (covenant as any).guardedSwap(NVDAB, 2500, amountIn, 0n);
    allowTxHash = (await allowTx.wait()).hash;

    fakeTxHash = "0x" + "ab".repeat(32); // a real-looking hash that was never mined
  });

  after(function () {
    nodeProcess?.kill();
  });

  it("independently verifies a real denied transaction matches its real on-chain reason", async function () {
    const result = await verifyAttestationTx(RPC_URL, covenantAddress, denyTxHash);
    expect(result.ok).to.equal(true);
    expect(result.allowed).to.equal(false);
    expect(result.reason).to.equal("TokenNotAllowed");
    expect(result.tokenOut!.toLowerCase()).to.equal(IMPERSONATOR_BSTOCKS.toLowerCase());
  });

  it("independently verifies a real allowed transaction, decode matching ethers' own event parsing", async function () {
    const result = await verifyAttestationTx(RPC_URL, covenantAddress, allowTxHash);
    expect(result.ok).to.equal(true);
    expect(result.allowed).to.equal(true);
    expect(result.reason).to.equal("None");
    expect(result.amountIn).to.equal(ethers.parseUnits("5", 18).toString());
    expect(BigInt(result.amountOut!)).to.be.greaterThan(0n);
  });

  it("reports a real failure, not a false pass, for a tx hash that was never mined", async function () {
    const result = await verifyAttestationTx(RPC_URL, covenantAddress, fakeTxHash);
    expect(result.ok).to.equal(false);
    expect(result.detail).to.include("no receipt found");
  });

  it("runJudge reads the real live mandate and verifies all real transactions in one pass", async function () {
    const { mandate, results, allVerified } = await runJudge(RPC_URL, covenantAddress, [denyTxHash, allowTxHash]);
    expect(mandate.active).to.equal(true);
    expect(mandate.maxNotionalPerTrade).to.equal(ethers.parseUnits("50", 18).toString());
    expect(results).to.have.length(2);
    expect(allVerified).to.equal(true);
  });

  it("falls back past a real dead RPC in the list instead of failing the whole run", async function () {
    // A judge running this unattended has no reason to trust the first RPC
    // they (or we) picked is up - see friction-log.md B12-B14 for the real
    // flakiness that motivated this. A genuinely unreachable URL (port 1
    // is never a real RPC) listed before the real, working one must not
    // sink the call - it should just be skipped.
    const deadRpc = "http://127.0.0.1:1";
    const rpcTargets = [deadRpc, RPC_URL];

    const result = await verifyAttestationTx(rpcTargets, covenantAddress, denyTxHash);
    expect(result.ok).to.equal(true);
    expect(result.allowed).to.equal(false);
    expect(result.reason).to.equal("TokenNotAllowed");

    const { mandate, allVerified } = await runJudge(rpcTargets, covenantAddress, [allowTxHash]);
    expect(mandate.active).to.equal(true);
    expect(allVerified).to.equal(true);
  });
});
