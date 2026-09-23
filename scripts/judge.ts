/**
 * Judge-runnable demo (Phase 2 addendum #2 / Phase 4,
 * docs/research/competitor-derived-features.md).
 *
 * A judge doesn't have this project's Agentic Wallet, developer mode, or
 * bStock jurisdiction clearance - they can't reproduce a live trade
 * themselves. What they *can* do is verify, independently, that the real
 * transactions this project claims happened, actually happened, and
 * decoded to what the README says they decoded to. This script does that:
 * read the current on-chain mandate state, then re-fetch each listed
 * transaction's real receipt from chain, find its Attestation event, and
 * decode it - allow/deny and the exact typed reason - without trusting
 * anything this project says about it.
 *
 * This is the plumbing only (Phase 2 addendum): built and tested now
 * against the fork, with real transactions this session generates itself.
 * data/judge-tx-hashes.json stays empty until Phase 3 provides real BSC
 * mainnet tx hashes - pointing this at mainnet then is a config change
 * (RPC URL + contract address + that file), not new development.
 *
 * Usage:
 *   COVENANT_ADDRESS=0x... npx tsx scripts/judge.ts
 *   (optionally BSC_RPC_URL=..., and data/judge-tx-hashes.json populated)
 *
 * RPC failover: a judge running this has no reason to trust that one
 * free-tier RPC is up the moment they try it - the project's own friction
 * log (B12-B14) documents real flakiness on exactly this class of endpoint.
 * BSC_RPC_URL, if set, is tried first; otherwise this falls back through
 * cli.mjs's own DEFAULT_BSC_RPCS list (the same one `survey` already
 * depends on) rather than hardcoding a single endpoint.
 */
import { readFile } from "node:fs/promises";
import { SELECTORS, DENIAL_REASONS, jsonRpcWithFailover, ethCallWithFailover, DEFAULT_BSC_RPCS } from "../skills/covenant-mandate/scripts/cli.mjs";

// cli.mjs keeps its own asBool/asUint private - small enough to duplicate
// here rather than widen that file's export surface for two one-liners.
const slot = (data: string, i: number) => "0x" + data.replace(/^0x/, "").slice(i * 64, i * 64 + 64);
const asBool = (data: string, i: number) => BigInt(slot(data, i)) !== 0n;
const asUint = (data: string, i: number) => BigInt(slot(data, i));

// keccak256("Attestation(address,address,uint256,uint256,bool,uint8)") -
// computed once with ethers and cross-checked against a real Attestation
// log from this project's own fork test transactions (same verification
// discipline as the function selectors in cli.mjs - see that file's
// comment for why this isn't computed at runtime).
const ATTESTATION_TOPIC = "0xacd51d375387877499961a137980c39a84aa7985463fa41e068cb224c98838fe";

// keccak256("ChallengeResolved(uint256,bool,uint256)") - Phase 2.5's
// slashable guard. Computed once with ethers, same verification discipline
// as ATTESTATION_TOPIC above; cross-checked against a real ChallengeResolved
// log from test/Covenant.fork.ts's slashable-guard fork test.
const CHALLENGE_RESOLVED_TOPIC = "0x37b4c820a08cf4a6b36e86c12f351c8de017e389247b2c8c5151cde2f37f85ee";

const TX_HASHES_FILE = new URL("../data/judge-tx-hashes.json", import.meta.url).pathname;
const CHALLENGE_TX_HASHES_FILE = new URL("../data/judge-challenge-tx-hashes.json", import.meta.url).pathname;

interface VerifiedAttestation {
  txHash: string;
  ok: boolean;
  detail: string;
  blockNumber?: string;
  caller?: string;
  tokenOut?: string;
  amountIn?: string;
  amountOut?: string;
  allowed?: boolean;
  reason?: string;
}

// Accepts a single RPC (tests pin this to one local forked node - no
// failover needed or wanted there) or a list (the real judge-facing path,
// where depending on exactly one free-tier endpoint being up is the risk
// this exists to avoid - see the module doc comment). Reuses cli.mjs's own
// failover helpers - the same ones `survey` depends on - rather than a
// second, separate implementation of the same try-each-RPC loop.
type RpcTarget = string | string[];
const asRpcList = (target: RpcTarget): string[] => (Array.isArray(target) ? target : [target]);

/**
 * Re-fetches a transaction's real receipt and independently decodes its
 * Attestation log. Does not trust anything about the transaction except
 * what's actually in the receipt returned by the RPC.
 */
