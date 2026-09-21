import { expect } from "chai";
import { spawn, ChildProcess } from "node:child_process";
import { ethers } from "ethers";
import covenantArtifact from "../artifacts/contracts/Covenant.sol/Covenant.json" with { type: "json" };
import { COMMANDS } from "../skills/covenant-mandate/scripts/cli.mjs";

// The skill's cli.mjs is a standalone, zero-dep script meant to run against
// a real HTTP RPC endpoint exactly like it would in production - not against
// Hardhat's in-process EDR provider, which isn't reachable over HTTP from
// another process. So this suite spawns a real `hardhat node --fork ...`
// child process, deploys a real Covenant to it, and drives the skill's own
// exported command functions against that real JSON-RPC server. This is
// slower than an in-process test, but it's the only way to test the script
// the way it's actually invoked.
const RPC_PORT = 8989;
const RPC_URL = `http://127.0.0.1:${RPC_PORT}`;
const BSC_FORK_URL = "https://bsc-mainnet.public.blastapi.io";
const FUNDED_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // hardhat node's well-known account #0

const USDT = "0x55d398326f99059fF775485246999027B3197955";
const NVDAB = "0x02fca66c1d1afb4e2a7884261eb00f63598a7436";
const PANCAKE_V3_SWAP_ROUTER = "0x1b81D678ffb9C0263b24A97847620C99d213eB14";
const IMPERSONATOR_BSTOCKS = "0x2F701b108a9aF5558960325A0239D0a13c2C4444";

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

describe("covenant-mandate skill CLI (live, against a real spawned JSON-RPC node)", function () {
  this.timeout(120_000);

  let nodeProcess: ChildProcess;
  let covenantAddress: string;

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
  });

  after(function () {
    nodeProcess?.kill();
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

  describe("check (real read calls against a real deployed Covenant)", function () {
    it("reports the real allowed decision for real NVDAB within mandate limits", async function () {
      const result = await COMMANDS.check({
        rpcUrl: RPC_URL,
        covenantAddress,
        tokenAddress: NVDAB,
        amountIn: "1000000000000000000",
      });
      expect(result.allowlisted).to.equal(true);
      expect(result.decision.allowed).to.equal(true);
      expect(result.decision.reason).to.equal("None");
    });

    it("reports NotionalExceeded for a real amount above the real mandate cap", async function () {
      const result = await COMMANDS.check({
        rpcUrl: RPC_URL,
        covenantAddress,
        tokenAddress: NVDAB,
        amountIn: "999000000000000000000",
      });
      expect(result.decision.allowed).to.equal(false);
      expect(result.decision.reason).to.equal("NotionalExceeded");
    });

    it("reports TokenNotAllowed for the real verified impersonator address", async function () {
      const result = await COMMANDS.check({
        rpcUrl: RPC_URL,
        covenantAddress,
        tokenAddress: IMPERSONATOR_BSTOCKS,
        amountIn: "1",
      });
      expect(result.allowlisted).to.equal(false);
      expect(result.decision.allowed).to.equal(false);
      expect(result.decision.reason).to.equal("TokenNotAllowed");
    });
  });

  describe("build-swap-calldata", function () {
    it("produces byte-identical calldata to ethers' own ABI encoder", async function () {
      const { calldata } = await COMMANDS.buildSwapCalldata({
        tokenOut: NVDAB,
        fee: 2500,
        amountIn: "1000000000000000000",
        amountOutMinimum: "1",
      });
      const iface = new ethers.Interface(["function guardedSwap(address,uint24,uint256,uint256) returns (uint256)"]);
      const expected = iface.encodeFunctionData("guardedSwap", [NVDAB, 2500, 1000000000000000000n, 1n]);
      expect(calldata).to.equal(expected);
    });
  });
});
