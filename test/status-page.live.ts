import { expect } from "chai";
import { spawn, ChildProcess } from "node:child_process";
import { ethers } from "ethers";
import covenantArtifact from "../artifacts/contracts/Covenant.sol/Covenant.json" with { type: "json" };
import { ABI, fetchAttestations, resolveFromBlock, DEFAULT_LOOKBACK_BLOCKS } from "../status-page/lib.mjs";

// This suite exists because the bug it guards against was found by actually
// driving the status page in a real browser, not by writing a test first -
// see docs/partner-feedback/friction-log.md B16. Against a forked RPC,
// Hardhat's eth_getLogs hangs forever (no error, no timeout) the instant a
// queried range includes even the fork's own pinned starting block - only
// blocks mined *after* that point, locally, are safe. We can't fix
// Hardhat's fork provider from here, so what's actually under test is our
// own defense: status-page/lib.mjs's fetchAttestations wraps the call in a
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
const RPC_URL = `http://127.0.0.1:${RPC_PORT}`;
const BSC_FORK_URL = "https://bsc-mainnet.public.blastapi.io";
const FUNDED_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // hardhat node's well-known account #0

const USDT = "0x55d398326f99059fF775485246999027B3197955";
const NVDAB = "0x02fca66c1d1afb4e2a7884261eb00f63598a7436";
const IMPERSONATOR_BSTOCKS = "0x2F701b108a9aF5558960325A0239D0a13c2C4444";
const PANCAKE_V3_SWAP_ROUTER = "0x1b81D678ffb9C0263b24A97847620C99d213eB14";

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

describe("status page: real attestation reads and the fork-boundary hang", function () {
  this.timeout(120_000);

  let nodeProcess: ChildProcess;
  let provider: ethers.JsonRpcProvider;
  let covenant: ethers.Contract;
  let forkStartBlock: number;
  let latestBlockAfterSeed: number;

  before(async function () {
    nodeProcess = spawn(
      "npx",
      ["hardhat", "node", "--fork", BSC_FORK_URL, "--chain-id", "56", "--port", String(RPC_PORT)],
      { cwd: new URL("..", import.meta.url).pathname, stdio: "ignore" },
    );
    await waitForRpc(RPC_URL, 60_000);

    provider = new ethers.JsonRpcProvider(RPC_URL);
    forkStartBlock = await provider.getBlockNumber();

    const signer = new ethers.Wallet(FUNDED_PRIVATE_KEY, provider);
    const factory = new ethers.ContractFactory(covenantArtifact.abi, covenantArtifact.bytecode, signer);
    const deployed = await factory.deploy(USDT, PANCAKE_V3_SWAP_ROUTER, signer.address, 900);
    await deployed.waitForDeployment();
    const covenantAddress = await deployed.getAddress();
    covenant = new ethers.Contract(covenantAddress, ABI, provider);
    const covenantAsSigner = new ethers.Contract(covenantAddress, ABI.concat(["function guardedSwap(address,uint24,uint256,uint256) returns (uint256)"]), signer);

    // Two real, locally-mined events: both deny (neither token was ever
    // allowlisted), so no approval or funding is needed - the deny path
    // never touches a balance.
    await (await covenantAsSigner.guardedSwap(IMPERSONATOR_BSTOCKS, 2500, 1n, 0n)).wait();
    await (await covenantAsSigner.guardedSwap(NVDAB, 2500, 1n, 0n)).wait();

    latestBlockAfterSeed = await provider.getBlockNumber();
  });

  after(function () {
    nodeProcess?.kill();
  });

  it("returns real events fast when the range stays within locally-mined, post-fork blocks", async function () {
    // forkStartBlock itself needs the same remote lookup as any pre-fork
    // block (confirmed live - it is the fork's pinned upstream block, not
    // something EDR already has as "local" state); only the deployment and
    // the two guardedSwap calls above, all mined after it, are safe.
    const fromBlock = forkStartBlock + 1;

    const start = Date.now();
    const events = await fetchAttestations(covenant, { fromBlock, timeoutMs: 5_000 });
    const elapsedMs = Date.now() - start;

    expect(events).to.have.length(2);
    expect(elapsedMs).to.be.lessThan(2_000); // real assertion: this must be fast, not just "eventually work"

    const [first, second] = events;
    expect((first as any).args.tokenOut.toLowerCase()).to.equal(IMPERSONATOR_BSTOCKS.toLowerCase());
    expect((first as any).args.allowed).to.equal(false);
    expect((second as any).args.tokenOut.toLowerCase()).to.equal(NVDAB.toLowerCase());
    expect((second as any).args.allowed).to.equal(false);
  });

  it("resolveFromBlock defaults to a window that would itself cross the fork boundary on a fresh fork", function () {
    // Documents *why* the default needs the timeout at all: on a chain this
    // young (a handful of blocks past the fork point), even the page's own
    // DEFAULT_LOOKBACK_BLOCKS default reaches back past where the fork
    // started. This isn't a bug in resolveFromBlock - a 500-block default is
    // reasonable for a real, long-lived mainnet deployment - it's exactly the
    // scenario the timeout in fetchAttestations exists to handle gracefully.
    const defaultFromBlock = resolveFromBlock(undefined, latestBlockAfterSeed);
    expect(latestBlockAfterSeed - forkStartBlock).to.be.lessThan(DEFAULT_LOOKBACK_BLOCKS);
    expect(defaultFromBlock).to.be.lessThanOrEqual(forkStartBlock);
  });

  it("fails fast with a clear, actionable error when the range crosses the fork boundary, instead of hanging forever", async function () {
    // Runs last deliberately - see the describe-level comment above. The
    // exact bug this test exists for: querying from at-or-before
    // forkStartBlock makes Hardhat's EDR fork provider proxy to the real
    // upstream RPC for that portion, which hangs indefinitely. A short
    // timeoutMs here keeps this test itself fast; the default in production
    // (status-page/lib.mjs's DEFAULT_LOGS_TIMEOUT_MS) is longer.
    const fromBlock = Math.max(0, forkStartBlock - 5);

    const start = Date.now();
    let caught: Error | undefined;
    try {
      await fetchAttestations(covenant, { fromBlock, timeoutMs: 3_000 });
    } catch (error) {
      caught = error as Error;
    }
    const elapsedMs = Date.now() - start;

    expect(caught, "expected fetchAttestations to reject instead of hanging or resolving").to.not.equal(undefined);
    expect(caught!.message).to.include("eth_getLogs timed out");
    expect(caught!.message).to.include("friction-log.md B16");
    // The real point of this assertion: bounded by our own timeout, not by
    // however long Hardhat's hang would otherwise take (which is: forever).
    expect(elapsedMs).to.be.lessThan(4_000);
  });
});