export async function verifyAttestationTx(rpcTarget: RpcTarget, covenantAddress: string, txHash: string): Promise<VerifiedAttestation> {
  const { result: receipt } = await jsonRpcWithFailover("eth_getTransactionReceipt", [txHash], { rpcUrls: asRpcList(rpcTarget) });
  if (!receipt) {
    return { txHash, ok: false, detail: "no receipt found - transaction does not exist on this chain" };
  }
  if (receipt.status !== "0x1") {
    return { txHash, ok: false, detail: `transaction reverted (status=${receipt.status})` };
  }

  const log = (receipt.logs as Array<{ address: string; topics: string[]; data: string }>).find(
    (l) => l.address.toLowerCase() === covenantAddress.toLowerCase() && l.topics[0]?.toLowerCase() === ATTESTATION_TOPIC,
  );
  if (!log) {
    return { txHash, ok: false, detail: "no Attestation event found from this contract in this transaction's receipt", blockNumber: receipt.blockNumber };
  }

  const caller = "0x" + log.topics[1].slice(-40);
  const tokenOut = "0x" + log.topics[2].slice(-40);
  const data = log.data.replace(/^0x/, "");
  const amountIn = BigInt("0x" + data.slice(0, 64));
  const amountOut = BigInt("0x" + data.slice(64, 128));
  const allowed = BigInt("0x" + data.slice(128, 192)) !== 0n;
  const reasonIndex = Number(BigInt("0x" + data.slice(192, 256)));

  return {
    txHash,
    ok: true,
    detail: "verified",
    blockNumber: receipt.blockNumber,
    caller,
    tokenOut,
    amountIn: amountIn.toString(),
    amountOut: amountOut.toString(),
    allowed,
    reason: DENIAL_REASONS[reasonIndex] ?? `UNKNOWN(${reasonIndex})`,
  };
}

interface VerifiedChallengeResolution {
  txHash: string;
  ok: boolean;
  detail: string;
  blockNumber?: string;
  challengeId?: string;
  upheld?: boolean;
  slashedAmount?: string;
}

/**
 * Re-fetches a challenge-resolution transaction's real receipt and
 * independently decodes its ChallengeResolved log - same discipline as
 * verifyAttestationTx: nothing here is trusted except what's actually in
 * the receipt the RPC returns.
 */
export async function verifyChallengeResolutionTx(
  rpcTarget: RpcTarget,
  covenantAddress: string,
  txHash: string,
): Promise<VerifiedChallengeResolution> {
  const { result: receipt } = await jsonRpcWithFailover("eth_getTransactionReceipt", [txHash], { rpcUrls: asRpcList(rpcTarget) });
  if (!receipt) {
    return { txHash, ok: false, detail: "no receipt found - transaction does not exist on this chain" };
  }
  if (receipt.status !== "0x1") {
    return { txHash, ok: false, detail: `transaction reverted (status=${receipt.status})` };
  }

  const log = (receipt.logs as Array<{ address: string; topics: string[]; data: string }>).find(
    (l) => l.address.toLowerCase() === covenantAddress.toLowerCase() && l.topics[0]?.toLowerCase() === CHALLENGE_RESOLVED_TOPIC,
  );
  if (!log) {
    return { txHash, ok: false, detail: "no ChallengeResolved event found from this contract in this transaction's receipt", blockNumber: receipt.blockNumber };
  }

  const challengeId = BigInt(log.topics[1]);
  const data = log.data.replace(/^0x/, "");
  const upheld = BigInt("0x" + data.slice(0, 64)) !== 0n;
  const slashedAmount = BigInt("0x" + data.slice(64, 128));

  return {
    txHash,
    ok: true,
    detail: "verified",
    blockNumber: receipt.blockNumber,
    challengeId: challengeId.toString(),
    upheld,
    slashedAmount: slashedAmount.toString(),
  };
}

