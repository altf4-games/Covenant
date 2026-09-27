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
 *   AMOUNT_IN_EXCEEDED  the trade spent more than the decision's amountIn (the
 *                       number every cap was checked against), or a buy received
 *                       more stock than that amountIn could buy (red-team H13)
 *   MULTI_TOKEN_TRADE   one transaction moved more than one configured stock
 *   AGENT_MISMATCH      the trade was made by a different wallet than the one
 *                       that committed the decision (red-team H14)
 *   SWAP_AFTER_REVOKE   the trade landed after the mandate was revoked, or after
 *                       its token was disallowed, following the commit
 * And for settles:
 *   FALSE_SETTLE        a settle points at a transaction that moved none of the wallet's stock
 * And for the scan itself:
 *   INCOMPLETE_RANGE    the scan doesn't include Covenant's deployment, so tokens
 *                       configured and trades made before it would be invisible
 *
 * Every wallet that held the agent role is reconciled (from Covenant's own
 * AgentChanged events), over the blocks it held it plus the decision TTL
 * after it lost it - an approval it committed can stay live that long.
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
const AGENT_CHANGED_TOPIC = "0x4a2e63eb36ad3c667a1d8d1b18dfbf37d06f96b46b82b526a855175916515add";
const ORACLE_UPDATER_CHANGED_TOPIC = "0x533d09c424dd042c543d0802296b09115923bce3f566e20c069e3d754a8aff8f";
const MANDATE_REVOKED_TOPIC = "0x2baefe0377ed7e2b674c85b23075a590dab754e30d405e69dfe391fcc9c4d2c8";
const SELECTOR_AGENT = "0xf5ff5c76";
const SELECTOR_QUOTE_TOKEN = "0x217a4b70";
const SELECTOR_DECISION_TTL = "0x072aaa5c";
/**
 * A buy may receive at most this much more stock than its quote said (in
 * bps), before it counts as having spent more than the declared amountIn.
 * Catches a buy paid for in something other than the quote token (native
 * BNB, say), where no USDT outflow exists to compare. 5% leaves room for
 * price improvement on a real fill.
 */
const BUY_RECEIVED_TOLERANCE_BPS = 500n;
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
  | "FALSE_SETTLE"
  | "AMOUNT_IN_EXCEEDED"
  | "MULTI_TOKEN_TRADE"
  | "AGENT_MISMATCH"
  | "SWAP_AFTER_REVOKE"
  | "INCOMPLETE_RANGE";

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

/** (block, txIndex) ordering: is a strictly before b? */
const before = (a: { blockNumber: number; txIndex: number }, b: { blockNumber: number; txIndex: number }) =>
  a.blockNumber < b.blockNumber || (a.blockNumber === b.blockNumber && a.txIndex < b.txIndex);

