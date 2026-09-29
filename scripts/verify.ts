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
 *   RPC_DISAGREEMENT    (cross-checked runs) a second, independent RPC produced a
 *                       different report for the same blocks: one of them is
 *                       lagging, pruned or lying, and a report that depends on which
 *                       one you asked can't be trusted
 *   INCOMPLETE_RANGE    the scan doesn't include Covenant's deployment, so tokens
 *                       configured and trades made before it would be invisible
 *   UNTRACKED_SWAP      the wallet spent the quote token and received some other
 *                       token in the same transaction, and that token isn't one
 *                       the owner configured - a stock bought outside the mandate
 *
 * Notices (reported, but they don't make a run unclean):
 *   INBOUND_TRANSFER    a configured stock arrived in a transaction the wallet
 *                       didn't send and paid nothing for: a gift or a dusting
 *                       attempt, not a trade. Without this, anyone could send
 *                       1 wei of a stock to the wallet and turn the public
 *                       reconciliation red for good.
 *   CROSS_CHECK_UNAVAILABLE  no second RPC could complete the scan, so the report rests
 *                       on one RPC's word (it is a notice, not a pass)
 *   QUOTE_OUTFLOW       the wallet paid out the quote token in a transaction that
 *                       moved no configured stock and brought no token back: a
 *                       plain payment or transfer. It can be legitimate (paying for
 *                       research), but it is also what a stolen agent key does
 *                       first, so it is listed rather than left invisible.
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
/** How many eth_getLogs ranges are in flight at once. */
const LOG_CONCURRENCY = 4;
/** BSC's wrapped BNB: refunds and gas top-ups arrive as this and aren't an untracked stock. */
const WBNB = "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c";

type Log = { address: string; topics: string[]; data: string; blockNumber: string; transactionHash: string; transactionIndex: string; logIndex?: string };

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
  | "UNTRACKED_SWAP"
  | "RPC_DISAGREEMENT"
  | "INCOMPLETE_RANGE";

export interface Notice {
  kind: "INBOUND_TRANSFER" | "QUOTE_OUTFLOW" | "CROSS_CHECK_UNAVAILABLE";
  txHash: string;
  detail: string;
}

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

/**
 * The RPC calls of one reconciliation, through failover, remembering which
 * endpoints actually answered (so a second opinion can ask a different one).
 */
function makeClient(rpcUrls: string[]) {
  const used = new Set<string>();
  // Endpoints in the order to try them. One that answers moves to the front, so
  // a scan of hundreds of ranges asks a free endpoint that refuses old blocks
  // (or every log request) once, not on every range.
  const order = [...rpcUrls];
  const promote = (url: string) => {
    const i = order.indexOf(url);
    if (i > 0) order.unshift(...order.splice(i, 1));
    used.add(url);
  };
  return {
    used,
    async call(method: string, params: unknown[]) {
      const r = await jsonRpcWithFailover(method, params, { rpcUrls: [...order] });
      promote(r.rpcUrl);
      return r.result;
    },
    async ethCall(to: string, data: string) {
      const r = await ethCallWithFailover(to, data, { rpcUrls: [...order] });
      promote(r.rpcUrl);
      return r.result;
    },
  };
}
type Client = ReturnType<typeof makeClient>;

/**
 * eth_getLogs over [from, to] in fixed-size chunks, because public RPCs cap the
 * range. A log an RPC returns twice (same transaction, same log index) is one
 * log: counting it twice would turn an honest trade into a mismatch.
 */
async function getLogs(client: Client, filter: { address: string | string[]; topics: (string | null)[] }, from: number, to: number, chunk: number): Promise<Log[]> {
  const ranges: Array<[number, number]> = [];
  for (let start = from; start <= to; start += chunk) ranges.push([start, Math.min(to, start + chunk - 1)]);

  // A few ranges at a time: hundreds of sequential round trips to a free
  // endpoint take many minutes, and more than a handful at once draws rate limits.
  const results: Log[][] = Array.from({ length: ranges.length }, () => []);
  let next = 0;
  const worker = async () => {
    while (next < ranges.length) {
      const i = next++;
      const [start, end] = ranges[i];
      results[i] = await client.call("eth_getLogs", [{ ...filter, fromBlock: "0x" + start.toString(16), toBlock: "0x" + end.toString(16) }]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(LOG_CONCURRENCY, ranges.length) }, worker));

  const out: Log[] = [];
  const seen = new Set<string>();
  for (const logs of results) {
    for (const log of logs) {
      if (log.logIndex !== undefined) {
        const key = `${log.transactionHash.toLowerCase()}:${log.logIndex}`;
        if (seen.has(key)) continue;
        seen.add(key);
      }
      out.push(log);
    }
  }
  return out;
}

/** (block, txIndex) ordering: is a strictly before b? */
const before = (a: { blockNumber: number; txIndex: number }, b: { blockNumber: number; txIndex: number }) =>
  a.blockNumber < b.blockNumber || (a.blockNumber === b.blockNumber && a.txIndex < b.txIndex);

export async function reconcile(opts: ReconcileOptions) {
  const { rpcUrls, covenantAddress, fromBlock } = opts;
  const client = makeClient(rpcUrls);
  const chunk = opts.chunkSize ?? DEFAULT_CHUNK;
  const toBlock = opts.toBlock ?? Number(BigInt(await client.call("eth_blockNumber", [])));

  const agent = addrFromTopic((await client.ethCall(covenantAddress, SELECTOR_AGENT)));
  const quoteToken = addrFromTopic((await client.ethCall(covenantAddress, SELECTOR_QUOTE_TOKEN)));
  const decisionTtl = Number(BigInt((await client.ethCall(covenantAddress, SELECTOR_DECISION_TTL))));

  const blockTimes = new Map<number, number>();
  const blockTime = async (n: number) => {
    if (!blockTimes.has(n)) blockTimes.set(n, Number(BigInt((await client.call("eth_getBlockByNumber", ["0x" + n.toString(16), false])).timestamp)));
    return blockTimes.get(n)!;
  };
  const pos = (log: Log) => ({ blockNumber: Number(BigInt(log.blockNumber)), txIndex: Number(BigInt(log.transactionIndex)) });

  // Covenant's decision events, agent rotations and revokes.
  const covenantLogs = await getLogs(client, { address: covenantAddress, topics: [] }, fromBlock, toBlock, chunk);

  // Every token the owner ever configured, from Covenant's own events, and
  // when any of them was later disallowed. (Read out of the same scan as the
  // decision events: a second pass over every range just for these was half
  // of Covenant's log requests.)
  const configLogs = covenantLogs.filter((l) => l.topics[0] === TOKEN_CONFIGURED_TOPIC);
  const stockTokens = [...new Set(configLogs.map((l) => addrFromTopic(l.topics[1])))];
  const disallowed = configLogs
    .filter((l) => BigInt(l.data.slice(0, 66)) === 0n)
    .map((l) => ({ token: addrFromTopic(l.topics[1]), ...pos(l) }));
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
        const res = await client.call("eth_call", [{ to: covenantAddress, data: SELECTOR_AGENT }, "0x" + fromBlock.toString(16)]);
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
  // One address-array filter per direction, not one per token: eth_getLogs
  // accepts a list of addresses, so this is two scans per wallet however many
  // tokens the mandate covers (an 8-token theme was 18).
  const watched = [...stockTokens, quoteToken];
  for (const wallet of wallets) {
    for (const log of await getLogs(client, { address: watched, topics: [TRANSFER_TOPIC, null, topicAddr(wallet)] }, fromBlock, toBlock, chunk)) {
      const token = log.address.toLowerCase();
      const m = touch(log, wallet);
      if (token === quoteToken) m.quoteIn += BigInt(log.data);
      else m.stock.set(token, (m.stock.get(token) ?? 0n) + BigInt(log.data));
    }
    for (const log of await getLogs(client, { address: watched, topics: [TRANSFER_TOPIC, topicAddr(wallet)] }, fromBlock, toBlock, chunk)) {
      const token = log.address.toLowerCase();
      const m = touch(log, wallet);
      if (token === quoteToken) m.quoteOut += BigInt(log.data);
      else m.stock.set(token, (m.stock.get(token) ?? 0n) - BigInt(log.data));
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

  const stockSet = new Set(stockTokens);
  async function receivedUnconfiguredToken(txHash: string, wallet: string): Promise<boolean> {
    const receipt = await client.call("eth_getTransactionReceipt", [txHash]);
    for (const l of (receipt?.logs ?? []) as Log[]) {
      if (l.topics[0] !== TRANSFER_TOPIC || l.topics.length !== 3) continue;
      if (addrFromTopic(l.topics[2]) !== wallet) continue;
      const token = l.address.toLowerCase();
      if (token === quoteToken || token === WBNB || stockSet.has(token)) continue;
      return true;
    }
    return false;
  }

  const matched: Array<{ txHash: string; decisionId: string; side: string; token: string; received: string; wallet: string }> = [];

  const settlesBySwap = new Map<string, typeof settles>();
  for (const s of settles) {
    const key = s.swapTxHash.toLowerCase();
    settlesBySwap.set(key, [...(settlesBySwap.get(key) ?? []), s]);
  }

  // Every trade must be claimed by exactly one settle, and the claim must hold up.
  const trades: Array<[string, TxMovement]> = [];
  const notices: Notice[] = [];
  for (const [key, m] of movements) {
    const txHash = key.split("|")[0];
    const moved = [...m.stock.values()].some((d) => d !== 0n);
    if (!(await inScope(m))) continue;
    if (!moved) {
      // A quote-token spend that brought back some other token is a swap the
      // mandate never saw: a stock the owner didn't configure, say.
      if (m.quoteOut > m.quoteIn && (await receivedUnconfiguredToken(txHash, m.wallet))) {
        violations.push({
          kind: "UNTRACKED_SWAP",
          txHash,
          detail: `${m.wallet} spent ${m.quoteOut - m.quoteIn} of the quote token and received a token that isn't configured on Covenant`,
        });
      } else if (m.quoteOut > m.quoteIn) {
        notices.push({ kind: "QUOTE_OUTFLOW", txHash, detail: `${m.wallet} paid out ${m.quoteOut - m.quoteIn} of the quote token in a transaction that moved no configured stock` });
      }
      continue;
    }
    // Inbound-only, unpaid, and sent by someone else: not a trade. This leans
    // on the wallet sending its own transactions (the Day-1 swap's `from` is
    // the wallet, docs/evidence/day1-gate-swap.json). A stock bought with
    // native BNB in a transaction some sponsor sent on the wallet's behalf
    // would look like a gift here and be listed as a notice, not a trade.
    // Quote-token *received* doesn't matter: a stranger can bundle 1 wei of
    // USDT with the dust. What makes it not a trade is that the wallet paid nothing.
    const inboundOnly = [...m.stock.values()].every((d) => d >= 0n) && m.quoteOut === 0n;
    if (inboundOnly && !settlesBySwap.has(txHash)) {
      const tx = await client.call("eth_getTransactionByHash", [txHash]);
      if (tx && String(tx.from).toLowerCase() !== m.wallet) {
        notices.push({ kind: "INBOUND_TRANSFER", txHash, detail: `${m.wallet} was sent stock by ${String(tx.from).toLowerCase()}, who paid nothing and wasn't the wallet` });
        continue;
      }
    }
    trades.push([txHash, m]);
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
    rpcsUsed: [...client.used],
    agents: wallets,
    quoteToken,
    stockTokens,
    fromBlock,
    toBlock,
    decisions: commits.size,
    trades: trades.length,
    matched,
    violations,
    notices,
    clean: violations.length === 0,
  };
}

type Report = Awaited<ReturnType<typeof reconcile>>;

/** What two honest scans of the same blocks must agree on, in a comparable form. */
const fingerprint = (r: Report) =>
  JSON.stringify({
    decisions: r.decisions,
    trades: r.trades,
    matched: r.matched.map((m) => m.txHash).sort(),
    violations: r.violations.map((v) => `${v.kind}:${v.txHash ?? ""}:${v.decisionId ?? ""}`).sort(),
  });

/**
 * `reconcile`, then the same scan again on a different RPC, pinned to the same
 * last block. The reconciliation trusts whichever RPC answers to have returned
 * every log; one that silently drops Transfer logs would hide an unmatched
 * trade. Two independent endpoints disagreeing is reported as
 * RPC_DISAGREEMENT. If no other RPC can complete the scan (free endpoints cap
 * ranges and refuse old blocks), the report says so instead of pretending.
 */
export async function reconcileCrossChecked(opts: ReconcileOptions): Promise<Report> {
  const report = await reconcile(opts);
  const others = opts.rpcUrls.filter((u) => !report.rpcsUsed.includes(u));
  let second: Report | undefined;
  for (const url of others) {
    try {
      second = await reconcile({ ...opts, rpcUrls: [url], toBlock: report.toBlock });
      break;
    } catch {
      // this endpoint couldn't complete the scan; try the next
    }
  }
  if (!second) {
    report.notices.push({
      kind: "CROSS_CHECK_UNAVAILABLE",
      txHash: "",
      detail: `no second RPC could complete the scan (${others.length} other candidate${others.length === 1 ? "" : "s"}); this report rests on ${report.rpcsUsed.join(", ")} alone`,
    });
    return report;
  }
  if (fingerprint(report) !== fingerprint(second)) {
    report.violations.push({
      kind: "RPC_DISAGREEMENT",
      detail: `${report.rpcsUsed.join(", ")} and ${second.rpcsUsed.join(", ")} returned different reports for blocks ${report.fromBlock}-${report.toBlock} ` +
        `(decisions ${report.decisions} vs ${second.decisions}, trades ${report.trades} vs ${second.trades}, violations ${report.violations.length} vs ${second.violations.length})`,
    });
    report.clean = false;
  }
  return report;
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

    // A second RPC checks the first by default; VERIFY_CROSS_CHECK=0 skips it (it doubles the scan).
    const scan = process.env.VERIFY_CROSS_CHECK === "0" ? reconcile : reconcileCrossChecked;
    const report = await scan({ rpcUrls, covenantAddress, fromBlock: Number(fromBlock) });
    console.log(`Covenant reconciliation, blocks ${report.fromBlock}-${report.toBlock}`);
    console.log(`  agent wallet: ${report.agent}${report.agents.length > 1 ? ` (all holders: ${report.agents.join(", ")})` : ""}`);
    console.log(`  decisions:    ${report.decisions}`);
    console.log(`  trades:       ${report.trades} (${report.matched.length} matched to a settled decision)\n`);
    for (const m of report.matched) console.log(`[OK]  ${m.txHash} ${m.side} decision #${m.decisionId}, received ${m.received}`);
    for (const n of report.notices) console.log(`[notice: ${n.kind}]${n.txHash ? ` ${n.txHash}` : ""} - ${n.detail}`);
    for (const v of report.violations) console.log(`[${v.kind}] ${v.txHash ?? ""}${v.decisionId ? ` decision #${v.decisionId}` : ""} - ${v.detail}`);
    console.log(report.clean ? "\nClean: every trade maps to an approved decision." : `\n${report.violations.length} violation(s).`);
    process.exitCode = report.clean ? 0 : 1;
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
