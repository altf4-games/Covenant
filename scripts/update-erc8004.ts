/**
 * Points Covenant's ERC-8004 identity at the deployed contract.
 *
 * The identity was registered (scripts/register-erc8004.ts) before Covenant
 * existed on mainnet, so its on-chain registration document names no
 * contract and carries `agentId: null` in its own `registrations` entry:
 * nothing on chain links agent #358509 to the contract whose decisions the
 * trading card shows. Run this once, after the mainnet deploy, to set a new
 * agentURI (the registry's `setAgentURI`, owner only) that adds the contract
 * as a service and fills in the agent's own id.
 *
 * Dry run by default: builds the new document, checks the registry would
 * accept the call from the current owner (an estimateGas, no key needed) and
 * prints what it would send. Nothing is sent unless CONFIRM=1.
 *
 * Usage:
 *   COVENANT_ADDRESS=0x... npx tsx scripts/update-erc8004.ts            (dry run)
 *   COVENANT_ADDRESS=0x... CONFIRM=1 npx tsx scripts/update-erc8004.ts  (sends, needs DEPLOYER_PRIVATE_KEY)
 */
import { ethers } from "ethers";
import { bscProvider } from "./lib/bsc-provider.js";
import { readFileSync, writeFileSync } from "node:fs";

const EVIDENCE_PATH = new URL("../docs/evidence/erc8004-registration.json", import.meta.url).pathname;
const REGISTRY_ABI = [
  "function setAgentURI(uint256 agentId, string newURI)",
  "function tokenURI(uint256) view returns (string)",
  "function ownerOf(uint256) view returns (address)",
];

type Doc = {
  services: Array<{ name: string; endpoint: string }>;
  registrations: Array<{ agentId: number | null; agentRegistry: string }>;
  [key: string]: unknown;
};

/** The registration document with the deployed contract added and the agent's own id filled in. Pure, so it can be tested. */
export function withContract(doc: Doc, agentId: string, registry: string, covenantAddress: string): Doc {
  if (!/^0x[0-9a-fA-F]{40}$/.test(covenantAddress)) throw new Error(`"${covenantAddress}" is not a 0x-prefixed 20-byte address`);
  const endpoint = `eip155:56:${covenantAddress}`;
  return {
    ...doc,
    services: [...doc.services.filter((s) => s.name !== "covenant"), { name: "covenant", endpoint }],
    registrations: [{ agentId: Number(agentId), agentRegistry: `eip155:56:${registry}` }],
  };
}

async function main() {
  try {
    process.loadEnvFile();
  } catch {
    // no .env - real environment variables only
  }
  const covenantAddress = process.env.COVENANT_ADDRESS;
  if (!covenantAddress) throw new Error("Set COVENANT_ADDRESS to the deployed Covenant.");
  const evidence = JSON.parse(readFileSync(EVIDENCE_PATH, "utf8"));
  const provider = bscProvider(process.env.BSC_RPC_URL || undefined);

  const code = await provider.getCode(covenantAddress);
  if (code === "0x") throw new Error(`no contract at ${covenantAddress} on this chain - refusing to link an identity to it`);

  const doc = withContract(evidence.registrationDoc, evidence.agentId, evidence.registryAddress, covenantAddress);
  const uri = "data:application/json;base64," + Buffer.from(JSON.stringify(doc)).toString("base64");
  const registry = new ethers.Contract(evidence.registryAddress, REGISTRY_ABI, provider);

  const owner: string = await registry.ownerOf(evidence.agentId);
  const gas = await registry.setAgentURI.estimateGas(evidence.agentId, uri, { from: owner });
  console.log(`agent #${evidence.agentId}, owned by ${owner}`);
  console.log(`new registration document:\n${JSON.stringify(doc, null, 2)}`);
  console.log(`\nsetAgentURI would succeed from the owner; estimated gas ${gas}.`);

  if (process.env.CONFIRM !== "1") {
    console.log("Dry run: nothing sent. Re-run with CONFIRM=1 to send it.");
    return;
  }
  const key = process.env.DEPLOYER_PRIVATE_KEY;
  if (!key) throw new Error("Set DEPLOYER_PRIVATE_KEY (the registry owner) to send.");
  const wallet = new ethers.Wallet(key, provider);
  if (wallet.address.toLowerCase() !== owner.toLowerCase()) throw new Error(`${wallet.address} isn't the identity's owner (${owner})`);

  const tx = await (registry.connect(wallet) as ethers.Contract).setAgentURI(evidence.agentId, uri);
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) throw new Error(`setAgentURI reverted (tx ${tx.hash})`);

  // Read it back: the identity's URI on chain must decode to the new document.
  const onChain = await registry.tokenURI(evidence.agentId);
  const decoded = JSON.parse(Buffer.from(onChain.replace("data:application/json;base64,", ""), "base64").toString("utf8")) as Doc;
  if (!decoded.services.some((s) => s.endpoint === `eip155:56:${covenantAddress}`)) throw new Error("on-chain tokenURI doesn't contain the contract");

  writeFileSync(
    EVIDENCE_PATH,
    JSON.stringify({ ...evidence, registrationDoc: doc, covenantAddress, updateTxHash: tx.hash, updateBlockNumber: receipt.blockNumber }, null, 2) + "\n",
  );
  console.log(`\nUpdated in ${tx.hash} (block ${receipt.blockNumber}); evidence file rewritten.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