export async function reconcile(opts: ReconcileOptions) {
  const { rpcUrls, covenantAddress, fromBlock } = opts;
  const chunk = opts.chunkSize ?? DEFAULT_CHUNK;
  const toBlock = opts.toBlock ?? Number(BigInt(await rpc(rpcUrls, "eth_blockNumber", [])));

  const agent = addrFromTopic((await ethCallWithFailover(covenantAddress, SELECTOR_AGENT, { rpcUrls })).result);
  const quoteToken = addrFromTopic((await ethCallWithFailover(covenantAddress, SELECTOR_QUOTE_TOKEN, { rpcUrls })).result);
  const decisionTtl = Number(BigInt((await ethCallWithFailover(covenantAddress, SELECTOR_DECISION_TTL, { rpcUrls })).result));

  const blockTimes = new Map<number, number>();
  const blockTime = async (n: number) => {
    if (!blockTimes.has(n)) blockTimes.set(n, Number(BigInt((await rpc(rpcUrls, "eth_getBlockByNumber", ["0x" + n.toString(16), false])).timestamp)));
    return blockTimes.get(n)!;
  };
  const pos = (log: Log) => ({ blockNumber: Number(BigInt(log.blockNumber)), txIndex: Number(BigInt(log.transactionIndex)) });

  // Every token the owner ever configured, from Covenant's own events, and
  // when any of them was later disallowed.
  const configLogs = await getLogs(rpcUrls, { address: covenantAddress, topics: [TOKEN_CONFIGURED_TOPIC] }, fromBlock, toBlock, chunk);
  const stockTokens = [...new Set(configLogs.map((l) => addrFromTopic(l.topics[1])))];
  const disallowed = configLogs
    .filter((l) => BigInt(l.data.slice(0, 66)) === 0n)
    .map((l) => ({ token: addrFromTopic(l.topics[1]), ...pos(l) }));

  // Covenant's decision events, agent rotations and revokes.
  const covenantLogs = await getLogs(rpcUrls, { address: covenantAddress, topics: [] }, fromBlock, toBlock, chunk);
  const commits = new Map<string, CommittedDecision & { blockNumber: number; txIndex: number }>();
  const settles: Array<SettledDecision & { settleTx: string }> = [];
  const agentChanges: Array<{ agent: string; blockNumber: number; txIndex: number }> = [];
  const revokes: Array<{ blockNumber: number; txIndex: number }> = [];
  const updaterChangeTxs = new Set<string>();
  for (const log of covenantLogs) {
    if (log.topics[0] === ORACLE_UPDATER_CHANGED_TOPIC) updaterChangeTxs.add(log.transactionHash.toLowerCase());
    if (log.topics[0] === AGENT_CHANGED_TOPIC) agentChanges.push({ agent: addrFromTopic(log.topics[1]), ...pos(log) });
    if (log.topics[0] === MANDATE_REVOKED_TOPIC) revokes.push(pos(log));
    const e = decodeCovenantLog(log);
    if (e?.kind === "commit") commits.set(e.id, { ...e, ...pos(log) });
    if (e?.kind === "settle") settles.push({ ...e, settleTx: log.transactionHash });
  }

  const violations: Violation[] = [];

  // The constructor is the only transaction that emits both
  // OracleUpdaterChanged and AgentChanged. Without it in range, every token
  // configured and every trade made before fromBlock is invisible - an
  // unmatched trade there would otherwise come back clean.
  const deploymentSeen = covenantLogs.some((l) => l.topics[0] === AGENT_CHANGED_TOPIC && updaterChangeTxs.has(l.transactionHash.toLowerCase()));
  if (!deploymentSeen) {
    violations.push({ kind: "INCOMPLETE_RANGE", detail: `the scan from block ${fromBlock} doesn't include Covenant's deployment - start at its deployment block` });
  }

  // Who was the agent when. The constructor emits AgentChanged, so a scan
  // from the deploy block sees every holder. A scan starting later needs the
  // holder at fromBlock, read at that block.
  const tenures = [...agentChanges].sort((a, b) => (before(a, b) ? -1 : 1));
  if (tenures.length === 0 || tenures[0].blockNumber > fromBlock) {
    let first = agent;
    if (tenures.length > 0) {
      try {
        const res = await rpc(rpcUrls, "eth_call", [{ to: covenantAddress, data: SELECTOR_AGENT }, "0x" + fromBlock.toString(16)]);
        first = addrFromTopic(res);
      } catch {
        throw new Error(
          `the agent was rotated inside the scanned range, and no RPC could read who held the role at block ${fromBlock} ` +
            `(an archive query). Start the scan at Covenant's deployment block, where the constructor's AgentChanged event says.`,
        );
      }
    }
    tenures.unshift({ agent: first, blockNumber: fromBlock, txIndex: -1 });
  }
  const agentAt = (p: { blockNumber: number; txIndex: number }) => {
    let holder = tenures[0].agent;
    for (const t of tenures) if (!before(p, t)) holder = t.agent;
    return holder;
  };
  const wallets = [...new Set(tenures.map((t) => t.agent))];

  // Real token movement in and out of each agent wallet, per transaction.
  interface TxMovement { wallet: string; blockNumber: number; txIndex: number; stock: Map<string, bigint>; quoteIn: bigint; quoteOut: bigint }
  const movements = new Map<string, TxMovement>();
  const touch = (log: Log, wallet: string) => {
    const key = `${log.transactionHash.toLowerCase()}|${wallet}`;
    if (!movements.has(key)) movements.set(key, { wallet, ...pos(log), stock: new Map(), quoteIn: 0n, quoteOut: 0n });
    return movements.get(key)!;
  };
  for (const wallet of wallets) {
    for (const token of stockTokens) {
      for (const log of await getLogs(rpcUrls, { address: token, topics: [TRANSFER_TOPIC, null, topicAddr(wallet)] }, fromBlock, toBlock, chunk)) {
        const m = touch(log, wallet);
        m.stock.set(token, (m.stock.get(token) ?? 0n) + BigInt(log.data));
      }
      for (const log of await getLogs(rpcUrls, { address: token, topics: [TRANSFER_TOPIC, topicAddr(wallet)] }, fromBlock, toBlock, chunk)) {
        const m = touch(log, wallet);
        m.stock.set(token, (m.stock.get(token) ?? 0n) - BigInt(log.data));
      }
    }
    for (const log of await getLogs(rpcUrls, { address: quoteToken, topics: [TRANSFER_TOPIC, null, topicAddr(wallet)] }, fromBlock, toBlock, chunk)) {
      touch(log, wallet).quoteIn += BigInt(log.data);
    }
    for (const log of await getLogs(rpcUrls, { address: quoteToken, topics: [TRANSFER_TOPIC, topicAddr(wallet)] }, fromBlock, toBlock, chunk)) {
      touch(log, wallet).quoteOut += BigInt(log.data);
    }
  }

  // A wallet's movement is in scope while it held the role, and for one TTL
  // after it lost it (an approval it committed can still be live).
  const inScope = async (m: TxMovement) => {
    if (agentAt(m) === m.wallet) return true;
    // The most recent point at-or-before m where this wallet lost the role -
    // not the first one it ever lost it. A wallet that held the agent role
    // across two separate, non-contiguous tenures (rotated away, later
    // rotated back in, then rotated away again) needs its latest handover
    // here: tenures is sorted ascending, so scanning forward and keeping
    // the last match finds it, where Array.find's "first match" would lock
    // onto a much older, irrelevant handover whose TTL window may have long
    // since closed even though the real, recent one hasn't.
    let handover: { blockNumber: number; txIndex: number } | undefined;
    for (let i = 1; i < tenures.length; i++) {
      if (tenures[i - 1].agent === m.wallet && !before(m, tenures[i]) && tenures[i].agent !== m.wallet) {
        handover = tenures[i];
      }
    }
    if (!handover) return false;
    return (await blockTime(m.blockNumber)) <= (await blockTime(handover.blockNumber)) + decisionTtl;
  };

  const matched: Array<{ txHash: string; decisionId: string; side: string; token: string; received: string; wallet: string }> = [];

  const settlesBySwap = new Map<string, typeof settles>();
  for (const s of settles) {
    const key = s.swapTxHash.toLowerCase();
    settlesBySwap.set(key, [...(settlesBySwap.get(key) ?? []), s]);
  }

  // Every trade must be claimed by exactly one settle, and the claim must hold up.
  const trades: Array<[string, TxMovement]> = [];
  for (const [key, m] of movements) {
    if (![...m.stock.values()].some((d) => d !== 0n)) continue;
    if (!(await inScope(m))) continue;
    trades.push([key.split("|")[0], m]);
  }
  for (const [txHash, m] of trades) {
    const moved = [...m.stock.entries()].filter(([, d]) => d !== 0n);
    const describe = moved.map(([t, d]) => `${d > 0n ? "received" : "sent"} ${d < 0n ? -d : d} of ${t}`).join(", ");
    const claims = settlesBySwap.get(txHash) ?? [];
    if (claims.length === 0) {
      violations.push({ kind: "UNMATCHED_TRADE", txHash, detail: `${m.wallet} ${describe} with no settled decision` });
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
    if (moved.length > 1) {
      violations.push({ kind: "MULTI_TOKEN_TRADE", txHash, decisionId: settle.id, detail: `one transaction ${describe}; a decision covers one token` });
      ok = false;
    }
    const [token, delta] = moved.find(([t]) => t === decision.token.toLowerCase()) ?? moved[0];
    const side = delta > 0n ? "buy" : "sell";
    const committedBy = agentAt(decision);
    if (committedBy !== m.wallet) {
      violations.push({ kind: "AGENT_MISMATCH", txHash, decisionId: settle.id, detail: `decision committed by ${committedBy}, trade made by ${m.wallet}` });
      ok = false;
    }
    if (decision.token.toLowerCase() !== token) {
      violations.push({ kind: "TOKEN_MISMATCH", txHash, decisionId: settle.id, detail: `decision was for ${decision.token}, trade moved ${token}` });
      ok = false;
    }
    if (decision.side !== side) {
      violations.push({ kind: "SIDE_MISMATCH", txHash, decisionId: settle.id, detail: `decision said ${decision.side}, the wallet ${side === "buy" ? "received" : "sent"} stock` });
      ok = false;
    }
    const received = side === "buy" ? delta : m.quoteIn - m.quoteOut;
    if (BigInt(settle.amountOut) !== received) {
      violations.push({ kind: "AMOUNT_MISMATCH", txHash, decisionId: settle.id, detail: `settled ${settle.amountOut}, really received ${received}` });
      ok = false;
    }
    if (received < BigInt(decision.minOut)) {
      violations.push({ kind: "BELOW_MINIMUM", txHash, decisionId: settle.id, detail: `received ${received}, minimum was ${decision.minOut}` });
      ok = false;
    }
    // Red-team H13: every cap was checked against amountIn, so what the
    // trade really spent can't exceed it.
    const spent = side === "buy" ? m.quoteOut - m.quoteIn : -delta;
    const amountIn = BigInt(decision.amountIn);
    const maxReceived = (BigInt(decision.quotedOut) * (10_000n + BUY_RECEIVED_TOLERANCE_BPS)) / 10_000n;
    if (spent > amountIn) {
      violations.push({ kind: "AMOUNT_IN_EXCEEDED", txHash, decisionId: settle.id, detail: `decision approved spending ${amountIn}, the trade really spent ${spent}` });
      ok = false;
    } else if (side === "buy" && received > maxReceived) {
      violations.push({ kind: "AMOUNT_IN_EXCEEDED", txHash, decisionId: settle.id, detail: `received ${received}, more than the ${amountIn} approved could buy at the quote (${decision.quotedOut})` });
      ok = false;
    }
    if (before(m, decision)) {
      violations.push({ kind: "SWAP_BEFORE_COMMIT", txHash, decisionId: settle.id, detail: `trade in block ${m.blockNumber}, commit in block ${decision.blockNumber}` });
      ok = false;
    } else if ((await blockTime(m.blockNumber)) > decision.expiresAt) {
      violations.push({ kind: "SWAP_AFTER_EXPIRY", txHash, decisionId: settle.id, detail: `trade at ${await blockTime(m.blockNumber)}, decision expired at ${decision.expiresAt}` });
      ok = false;
    }
    const pulled =
      revokes.find((r) => before(decision, r) && !before(m, r)) ??
      disallowed.find((d) => d.token === decision.token.toLowerCase() && before(decision, d) && !before(m, d));
    if (pulled) {
      violations.push({ kind: "SWAP_AFTER_REVOKE", txHash, decisionId: settle.id, detail: `the mandate or this token was pulled in block ${pulled.blockNumber}, before the trade in block ${m.blockNumber}` });
      ok = false;
    }
    if (ok) matched.push({ txHash, decisionId: settle.id, side, token, received: received.toString(), wallet: m.wallet });
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
    agents: wallets,
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
    console.log(`  agent wallet: ${report.agent}${report.agents.length > 1 ? ` (all holders: ${report.agents.join(", ")})` : ""}`);
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
