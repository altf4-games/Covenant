/**
 * Registers Covenant's real ERC-8004 agent identity on BSC mainnet - a
 * real, small, one-time transaction (out of the normal "fork first, one
 * mainnet pass at the very end" sequencing, by explicit user confirmation
 * 2026-09-26, since the trading-card feature needs a real agentId to show).
 *
 * Registration doc schema mirrors the real, live agent #1 ("ClawNews") on
 * the same registry, read directly from tokenURI(1) on 2026-09-26 rather
 * than assumed from the EIP text - see docs/partner-feedback/friction-log.md
 * D12 for the same registry/config already verified this session. Fields
 * kept to what's independently confirmable: no invented OASF skill/domain
 * taxonomy paths, since those describe ClawNews's own service, not a
 * generic schema to copy blind.
 *
 * Usage:
 *   npx tsx scripts/register-erc8004.ts
 * Env: DEPLOYER_PRIVATE_KEY, optional BSC_RPC_URL
 */
import { ethers } from "ethers";

const REGISTRY_MAINNET = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432"; // verified-facts.md §5
const AGENTIC_WALLET = "0xaa963e1b4f913975Ee81139F4BA2953951E45844"; // the real agent, this project's whole build
const REPO_URL = "https://github.com/altf4-games/Covenant";
const REGISTRY_ABI = [
  "function register(string agentURI) returns (uint256)",
  "function tokenURI(uint256) view returns (string)",
  "function ownerOf(uint256) view returns (address)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
];

const registrationDoc = {
  type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
  name: "Covenant",
  description:
    "An on-chain decision ledger for an AI agent trading tokenized stocks on BNB Smart Chain. The agent's Binance Agentic Wallet keeps custody and trades natively (baw market-order swap); before each trade the agent commits the decision on chain and the owner's mandate is evaluated on chain - a per-trade notional cap, a cumulative daily-notional cap, a position cap read from the wallet's real balance, a slippage bound checked against both the quote and a live oracle, and a closed-market drift guard that denies buying at a weekend premium while the NYSE is shut. No trade happens unseen: a public script (verify.ts) reconciles every real token transfer in and out of the wallet against a settled decision, and flags anything that doesn't match.",
  services: [
    { name: "web", endpoint: REPO_URL },
    { name: "agentWallet", endpoint: `eip155:56:${AGENTIC_WALLET}` },
  ],
  registrations: [{ agentId: null, agentRegistry: `eip155:56:${REGISTRY_MAINNET}` }],
  active: true,
  x402Support: false,
  supportedTrust: ["reputation"],
};

async function main() {
  try {
    process.loadEnvFile();
  } catch {
    // no .env - real environment variables only
  }
  const privateKey = process.env.DEPLOYER_PRIVATE_KEY;
  if (!privateKey) throw new Error("Set DEPLOYER_PRIVATE_KEY.");
  const rpcUrl = process.env.BSC_RPC_URL || "https://bsc-mainnet.public.blastapi.io";
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(privateKey, provider);
  const registry = new ethers.Contract(REGISTRY_MAINNET, REGISTRY_ABI, wallet);

  const uri = "data:application/json;base64," + Buffer.from(JSON.stringify(registrationDoc)).toString("base64");
  console.log(`Registering on real BSC mainnet, from ${wallet.address}, registry ${REGISTRY_MAINNET}...`);
  console.log(`Registration doc: ${JSON.stringify(registrationDoc, null, 2)}`);

  const balance = await provider.getBalance(wallet.address);
  console.log(`Deployer balance: ${ethers.formatEther(balance)} BNB`);

  const tx = await registry.register(uri);
  console.log(`tx sent: ${tx.hash}`);
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) throw new Error(`register() reverted (tx ${tx.hash})`);

  const transferLog = receipt.logs
    .map((l) => {
      try {
        return registry.interface.parseLog(l);
      } catch {
        return null;
      }
    })
    .find((p) => p?.name === "Transfer");
  if (!transferLog) throw new Error("no Transfer event in receipt - could not determine the new agentId");
  const agentId = transferLog.args.tokenId as bigint;

  // Independently re-verify: read the identity back from chain, not from
  // this script's own memory of what it sent.
  const [onChainOwner, onChainUri] = await Promise.all([registry.ownerOf(agentId), registry.tokenURI(agentId)]);
  if (onChainOwner.toLowerCase() !== wallet.address.toLowerCase()) {
    throw new Error(`ownerOf(${agentId}) is ${onChainOwner}, expected ${wallet.address}`);
  }
  const decoded = JSON.parse(Buffer.from(onChainUri.replace("data:application/json;base64,", ""), "base64").toString("utf8"));
  if (decoded.name !== "Covenant") throw new Error("on-chain tokenURI doesn't decode back to what was sent");

  console.log(`\nReal mainnet agentId: ${agentId}`);
  console.log(`Owner (deployer): ${onChainOwner}`);
  console.log(`tx: ${tx.hash}`);
  console.log(`gas used: ${receipt.gasUsed.toString()}`);

  const evidence = {
    agentId: agentId.toString(),
    registryAddress: REGISTRY_MAINNET,
    txHash: tx.hash,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed.toString(),
    owner: onChainOwner,
    registrationDoc,
    verifiedOnChain: { ownerOf: onChainOwner, tokenURIDecodesBackCorrectly: true },
  };
  const { writeFileSync } = await import("node:fs");
  const path = new URL("../docs/evidence/erc8004-registration.json", import.meta.url).pathname;
  writeFileSync(path, JSON.stringify(evidence, null, 2) + "\n");
  console.log(`\nEvidence written to docs/evidence/erc8004-registration.json`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
