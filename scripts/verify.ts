/**
 * Public reconciliation: every real stock trade the agent's wallet made
 * must map to a decision committed on Covenant before it happened. Anyone
 * can run this against any RPC; it trusts nothing but chain state.
 *
 * What it reads, from `fromBlock` (Covenant's deployment block) onward:
 *   - Covenant's own DecisionCommitted / DecisionSettled / DecisionCancelled events
 *   - every ERC-20 Transfer of a configured stock token into or out of the agent's wallet
 *   - every quote-token (USDT) Transfer into or out of the agent's wallet
 *
 * A "trade" is any transaction that moved a configured stock token in or
 * out of the wallet. Each one is checked against the settle that claims it:
 *   UNMATCHED_TRADE     no settle points at this transaction: a trade made without an approved decision
 *   TOKEN_MISMATCH      the settled decision was for a different token
 *   SIDE_MISMATCH       the decision said buy but stock left the wallet, or vice versa
 *   AMOUNT_MISMATCH     the settled amountOut isn't what really arrived
 *   BELOW_MINIMUM       what really arrived is less than the decision's minOut
 *   SWAP_BEFORE_COMMIT  the trade landed before its decision was committed
 *   SWAP_AFTER_EXPIRY   the trade landed after its decision expired
 *   DUPLICATE_SETTLE    more than one decision claims the same trade
 * And for settles:
 *   FALSE_SETTLE        a settle points at a transaction that moved none of the wallet's stock
 *
 * Amounts are compared against the ERC-20 Transfer, never Binance's
 * reported fill, which is in share units for bStocks (friction-log.md C17).
 *
 * Usage:
 *   COVENANT_ADDRESS=0x... VERIFY_FROM_BLOCK=<deploy block> npm run verify
 */
import { DEFAULT_BSC_RPCS, ethCallWithFailover, jsonRpcWithFailover } from "../skills/covenant-mandate/scripts/cli.mjs";
import { decodeCovenantLog, type CommittedDecision, type SettledDecision } from "./judge.js";

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const TOKEN_CONFIGURED_TOPIC = "0xb110cbefb429de4c581a73938523a8acbe216e53f923683a5686589669b57b16";
const SELECTOR_AGENT = "0xf5ff5c76";
const SELECTOR_QUOTE_TOKEN = "0x217a4b70";
const DEFAULT_CHUNK = 5_000;

type Log = { address: string; topics: string[]; data: string; blockNumber: string; transactionHash: string; transactionIndex: string };

export type ViolationKind =
  | "UNMATCHED_TRADE"
  | "TOKEN_MISMATCH"
  | "SIDE_MISMATCH"
  | "AMOUNT_MISMATCH"
  | "BELOW_MINIMUM"
  | "SWAP_BEFORE_COMMIT"
  | "SWAP_AFTER_EXPIRY"
  | "DUPLICATE_SETTLE"
  | "FALSE_SETTLE";

export interface Violation {
  kind: ViolationKind;
  txHash?: string;
  decisionId?: string;
  detail: string;
}

export interface ReconcileOptions {
  rpcUrls: string[];
  covenantAddress: string;
  fromBlock: number;
  toBlock?: number;
  chunkSize?: number;
}

const topicAddr = (a: string) => "0x" + a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
const addrFromTopic = (t: string) => "0x" + t.slice(-40).toLowerCase();

async function rpc(rpcUrls: string[], method: string, params: unknown[]) {
  return (await jsonRpcWithFailover(method, params, { rpcUrls })).result;
}

/** eth_getLogs over [from, to] in fixed-size chunks, because public RPCs cap the range. */
async function getLogs(rpcUrls: string[], filter: { address: string; topics: (string | null)[] }, from: number, to: number, chunk: number): Promise<Log[]> {
  const out: Log[] = [];
  for (let start = from; start <= to; start += chunk) {
    const end = Math.min(to, start + chunk - 1);
    const logs = await rpc(rpcUrls, "eth_getLogs", [{ ...filter, fromBlock: "0x" + start.toString(16), toBlock: "0x" + end.toString(16) }]);
    out.push(...logs);
  }
  return out;
}