export async function readTxHashList(): Promise<string[]> {
  if (process.env.JUDGE_TX_HASHES) {
    return process.env.JUDGE_TX_HASHES.split(",").map((h) => h.trim()).filter(Boolean);
  }
  try {
    const raw = await readFile(TX_HASHES_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function readChallengeTxHashList(): Promise<string[]> {
  if (process.env.JUDGE_CHALLENGE_TX_HASHES) {
    return process.env.JUDGE_CHALLENGE_TX_HASHES.split(",").map((h) => h.trim()).filter(Boolean);
  }
  try {
    const raw = await readFile(CHALLENGE_TX_HASHES_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function runJudge(
  rpcTarget: RpcTarget,
  covenantAddress: string,
  txHashes: string[],
  challengeTxHashes: string[] = [],
) {
  const rpcUrls = asRpcList(rpcTarget);
  const { result: mandateRaw } = await ethCallWithFailover(covenantAddress, SELECTORS.mandate, { rpcUrls });
  const mandate = {
    active: asBool(mandateRaw, 0),
    maxNotionalPerTrade: asUint(mandateRaw, 1).toString(),
    maxTradesPerDay: asUint(mandateRaw, 2).toString(),
    expiry: asUint(mandateRaw, 3).toString(),
  };

  const results = await Promise.all(txHashes.map((h) => verifyAttestationTx(rpcUrls, covenantAddress, h)));
  const challengeResults = await Promise.all(
    challengeTxHashes.map((h) => verifyChallengeResolutionTx(rpcUrls, covenantAddress, h)),
  );

  return {
    mandate,
    results,
    challengeResults,
    allVerified:
      results.length + challengeResults.length > 0 &&
      results.every((r) => r.ok) &&
      challengeResults.every((r) => r.ok),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    // BSC_RPC_URL, if set, is tried first; DEFAULT_BSC_RPCS (publicnode,
    // defibit, binance dataseed - the same list `survey` already relies on)
    // backs it up, so a judge isn't betting the whole run on one endpoint.
    const rpcUrls = [process.env.BSC_RPC_URL, ...DEFAULT_BSC_RPCS].filter((u): u is string => Boolean(u));
    const covenantAddress = process.env.COVENANT_ADDRESS;
    if (!covenantAddress) {
      console.error("Set COVENANT_ADDRESS to the deployed Covenant contract to judge.");
      process.exitCode = 1;
      return;
    }

    console.log(`Covenant judge report`);
    console.log(`  contract: ${covenantAddress}`);
    console.log(`  rpc candidates: ${rpcUrls.join(", ")}\n`);

    const txHashes = await readTxHashList();
    const challengeTxHashes = await readChallengeTxHashList();
    if (txHashes.length === 0 && challengeTxHashes.length === 0) {
      console.log("No transactions listed in data/judge-tx-hashes.json, data/judge-challenge-tx-hashes.json, JUDGE_TX_HASHES, or JUDGE_CHALLENGE_TX_HASHES - showing mandate state only.\n");
    }

    const { mandate, results, challengeResults, allVerified } = await runJudge(
      rpcUrls,
      covenantAddress,
      txHashes,
      challengeTxHashes,
    );

    console.log("Mandate (read live from chain):");
    console.log(`  active:              ${mandate.active}`);
    console.log(`  maxNotionalPerTrade: ${mandate.maxNotionalPerTrade}`);
    console.log(`  maxTradesPerDay:     ${mandate.maxTradesPerDay}`);
    console.log(`  expiry:              ${mandate.expiry}\n`);

    for (const r of results) {
      const status = r.ok ? "PASS" : "FAIL";
      console.log(`[${status}] ${r.txHash}`);
      if (r.ok) {
        console.log(`    block=${r.blockNumber} allowed=${r.allowed} reason=${r.reason} amountIn=${r.amountIn} amountOut=${r.amountOut}`);
      } else {
        console.log(`    ${r.detail}`);
      }
    }

    if (results.length > 0) {
      console.log(`\n${results.filter((r) => r.ok).length}/${results.length} attestation transactions independently verified.`);
    }

    if (challengeResults.length > 0) {
      console.log("\nSlashable-guard challenge resolutions:");
      for (const r of challengeResults) {
        const status = r.ok ? "PASS" : "FAIL";
        console.log(`[${status}] ${r.txHash}`);
        if (r.ok) {
          console.log(`    block=${r.blockNumber} challengeId=${r.challengeId} upheld=${r.upheld} slashedAmount=${r.slashedAmount}`);
        } else {
          console.log(`    ${r.detail}`);
        }
      }
      console.log(`\n${challengeResults.filter((r) => r.ok).length}/${challengeResults.length} challenge resolutions independently verified.`);
    }

    const nothingToVerify = txHashes.length === 0 && challengeTxHashes.length === 0;
    process.exitCode = allVerified || nothingToVerify ? 0 : 1;
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
