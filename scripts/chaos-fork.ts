/**
 * Chaos-fork demo (cross-hackathon-action-items.md #2, modeled on noyeet's
 * scripts/chaos-fork.sh from KeeperHub's Agents Onchain Hackathon).
 *
 * One command, no setup beyond `npm install`: spins up a real
 * `hardhat node --fork` of BSC mainnet, deploys a real Covenant, sets a
 * real (deliberately tight) mandate, then fires a batch of transactions
 * specifically designed to violate it - a scam-impersonator token, a
 * notional over the cap, and a trade while the oracle reports a halt -
 * plus one legitimate trade for contrast. Every single one is a real
 * transaction against real deployed bytecode; nothing here is asserted
 * against a mock.
 *
 * Covenant's guard never reverts on a denial (see contracts/Covenant.sol's
 * NatSpec - a revert would discard the Attestation event along with
 * everything else) - it soft-declines and emits a typed Attestation
 * instead. So "the real revert" a judge would see from a reverting design
 * is, here, the real on-chain Attestation event, independently decoded by
 * scripts/judge.ts's own verifyAttestationTx - not printed from this
 * script's own memory of what it just did, but re-read from the actual
 * transaction receipt the same way a judge would.
 *
 * Usage:
 *   npm run chaos-fork
 */
import { spawn, ChildProcess } from "node:child_process";
import { ethers } from "ethers";
import covenantArtifact from "../artifacts/contracts/Covenant.sol/Covenant.json" with { type: "json" };
import { verifyAttestationTx } from "./judge.js";

const RPC_PORT = 8993;
const RPC_URL = `http://127.0.0.1:${RPC_PORT}`;
const BSC_FORK_URL = process.env.BSC_RPC_URL || "https://bsc-mainnet.public.blastapi.io";
const FUNDED_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // hardhat node's well-known account #0

const USDT = "0x55d398326f99059fF775485246999027B3197955";
const NVDAB = "0x02fca66c1d1afb4e2a7884261eb00f63598a7436"; // real, from docs/research/verified-facts.md
const IMPERSONATOR_BSTOCKS = "0x2F701b108a9aF5558960325A0239D0a13c2C4444"; // real, confirmed impersonator - see verified-facts.md
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

async function fireAndVerify(
  label: string,
  covenant: any,
  covenantAddress: string,
  args: [string, number, bigint, bigint],
) {
  const tx = await covenant.guardedSwap(...args);
  const receipt = await tx.wait();
  const verified = await verifyAttestationTx(RPC_URL, covenantAddress, receipt.hash);
  console.log(`\n[${label}]`);
  console.log(`  tx:      ${receipt.hash}`);
  if (!verified.ok) {
    console.log(`  FAILED TO INDEPENDENTLY VERIFY: ${verified.detail}`);
    return;
  }
  console.log(`  block:   ${verified.blockNumber}`);
  console.log(`  allowed: ${verified.allowed}`);
  console.log(`  reason:  ${verified.reason}`);
  console.log(`  amountIn=${verified.amountIn} amountOut=${verified.amountOut}`);
}

async function main() {
  console.log(`Forking BSC mainnet via ${BSC_FORK_URL}...`);
  const nodeProcess: ChildProcess = spawn(
    "npx",
    ["hardhat", "node", "--fork", BSC_FORK_URL, "--chain-id", "56", "--port", String(RPC_PORT)],
    { cwd: new URL("..", import.meta.url).pathname, stdio: "ignore" },
  );
  const cleanup = () => nodeProcess.kill();
  process.on("exit", cleanup);

  try {
    await waitForRpc(RPC_URL, 60_000);

    const provider = new ethers.JsonRpcProvider(RPC_URL);
    // NonceManager, not a raw Wallet: this script fires many sequential
    // transactions from one account, and a raw Wallet re-queries
    // getNonce("pending") fresh on every send - found live to occasionally
    // desync under back-to-back sends on a local node (a real
    // NONCE_EXPIRED error, not a mock failure) even though every send is
    // awaited to a receipt before the next one starts. NonceManager tracks
    // the next nonce locally instead of re-querying, which is the
    // documented fix for exactly this class of race.
    const signer = new ethers.NonceManager(new ethers.Wallet(FUNDED_PRIVATE_KEY, provider));
    const signerAddress = await signer.getAddress();
    const factory = new ethers.ContractFactory(covenantArtifact.abi, covenantArtifact.bytecode, signer);
    const covenant = await factory.deploy(USDT, PANCAKE_V3_SWAP_ROUTER, signerAddress, 900);
    await covenant.waitForDeployment();
    const covenantAddress = await covenant.getAddress();
    console.log(`Deployed real Covenant at ${covenantAddress}`);

    // A deliberately tight, real mandate - NVDAB only, small cap.
    await (await covenant.setAllowedToken(NVDAB, true)).wait();
    const latest = (await provider.getBlock("latest"))!.timestamp;
    await (await covenant.setMandate(ethers.parseUnits("10", 18), 10n, latest + 30 * 24 * 60 * 60)).wait();
    await (await covenant.updateOracle(NVDAB, false)).wait();
    console.log(`Mandate set: NVDAB only, max 10 USDT per trade, not halted.`);

    // Fund the signer with real USDT by impersonating a real whale, so the
    // one legitimate trade below is real too, not just the denials.
    await provider.send("hardhat_impersonateAccount", [USDT_WHALE]);
    await provider.send("hardhat_setBalance", [USDT_WHALE, "0xDE0B6B3A7640000"]);
    const whale = new ethers.JsonRpcSigner(provider, USDT_WHALE);
    const usdtAbi = ["function transfer(address,uint256) returns (bool)", "function approve(address,uint256) returns (bool)"];
    const usdtAsWhale = new ethers.Contract(USDT, usdtAbi, whale);
    const fundAmount = ethers.parseUnits("999", 18);
    await (await usdtAsWhale.transfer(signerAddress, fundAmount)).wait();
    await provider.send("hardhat_stopImpersonatingAccount", [USDT_WHALE]);
    const usdtAsSigner = new ethers.Contract(USDT, usdtAbi, signer);
    await (await usdtAsSigner.approve(covenantAddress, fundAmount)).wait();

    console.log("\n--- Deliberately violating the mandate, on real deployed bytecode ---");

    await fireAndVerify(
      "attempt: scam impersonator token (not allowlisted)",
      covenant,
      covenantAddress,
      [IMPERSONATOR_BSTOCKS, 2500, ethers.parseUnits("1", 18), 0n],
    );

    await fireAndVerify(
      "attempt: notional above the 10 USDT cap",
      covenant,
      covenantAddress,
      [NVDAB, 2500, ethers.parseUnits("500", 18), 0n],
    );

    await (await covenant.updateOracle(NVDAB, true)).wait();
    await fireAndVerify(
      "attempt: trade NVDAB while the oracle reports a halt",
      covenant,
      covenantAddress,
      [NVDAB, 2500, ethers.parseUnits("1", 18), 0n],
    );
    await (await covenant.updateOracle(NVDAB, false)).wait();

    console.log("\n--- For contrast: one legitimate trade, same contract, same mandate ---");
    await fireAndVerify(
      "attempt: NVDAB, within cap, oracle healthy",
      covenant,
      covenantAddress,
      [NVDAB, 2500, ethers.parseUnits("5", 18), 0n],
    );

    console.log("\nEvery decision above was independently re-derived from a real transaction receipt by");
    console.log("scripts/judge.ts's verifyAttestationTx - not asserted by this script, re-read from chain.");
  } finally {
    cleanup();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