export async function reconcile(opts: ReconcileOptions) {
  const { rpcUrls, covenantAddress, fromBlock } = opts;
  const chunk = opts.chunkSize ?? DEFAULT_CHUNK;
  const toBlock = opts.toBlock ?? Number(BigInt(await rpc(rpcUrls, "eth_blockNumber", [])));

  const agent = addrFromTopic((await ethCallWithFailover(covenantAddress, SELECTOR_AGENT, { rpcUrls })).result);
  const quoteToken = addrFromTopic((await ethCallWithFailover(covenantAddress, SELECTOR_QUOTE_TOKEN, { rpcUrls })).result);

  // Every token the owner ever configured, from Covenant's own events.
  const configLogs = await getLogs(rpcUrls, { address: covenantAddress, topics: [TOKEN_CONFIGURED_TOPIC] }, fromBlock, toBlock, chunk);
  const stockTokens = [...new Set(configLogs.map((l) => addrFromTopic(l.topics[1])))];

  // Covenant's decision events.
  const covenantLogs = await getLogs(rpcUrls, { address: covenantAddress, topics: [] }, fromBlock, toBlock, chunk);
  const commits = new Map<string, CommittedDecision & { blockNumber: number; txIndex: number }>();
  const settles: Array<SettledDecision & { settleTx: string }> = [];
  for (const log of covenantLogs) {
    const e = decodeCovenantLog(log);
    if (e?.kind === "commit") commits.set(e.id, { ...e, blockNumber: Number(BigInt(log.blockNumber)), txIndex: Number(BigInt(log.transactionIndex)) });
    if (e?.kind === "settle") settles.push({ ...e, settleTx: log.transactionHash });
  }

  // Real token movement in and out of the agent's wallet, per transaction.
  interface TxMovement { blockNumber: number; txIndex: number; stock: Map<string, bigint>; quoteIn: bigint }
  const movements = new Map<string, TxMovement>();
  const touch = (log: Log) => {
    const key = log.transactionHash.toLowerCase();
    if (!movements.has(key)) {
      movements.set(key, { blockNumber: Number(BigInt(log.blockNumber)), txIndex: Number(BigInt(log.transactionIndex)), stock: new Map(), quoteIn: 0n });
    }
    return movements.get(key)!;
  };
  for (const token of stockTokens) {
    const incoming = await getLogs(rpcUrls, { address: token, topics: [TRANSFER_TOPIC, null, topicAddr(agent)] }, fromBlock, toBlock, chunk);
    const outgoing = await getLogs(rpcUrls, { address: token, topics: [TRANSFER_TOPIC, topicAddr(agent)] }, fromBlock, toBlock, chunk);
    for (const log of incoming) {
      const m = touch(log);
      m.stock.set(token, (m.stock.get(token) ?? 0n) + BigInt(log.data));
    }
    for (const log of outgoing) {
      const m = touch(log);
      m.stock.set(token, (m.stock.get(token) ?? 0n) - BigInt(log.data));
    }
  }
  const quoteIncoming = await getLogs(rpcUrls, { address: quoteToken, topics: [TRANSFER_TOPIC, null, topicAddr(agent)] }, fromBlock, toBlock, chunk);
  for (const log of quoteIncoming) {
    const key = log.transactionHash.toLowerCase();
    if (movements.has(key)) movements.get(key)!.quoteIn += BigInt(log.data);
    else movements.set(key, { blockNumber: Number(BigInt(log.blockNumber)), txIndex: Number(BigInt(log.transactionIndex)), stock: new Map(), quoteIn: BigInt(log.data) });
  }

  const blockTimes = new Map<number, number>();
  const blockTime = async (n: number) => {
    if (!blockTimes.has(n)) blockTimes.set(n, Number(BigInt((await rpc(rpcUrls, "eth_getBlockByNumber", ["0x" + n.toString(16), false])).timestamp)));
    return blockTimes.get(n)!;
  };

  const violations: Violation[] = [];
  const matched: Array<{ txHash: string; decisionId: string; side: string; token: string; received: string }> = [];

  const settlesBySwap = new Map<string, typeof settles>();
  for (const s of settles) {
    const key = s.swapTxHash.toLowerCase();
    settlesBySwap.set(key, [...(settlesBySwap.get(key) ?? []), s]);
  }

  // Every trade must be claimed by exactly one settle, and the claim must hold up.
  const trades = [...movements.entries()].filter(([, m]) => [...m.stock.values()].some((d) => d !== 0n));
  for (const [txHash, m] of trades) {
    const claims = settlesBySwap.get(txHash) ?? [];
    const [token, delta] = [...m.stock.entries()].find(([, d]) => d !== 0n)!;
    if (claims.length === 0) {
      violations.push({ kind: "UNMATCHED_TRADE", txHash, detail: `${delta > 0n ? "received" : "sent"} ${delta < 0n ? -delta : delta} of ${token} with no settled decision` });
      continue;
    }
    if (claims.length > 1) {
      violations.push({ kind: "DUPLICATE_SETTLE", txHash, detail: `claimed by decisions ${claims.map((c) => c.id).join(", ")}` });
    }
    const settle = claims[0];
    const decision = commits.get(settle.id);
    if (!decision) {
      violations.push({ kind: "FALSE_SETTLE", txHash, decisionId: settle.id, detail: "settled decision has no commit in the scanned range" });
      continue;
    }

    let ok = true;
    const side = delta > 0n ? "buy" : "sell";
    if (decision.token.toLowerCase() !== token) {
      violations.push({ kind: "TOKEN_MISMATCH", txHash, decisionId: settle.id, detail: `decision was for ${decision.token}, trade moved ${token}` });
      ok = false;
    }
    if (decision.side !== side) {
      violations.push({ kind: "SIDE_MISMATCH", txHash, decisionId: settle.id, detail: `decision said ${decision.side}, the wallet ${side === "buy" ? "received" : "sent"} stock` });
      ok = false;
    }
    const received = side === "buy" ? delta : m.quoteIn;
    if (BigInt(settle.amountOut) !== received) {
      violations.push({ kind: "AMOUNT_MISMATCH", txHash, decisionId: settle.id, detail: `settled ${settle.amountOut}, really received ${received}` });
      ok = false;
    }
    if (received < BigInt(decision.minOut)) {
      violations.push({ kind: "BELOW_MINIMUM", txHash, decisionId: settle.id, detail: `received ${received}, minimum was ${decision.minOut}` });
      ok = false;
    }
    const tradeFirst = m.blockNumber < decision.blockNumber || (m.blockNumber === decision.blockNumber && m.txIndex < decision.txIndex);
    if (tradeFirst) {
      violations.push({ kind: "SWAP_BEFORE_COMMIT", txHash, decisionId: settle.id, detail: `trade in block ${m.blockNumber}, commit in block ${decision.blockNumber}` });
      ok = false;
    } else if ((await blockTime(m.blockNumber)) > decision.expiresAt) {
      violations.push({ kind: "SWAP_AFTER_EXPIRY", txHash, decisionId: settle.id, detail: `trade at ${await blockTime(m.blockNumber)}, decision expired at ${decision.expiresAt}` });
      ok = false;
    }
    if (ok) matched.push({ txHash, decisionId: settle.id, side, token, received: received.toString() });
  }

  // Every settle must point at a real trade.
  const tradeHashes = new Set(trades.map(([h]) => h));
  for (const s of settles) {
    if (!tradeHashes.has(s.swapTxHash.toLowerCase())) {
      violations.push({ kind: "FALSE_SETTLE", txHash: s.swapTxHash, decisionId: s.id, detail: "settle points at a transaction that moved none of the wallet's stock" });
    }
  }

  return {
    agent,
    quoteToken,
    stockTokens,
    fromBlock,
    toBlock,
    decisions: commits.size,
    trades: trades.length,
    matched,
    violations,
    clean: violations.length === 0,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    try {
      process.loadEnvFile();
    } catch {
      // no .env
    }
    const covenantAddress = process.env.COVENANT_ADDRESS;
    const fromBlock = process.env.VERIFY_FROM_BLOCK;
    if (!covenantAddress || !fromBlock) throw new Error("Set COVENANT_ADDRESS and VERIFY_FROM_BLOCK (Covenant's deployment block).");
    const rpcUrls = [process.env.BSC_RPC_URL, ...DEFAULT_BSC_RPCS].filter((u): u is string => Boolean(u));

    const report = await reconcile({ rpcUrls, covenantAddress, fromBlock: Number(fromBlock) });
    console.log(`Covenant reconciliation, blocks ${report.fromBlock}-${report.toBlock}`);
    console.log(`  agent wallet: ${report.agent}`);
    console.log(`  decisions:    ${report.decisions}`);
    console.log(`  trades:       ${report.trades} (${report.matched.length} matched to a settled decision)\n`);
    for (const m of report.matched) console.log(`[OK]  ${m.txHash} ${m.side} decision #${m.decisionId}, received ${m.received}`);
    for (const v of report.violations) console.log(`[${v.kind}] ${v.txHash ?? ""}${v.decisionId ? ` decision #${v.decisionId}` : ""} - ${v.detail}`);
    console.log(report.clean ? "\nClean: every trade maps to an approved decision." : `\n${report.violations.length} violation(s).`);
    process.exitCode = report.clean ? 0 : 1;
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
