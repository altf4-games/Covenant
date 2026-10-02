import { expect } from "chai";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { reconcile, reconcileCrossChecked } from "../scripts/verify.js";
import { TOPICS } from "../scripts/judge.js";

// verify.ts against a small in-process JSON-RPC server fed crafted logs:
// deterministic, fast, and independent of any fork or Binance endpoint, so
// it runs in hosted CI too. test/verify.live.ts covers the same code against
// real swaps on a real fork.
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const TOKEN_CONFIGURED = "0xb110cbefb429de4c581a73938523a8acbe216e53f923683a5686589669b57b16";
const AGENT_CHANGED = "0x4a2e63eb36ad3c667a1d8d1b18dfbf37d06f96b46b82b526a855175916515add";
const ORACLE_UPDATER_CHANGED = "0x533d09c424dd042c543d0802296b09115923bce3f566e20c069e3d754a8aff8f";
const MANDATE_REVOKED = "0x2baefe0377ed7e2b674c85b23075a590dab754e30d405e69dfe391fcc9c4d2c8";

const COV = "0x" + "c0".repeat(20);
const USDT = "0x" + "55".repeat(20);
const NVDA = "0x" + "aa".repeat(20);
const AAPL = "0x" + "bb".repeat(20);
const OLD = "0x" + "01".repeat(20);
const NEW = "0x" + "02".repeat(20);
const THIRD = "0x" + "03".repeat(20);
const DEX = "0x" + "de".repeat(20);
const UPDATER = "0x" + "09".repeat(20);
const E18 = 10n ** 18n;
const TTL = 600;

const word = (x: bigint | string) => (typeof x === "string" ? x.replace(/^0x/, "").toLowerCase().padStart(64, "0") : x.toString(16).padStart(64, "0"));
const h = (n: number) => "0x" + n.toString(16).padStart(64, "0");

interface RawLog { address: string; topics: string[]; data: string; blockNumber: string; transactionHash: string; transactionIndex: string; logIndex: string }

class Chain {
  logs: RawLog[] = [];
  agent = OLD;
  agentAtBlock: Record<number, string> = {};
  nextDecisionId = 1n;
  tip = 1000;

  log(address: string, topics: string[], data: string, block: number, tx: string, txIndex = 0) {
    this.logs.push({ address, topics: topics.map((t) => "0x" + word(t)), data: "0x" + data, blockNumber: "0x" + block.toString(16), transactionHash: tx, transactionIndex: "0x" + txIndex.toString(16), logIndex: "0x" + this.logs.length.toString(16) });
  }
  configure(token: string, allowed = true, block = 2) {
    this.log(COV, [TOKEN_CONFIGURED, token], word(allowed ? 1n : 0n) + word(100n) + word(0n), block, h(900 + block));
  }
  /** The constructor's transaction: OracleUpdaterChanged and AgentChanged together. */
  deploy(block = 1) {
    this.log(COV, [ORACLE_UPDATER_CHANGED, UPDATER], "", block, h(800 + block));
    this.log(COV, [AGENT_CHANGED, this.agent], "", block, h(800 + block));
  }
  agentChanged(agent: string, block: number) {
    this.log(COV, [AGENT_CHANGED, agent], "", block, h(800 + block));
  }
  revoke(block: number) {
    this.log(COV, [MANDATE_REVOKED], "", block, h(700 + block));
  }
  commit(id: number, token: string, side: 0 | 1, amountIn: bigint, quotedOut: bigint, minOut: bigint, block: number, expiresAt = 1000 + block + TTL) {
    const fields = [BigInt(side), 1n, 0n, amountIn, quotedOut, minOut, 0n, 0n, BigInt(expiresAt), 0n, 0n, 0n, 0n];
    this.log(COV, [TOPICS.DecisionCommitted, BigInt(id).toString(16), token], fields.map((v) => word(v)).join(""), block, h(100 + id));
    if (BigInt(id) >= this.nextDecisionId) this.nextDecisionId = BigInt(id) + 1n;
  }
  settle(id: number, swapTx: string, amountOut: bigint, block: number) {
    this.log(COV, [TOPICS.DecisionSettled, BigInt(id).toString(16), swapTx], [amountOut, 3n, 0n].map(word).join(""), block, h(200 + id));
  }
  transfer(token: string, from: string, to: string, amount: bigint, block: number, tx: string) {
    this.log(token, [TRANSFER, from, to], word(amount), block, tx);
  }

  /** Who sent a transaction, when a test cares. Otherwise the agent-side wallet that received a Transfer in it. */
  txFrom: Record<string, string> = {};

  handle(method: string, params: any[]): unknown {
    if (method === "eth_getTransactionByHash") {
      const hash = String(params[0]).toLowerCase();
      const wallet = this.logs.find((l) => l.transactionHash.toLowerCase() === hash && l.topics[0] === TRANSFER && [OLD, NEW].includes("0x" + l.topics[2].slice(-40)));
      return { hash, from: this.txFrom[hash] ?? (wallet ? "0x" + wallet.topics[2].slice(-40) : OLD) };
    }
    if (method === "eth_getTransactionReceipt") {
      const hash = String(params[0]).toLowerCase();
      return { transactionHash: hash, logs: this.logs.filter((l) => l.transactionHash.toLowerCase() === hash) };
    }
    if (method === "eth_blockNumber") return "0x" + this.tip.toString(16);
    if (method === "eth_getBlockByNumber") return { timestamp: "0x" + (1000 + parseInt(params[0], 16)).toString(16) };
    if (method === "eth_call") {
      const data = params[0].data;
      if (data === "0xf5ff5c76") {
        const at = params[1] && params[1] !== "latest" ? this.agentAtBlock[parseInt(params[1], 16)] : undefined;
        return "0x" + word(at ?? this.agent);
      }
      if (data === "0x217a4b70") return "0x" + word(USDT);
      if (data === "0x081cb670") return "0x" + word(this.nextDecisionId);
      if (data === "0x072aaa5c") return "0x" + word(BigInt(TTL));
      throw new Error(`unexpected eth_call ${data}`);
    }
    if (method === "eth_getLogs") {
      const f = params[0];
      const from = parseInt(f.fromBlock, 16);
      const to = parseInt(f.toBlock, 16);
      return this.logs.filter((l) => {
        const b = parseInt(l.blockNumber, 16);
        return (Array.isArray(f.address) ? f.address.map((a: string) => a.toLowerCase()).includes(l.address) : l.address === f.address.toLowerCase()) && b >= from && b <= to && (f.topics ?? []).every((t: string | null, i: number) => t === null || l.topics[i] === t.toLowerCase());
      });
    }
    throw new Error(`unexpected method ${method}`);
  }
}

describe("verify.ts reconcile() (unit, mock RPC, crafted logs)", function () {
  let server: http.Server;
  let url: string;
  let chain: Chain;

  before(async function () {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const { id, method, params } = JSON.parse(body);
        try {
          res.end(JSON.stringify({ jsonrpc: "2.0", id, result: chain.handle(method, params) }));
        } catch (err) {
          res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: (err as Error).message } }));
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => server.close());

  beforeEach(() => {
    chain = new Chain();
    chain.deploy(1);
    chain.configure(NVDA);
  });

  const run = (fromBlock = 1, chunkSize = 50) => reconcile({ rpcUrls: [url], covenantAddress: COV, fromBlock, chunkSize });
  const kinds = (r: Awaited<ReturnType<typeof run>>) => r.violations.map((v) => v.kind);

  /** A $1 buy of NVDA quoted at 0.005 NVDA, filled honestly. */
  function honestBuy(id = 1, block = 10) {
    chain.commit(id, NVDA, 0, E18, 5n * 10n ** 15n, 49n * 10n ** 14n, block);
    chain.transfer(USDT, OLD, DEX, E18, block + 1, h(block + 1));
    chain.transfer(NVDA, DEX, OLD, 5n * 10n ** 15n, block + 1, h(block + 1));
    chain.settle(id, h(block + 1), 5n * 10n ** 15n, block + 2);
  }

  it("an honest buy reconciles clean", async function () {
    honestBuy();
    const r = await run();
    expect(r.violations).to.deep.equal([]);
    expect(r.matched).to.have.length(1);
  });

  it("H13: a buy that really spent far more USDT than its approved amountIn is flagged (the $1-approved, $10,000-spent repro)", async function () {
    chain.commit(1, NVDA, 0, E18, 5n * 10n ** 15n, 49n * 10n ** 14n, 10);
    chain.transfer(USDT, OLD, DEX, 10_000n * E18, 11, h(11));
    chain.transfer(NVDA, DEX, OLD, 50n * E18, 11, h(11));
    chain.settle(1, h(11), 50n * E18, 12);
    expect(kinds(await run())).to.include("AMOUNT_IN_EXCEEDED");
  });

  it("H13: a buy paid in something other than USDT still can't receive more stock than amountIn could buy", async function () {
    chain.commit(1, NVDA, 0, E18, 5n * 10n ** 15n, 49n * 10n ** 14n, 10);
    // No USDT leaves the wallet (paid in native BNB, say), but 50 NVDA arrive.
    chain.transfer(NVDA, DEX, OLD, 50n * E18, 11, h(11));
    chain.settle(1, h(11), 50n * E18, 12);
    expect(kinds(await run())).to.include("AMOUNT_IN_EXCEEDED");
  });

  it("H13: a buy within the received tolerance (price improvement) stays clean", async function () {
    chain.commit(1, NVDA, 0, E18, 5n * 10n ** 15n, 49n * 10n ** 14n, 10);
    chain.transfer(USDT, OLD, DEX, E18, 11, h(11));
    chain.transfer(NVDA, DEX, OLD, 52n * 10n ** 14n, 11, h(11)); // +4% over the quote
    chain.settle(1, h(11), 52n * 10n ** 14n, 12);
    expect((await run()).violations).to.deep.equal([]);
  });

  it("H13: a sell that sent more stock than its approved amountIn is flagged", async function () {
    chain.commit(1, NVDA, 1, 1n, 1n, 0n, 10);
    chain.transfer(NVDA, OLD, DEX, 1000n * E18, 11, h(11));
    chain.transfer(USDT, DEX, OLD, 180_000n * E18, 11, h(11));
    chain.settle(1, h(11), 180_000n * E18, 12);
    expect(kinds(await run())).to.include("AMOUNT_IN_EXCEEDED");
  });

  it("a transaction moving a second configured stock is flagged, not ignored", async function () {
    chain.configure(AAPL);
    honestBuy();
    chain.transfer(AAPL, DEX, OLD, 500n * E18, 11, h(11)); // same tx as the honest buy
    expect(kinds(await run())).to.include("MULTI_TOKEN_TRADE");
  });

  it("H14: rotating the agent doesn't erase the old wallet's unmatched trade", async function () {
    chain.transfer(NVDA, DEX, OLD, 7n * E18, 11, h(11));
    chain.agentChanged(NEW, 20);
    chain.agent = NEW;
    const r = await run();
    expect(kinds(r)).to.deep.equal(["UNMATCHED_TRADE"]);
    expect(r.agents).to.have.members([OLD, NEW]);
  });

  it("H14: the old wallet is in scope for one decision TTL after rotation, and out of scope after", async function () {
    chain.agentChanged(NEW, 20);
    chain.agent = NEW;
    chain.transfer(NVDA, DEX, OLD, E18, 20 + TTL - 1, h(20 + TTL - 1)); // inside the TTL: flagged
    chain.transfer(NVDA, DEX, OLD, E18, 20 + TTL + 50, h(20 + TTL + 50)); // well after: not Covenant's concern
    chain.tip = 2000;
    const r = await run();
    expect(r.violations.map((v) => v.txHash)).to.deep.equal([h(20 + TTL - 1)]);
  });

  it("H14: a trade by a different wallet than the one that committed the decision is flagged", async function () {
    chain.commit(1, NVDA, 0, E18, 5n * 10n ** 15n, 49n * 10n ** 14n, 10); // committed while OLD held the role
    chain.agentChanged(NEW, 11);
    chain.agent = NEW;
    chain.transfer(USDT, NEW, DEX, E18, 12, h(12));
    chain.transfer(NVDA, DEX, NEW, 5n * 10n ** 15n, 12, h(12));
    chain.settle(1, h(12), 5n * 10n ** 15n, 13);
    expect(kinds(await run())).to.include("AGENT_MISMATCH");
  });

  it("H14 follow-up: a wallet that held the agent role twice is scoped against its most recent handover, not its first", async function () {
    // Red-team follow-up on H14: inScope() used to pick tenures.find()'s
    // FIRST matching handover for a wallet, not the most recent one. OLD
    // holds the role, hands to NEW, gets it back, then hands to THIRD -
    // OLD's real, relevant handover for anything it does afterward is the
    // one to THIRD, not the much older one to NEW. A trade just after that
    // real handover, well inside TTL, used to be measured against the
    // stale one to NEW instead and wrongly reported as a violation once
    // enough real time had passed since it (proven live before this fix).
    chain.agentChanged(NEW, 20);
    chain.agentChanged(OLD, 800);
    chain.agentChanged(THIRD, 820);
    chain.agent = THIRD;

    chain.commit(1, NVDA, 0, E18, 5n * 10n ** 15n, 49n * 10n ** 14n, 810); // committed while OLD legitimately held the role again
    chain.transfer(USDT, OLD, DEX, E18, 825, h(825)); // 5 blocks after OLD's real (second) handover - well inside TTL=600
    chain.transfer(NVDA, DEX, OLD, 5n * 10n ** 15n, 825, h(825));
    chain.settle(1, h(825), 5n * 10n ** 15n, 826);

    chain.tip = 2000;
    expect((await run()).violations).to.deep.equal([]);
  });

  it("a swap after the mandate was revoked, under an approval from before, is flagged", async function () {
    chain.commit(1, NVDA, 0, E18, 5n * 10n ** 15n, 49n * 10n ** 14n, 10);
    chain.revoke(11);
    chain.transfer(USDT, OLD, DEX, E18, 12, h(12));
    chain.transfer(NVDA, DEX, OLD, 5n * 10n ** 15n, 12, h(12));
    chain.settle(1, h(12), 5n * 10n ** 15n, 13);
    expect(kinds(await run())).to.include("SWAP_AFTER_REVOKE");
  });

  it("a swap after its token was disallowed, under an approval from before, is flagged", async function () {
    chain.commit(1, NVDA, 0, E18, 5n * 10n ** 15n, 49n * 10n ** 14n, 10);
    chain.configure(NVDA, false, 11);
    chain.transfer(USDT, OLD, DEX, E18, 12, h(12));
    chain.transfer(NVDA, DEX, OLD, 5n * 10n ** 15n, 12, h(12));
    chain.settle(1, h(12), 5n * 10n ** 15n, 13);
    expect(kinds(await run())).to.include("SWAP_AFTER_REVOKE");
  });

  it("a scan that misses Covenant's deployment says so - an unmatched trade it can't see never reads clean", async function () {
    // Deployed and NVDA configured at blocks 1-2; the scan starts at 20, so
    // it never sees the TokenConfigured event and can't know NVDA is a stock.
    chain.transfer(NVDA, DEX, OLD, 7n * E18, 30, h(30)); // a trade with no decision at all
    const r = await run(20);
    expect(r.clean).to.equal(false);
    expect(kinds(r)).to.deep.equal(["INCOMPLETE_RANGE"]);
    // From the deployment block, the same trade is caught for what it is.
    expect(kinds(await run(1))).to.deep.equal(["UNMATCHED_TRADE"]);
  });

  it("finds transfers on both sides of every getLogs chunk boundary", async function () {
    for (const b of [50, 51, 100, 101, 256]) chain.transfer(NVDA, DEX, OLD, 1n, b, h(b));
    expect(kinds(await run(1, 50))).to.deep.equal(Array(5).fill("UNMATCHED_TRADE"));
  });

  it("a stranger dusting a configured stock into the wallet is a notice, not a violation", async function () {
    honestBuy();
    chain.transfer(NVDA, THIRD, OLD, 1n, 30, h(3000));
    chain.txFrom[h(3000)] = THIRD;
    const r = await run();
    expect(r.violations).to.deep.equal([]);
    expect(r.clean).to.equal(true);
    expect(r.notices.map((n) => n.kind)).to.deep.equal(["INBOUND_TRANSFER"]);
    expect(r.trades).to.equal(1);
  });

  it("stock arriving in a transaction the wallet itself sent, with no payment in the quote token, is still a trade", async function () {
    // e.g. a buy paid for in native BNB: no USDT moves, but the wallet sent the transaction.
    chain.transfer(NVDA, DEX, OLD, 5n * 10n ** 15n, 10, h(4100));
    chain.txFrom[h(4100)] = OLD;
    const r = await run();
    expect(kinds(r)).to.deep.equal(["UNMATCHED_TRADE"]);
  });

  it("spending the quote token on a stock the owner never configured is flagged", async function () {
    chain.transfer(USDT, OLD, DEX, 1000n * E18, 10, h(4000));
    chain.transfer(AAPL, DEX, OLD, 5n * E18, 10, h(4000));
    const r = await run();
    expect(kinds(r)).to.deep.equal(["UNTRACKED_SWAP"]);
    expect(r.clean).to.equal(false);
  });

  it("paying the quote token to a non-token recipient (no token comes back) is not a swap", async function () {
    chain.transfer(USDT, OLD, DEX, E18, 10, h(4200));
    const r = await run();
    expect(r.violations).to.deep.equal([]);
  });


  it("dust bundled with 1 wei of the quote token is still just a notice", async function () {
    honestBuy();
    chain.transfer(NVDA, THIRD, OLD, 1n, 30, h(3000));
    chain.transfer(USDT, THIRD, OLD, 1n, 30, h(3000));
    chain.txFrom[h(3000)] = THIRD;
    const r = await run();
    expect(r.violations).to.deep.equal([]);
    expect(r.notices.map((n) => n.kind)).to.deep.equal(["INBOUND_TRANSFER"]);
  });

  it("the quote token leaving the wallet with nothing coming back is listed as a notice, not invisible", async function () {
    chain.transfer(USDT, OLD, THIRD, 1000n * E18, 30, h(3100));
    const r = await run();
    expect(r.violations).to.deep.equal([]);
    expect(r.notices.map((n) => n.kind)).to.deep.equal(["QUOTE_OUTFLOW"]);
    expect(r.notices[0].detail).to.contain((1000n * E18).toString());
  });

  it("scans each direction once however many tokens are configured", async function () {
    for (const t of [AAPL, "0x" + "cc".repeat(20), "0x" + "dd".repeat(20)]) chain.configure(t, true, 3);
    const seen: number[] = [];
    const orig = chain.handle.bind(chain);
    chain.handle = (method: string, params: any[]) => {
      if (method === "eth_getLogs" && Array.isArray(params[0].address)) seen.push(params[0].address.length);
      return orig(method, params);
    };
    await run(1, 100_000);
    // one wallet: an inbound and an outbound scan, each over 4 stocks + the quote token
    expect(seen).to.deep.equal([5, 5]);
  });


  // Mutation testing (deleting or flipping each check in verify.ts) showed that
  // five violation kinds and several boundaries had no test at all: the suite
  // passed with the check gone. One crafted case each.
  describe("every violation kind, and the boundaries between clean and flagged", function () {
    const WBNB = "0x" + "bb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c";
    const QUOTED = 5n * 10n ** 15n;
    const MIN = 49n * 10n ** 14n;

    /** A $1 buy committed at `commitBlock`, its swap in `swapBlock` receiving `received`, settled with `settled`. */
    function buy({ commitBlock = 10, swapBlock = 11, received = QUOTED, settled = received, minOut = MIN, id = 1, token = NVDA, spent = E18 }: Partial<Record<string, any>> = {}) {
      chain.commit(id, token, 0, E18, QUOTED, minOut, commitBlock);
      chain.transfer(USDT, OLD, DEX, spent, swapBlock, h(swapBlock));
      chain.transfer(token, DEX, OLD, received, swapBlock, h(swapBlock));
      chain.settle(id, h(swapBlock), settled, swapBlock + 1);
    }

    it("BELOW_MINIMUM: a fill under the committed minimum, and exactly the minimum is fine", async function () {
      buy({ received: MIN - 1n });
      expect(kinds(await run())).to.deep.equal(["BELOW_MINIMUM"]);
    });
    it("BELOW_MINIMUM: exactly the minimum is clean", async function () {
      buy({ received: MIN });
      expect((await run()).violations).to.deep.equal([]);
    });

    it("AMOUNT_MISMATCH: a settle that claims something other than what arrived", async function () {
      buy({ settled: QUOTED + 1n });
      expect(kinds(await run())).to.deep.equal(["AMOUNT_MISMATCH"]);
    });

    it("SWAP_BEFORE_COMMIT: the trade landed before its decision was committed", async function () {
      buy({ commitBlock: 12, swapBlock: 10 });
      expect(kinds(await run())).to.deep.equal(["SWAP_BEFORE_COMMIT"]);
    });

    it("the decision's expiry is inclusive: a swap in the last second is clean, one second later is flagged", async function () {
      // block time = 1000 + block number; a decision at block 10 expires at 1010 + TTL
      buy({ swapBlock: 10 + TTL });
      expect((await run(1, 5000)).violations).to.deep.equal([]);
      chain = new Chain(); chain.deploy(1); chain.configure(NVDA);
      buy({ swapBlock: 11 + TTL });
      expect(kinds(await run(1, 5000))).to.deep.equal(["SWAP_AFTER_EXPIRY"]);
    });

    it("TOKEN_MISMATCH: the decision was for one stock and the wallet received another", async function () {
      chain.configure(AAPL, true, 3);
      buy({ token: AAPL, id: 1 });
      // rewrite the commit to name NVDA: the trade moved AAPL
      chain.logs = chain.logs.filter((l) => !(l.topics[0] === "0x" + word(TOPICS.DecisionCommitted)));
      chain.commit(1, NVDA, 0, E18, QUOTED, MIN, 10);
      expect(kinds(await run())).to.deep.equal(["TOKEN_MISMATCH"]);
    });

    it("SIDE_MISMATCH: the decision said buy and the wallet sold", async function () {
      chain.commit(1, NVDA, 0, E18, QUOTED, MIN, 10);
      chain.transfer(NVDA, OLD, DEX, QUOTED, 11, h(11));
      chain.transfer(USDT, DEX, OLD, E18, 11, h(11));
      chain.settle(1, h(11), E18, 12);
      expect(kinds(await run())).to.deep.equal(["SIDE_MISMATCH"]);
    });

    it("DUPLICATE_SETTLE: two decisions claiming one trade", async function () {
      buy({ id: 1 });
      chain.commit(2, NVDA, 0, E18, QUOTED, MIN, 20);
      chain.settle(2, h(11), QUOTED, 21);
      expect(kinds(await run())).to.deep.equal(["DUPLICATE_SETTLE"]);
    });

    it("FALSE_SETTLE: a settle whose commit isn't in the scanned range", async function () {
      chain.transfer(USDT, OLD, DEX, E18, 11, h(11));
      chain.transfer(NVDA, DEX, OLD, QUOTED, 11, h(11));
      chain.settle(7, h(11), QUOTED, 12);
      const r = await run();
      expect(kinds(r)).to.deep.equal(["FALSE_SETTLE"]);
      expect(r.violations[0].detail).to.contain("no commit");
    });

    it("a buy that received exactly its quote plus the tolerance is clean, a wei more is flagged", async function () {
      const limit = (QUOTED * 10_500n) / 10_000n;
      buy({ received: limit });
      expect((await run()).violations).to.deep.equal([]);
      chain = new Chain(); chain.deploy(1); chain.configure(NVDA);
      buy({ received: limit + 1n });
      expect(kinds(await run())).to.deep.equal(["AMOUNT_IN_EXCEEDED"]);
    });

    it("what a buy really spent is net of anything refunded in the same transaction", async function () {
      buy({ spent: 12n * 10n ** 17n });
      chain.transfer(USDT, DEX, OLD, 3n * 10n ** 17n, 11, h(11)); // 1.2 out, 0.3 refunded: 0.9 net, under the $1 approved
      expect((await run()).violations).to.deep.equal([]);
    });

    it("what a sell received is net of what left in the same transaction, and the stock that left is what it spent", async function () {
      chain.commit(1, NVDA, 1, QUOTED, E18, (E18 * 99n) / 100n, 10);
      chain.transfer(NVDA, OLD, DEX, QUOTED, 11, h(11));
      chain.transfer(USDT, DEX, OLD, E18, 11, h(11));
      chain.transfer(USDT, OLD, DEX, 10n ** 16n, 11, h(11)); // a 0.01 fee out: 0.99 net
      chain.settle(1, h(11), (E18 * 99n) / 100n, 12);
      const r = await run();
      expect(r.violations).to.deep.equal([]);
      expect(r.matched.map((m) => m.side)).to.deep.equal(["sell"]);
    });

    it("the old wallet's TTL window is inclusive: a trade in the last second is flagged, one second later is not", async function () {
      chain.agentChanged(NEW, 50); // handover at time 1050; the window runs to 1050 + TTL
      chain.transfer(NVDA, DEX, OLD, QUOTED, 50 + TTL, h(900));
      chain.transfer(USDT, OLD, DEX, E18, 50 + TTL, h(900));
      expect(kinds(await run(1, 5000))).to.deep.equal(["UNMATCHED_TRADE"]);
      chain = new Chain(); chain.deploy(1); chain.configure(NVDA);
      chain.agentChanged(NEW, 50);
      chain.transfer(NVDA, DEX, OLD, QUOTED, 51 + TTL, h(901));
      chain.transfer(USDT, OLD, DEX, E18, 51 + TTL, h(901));
      expect((await run(1, 5000)).violations).to.deep.equal([]);
    });

    it("stock a stranger sent is a gift, but a transaction the wallet paid the quote token in is a trade whoever sent it", async function () {
      chain.transfer(USDT, OLD, DEX, E18, 30, h(3300));
      chain.transfer(NVDA, DEX, OLD, QUOTED, 30, h(3300));
      chain.txFrom[h(3300)] = THIRD; // e.g. sent by a sponsor on the wallet's behalf
      const r = await run();
      expect(kinds(r)).to.deep.equal(["UNMATCHED_TRADE"]);
      expect(r.notices).to.deep.equal([]);
    });

    it("stock from a stranger's transaction that a settle claims is reconciled as a trade, not waved through as a gift", async function () {
      chain.commit(1, NVDA, 0, E18, QUOTED, MIN, 10);
      chain.transfer(NVDA, DEX, OLD, QUOTED, 11, h(11));
      chain.txFrom[h(11)] = THIRD;
      chain.settle(1, h(11), QUOTED, 12);
      const r = await run();
      expect(r.violations).to.deep.equal([]);
      expect(r.matched).to.have.length(1);
      expect(r.notices).to.deep.equal([]);
    });

    it("UNTRACKED_SWAP ignores the quote token coming back as change, a wrapped-BNB refund, and a configured stock that nets to zero", async function () {
      // quote token out, part of it back: net out, but nothing unconfigured received
      chain.transfer(USDT, OLD, DEX, E18, 30, h(3401));
      chain.transfer(USDT, DEX, OLD, E18 / 2n, 30, h(3401));
      // quote token out and wrapped BNB back
      chain.transfer(USDT, OLD, DEX, E18, 31, h(3402));
      chain.transfer(WBNB, DEX, OLD, 10n ** 15n, 31, h(3402));
      // quote token out; a configured stock in and out again, net zero
      chain.transfer(USDT, OLD, DEX, E18, 32, h(3403));
      chain.transfer(NVDA, DEX, OLD, QUOTED, 32, h(3403));
      chain.transfer(NVDA, OLD, DEX, QUOTED, 32, h(3403));
      const r = await run();
      expect(r.violations).to.deep.equal([]);
      expect(r.notices.map((n) => n.kind)).to.deep.equal(["QUOTE_OUTFLOW", "QUOTE_OUTFLOW", "QUOTE_OUTFLOW"]);
    });

    it("a quote-token round trip that nets to zero is neither an outflow notice nor an untracked swap", async function () {
      chain.transfer(USDT, OLD, DEX, E18, 30, h(3500));
      chain.transfer(USDT, DEX, OLD, E18, 30, h(3500));
      chain.transfer(AAPL, DEX, OLD, 5n * E18, 30, h(3500)); // an unconfigured token arrives too
      const r = await run();
      expect(r.violations).to.deep.equal([]);
      expect(r.notices).to.deep.equal([]);
    });
  });


  // Randomized, seeded scenarios: two tokens, buys and sells with random amounts, refunds,
  // strangers' dust and payments. Honest histories must reconcile clean, and one corrupted
  // trade among honest ones must be flagged as exactly the expected kind, on exactly that
  // trade, with every other trade still matched.
  describe("randomized scenarios", function () {
    let seed = 0xdeadbeefcafef00dn;
    const rnd = () => { seed ^= (seed << 13n) & ((1n << 64n) - 1n); seed ^= seed >> 7n; seed ^= (seed << 17n) & ((1n << 64n) - 1n); return seed; };
    const between = (lo: bigint, hi: bigint) => lo + (rnd() % (hi - lo + 1n));
    const TOKENS = [NVDA, AAPL];

    interface Trade { id: number; token: string; side: 0 | 1; amountIn: bigint; quoted: bigint; minOut: bigint; commitBlock: number; swapBlock: number; received: bigint; spent: bigint; stockMoved: bigint; settled: bigint }

    function makeHonest(n: number): Trade[] {
      const trades: Trade[] = [];
      let block = 10;
      for (let i = 1; i <= n; i++) {
        const side = Number(rnd() % 2n) as 0 | 1;
        const token = TOKENS[Number(rnd() % 2n)];
        const amountIn = between(1000n, 10n ** 18n);
        const quoted = between(1000n, 10n ** 16n);
        const minOut = (quoted * 99n) / 100n;
        const received = side === 0 ? between(minOut, (quoted * 10500n) / 10000n) : between(minOut, quoted * 3n);
        const spent = side === 0 ? between(1n, amountIn) : 0n;
        const stockMoved = side === 0 ? 0n : between(1n, amountIn);
        trades.push({ id: i, token, side, amountIn, quoted, minOut, commitBlock: block, swapBlock: block + 1, received, spent, stockMoved, settled: received });
        block += 5;
      }
      return trades;
    }

    function play(trades: Trade[], skipSettle = -1, extra?: (t: Trade) => void) {
      for (const t of trades) {
        chain.commit(t.id, t.token, t.side, t.amountIn, t.quoted, t.minOut, t.commitBlock);
        const tx = h(2000 + t.id);
        if (t.side === 0) {
          chain.transfer(USDT, OLD, DEX, t.spent, t.swapBlock, tx);
          chain.transfer(t.token, DEX, OLD, t.received, t.swapBlock, tx);
        } else {
          chain.transfer(t.token, OLD, DEX, t.stockMoved, t.swapBlock, tx);
          chain.transfer(USDT, DEX, OLD, t.received, t.swapBlock, tx);
        }
        extra?.(t);
        if (t.id !== skipSettle) chain.settle(t.id, tx, t.settled, t.swapBlock + 1);
      }
    }

    beforeEach(() => chain.configure(AAPL, true, 3));

    it("200 random honest histories (buys, sells, two tokens, strangers' dust, payments) reconcile clean", async function () {
      for (let round = 0; round < 200; round++) {
        chain = new Chain(); chain.deploy(1); chain.configure(NVDA); chain.configure(AAPL, true, 3);
        const trades = makeHonest(Number(between(1n, 6n)));
        play(trades);
        if (rnd() % 2n === 0n) { chain.transfer(NVDA, THIRD, OLD, 1n, 500, h(9000)); chain.txFrom[h(9000)] = THIRD; }
        if (rnd() % 2n === 0n) { chain.transfer(USDT, OLD, THIRD, 5n, 501, h(9001)); }
        const r = await run(1, 100_000);
        expect(r.violations, `round ${round}`).to.deep.equal([]);
        expect(r.matched).to.have.length(trades.length);
      }
    });

    const MUTATIONS: Array<{ kind: string; apply: (trades: Trade[], k: number) => void; skip?: boolean; extra?: (t: Trade) => void }> = [
      { kind: "AMOUNT_MISMATCH", apply: (ts, k) => { ts[k].settled = ts[k].received + 1n; } },
      { kind: "BELOW_MINIMUM", apply: (ts, k) => { const t = ts[k]; t.received = t.minOut - 1n; t.settled = t.received; } },
      { kind: "SWAP_BEFORE_COMMIT", apply: (ts, k) => { const t = ts[k]; t.swapBlock = t.commitBlock - 1; } },
      { kind: "SWAP_AFTER_EXPIRY", apply: (ts, k) => { const t = ts[k]; t.swapBlock = t.commitBlock + TTL + 5; } },
      { kind: "AMOUNT_IN_EXCEEDED", apply: (ts, k) => { const t = ts[k]; if (t.side === 0) t.spent = t.amountIn + 1n; else t.stockMoved = t.amountIn + 1n; } },
      { kind: "UNMATCHED_TRADE", apply: () => {}, skip: true },
    ];

    for (const m of MUTATIONS) {
      it(`one corrupted trade among honest ones is flagged as exactly ${m.kind}, on exactly that trade`, async function () {
        for (let round = 0; round < 60; round++) {
          chain = new Chain(); chain.deploy(1); chain.configure(NVDA); chain.configure(AAPL, true, 3);
          const trades = makeHonest(Number(between(2n, 5n)));
          const k = Number(rnd() % BigInt(trades.length));
          m.apply(trades, k);
          play(trades, m.skip ? trades[k].id : -1);
          const r = await run(1, 100_000);
          const bad = r.violations.filter((v) => v.kind !== m.kind);
          expect(bad, `round ${round}, trade ${trades[k].id} (${JSON.stringify(trades[k], (_, v) => typeof v === "bigint" ? v.toString() : v)})`).to.deep.equal([]);
          expect(r.violations.filter((v) => v.kind === m.kind).map((v) => v.txHash!.toLowerCase()), `round ${round}`).to.deep.equal([h(2000 + trades[k].id).toLowerCase()]);
          expect(r.matched).to.have.length(trades.length - 1);
        }
      });
    }
  });


  // Robustness against the RPC itself, not the chain: a log listed twice, one
  // endpoint dropping logs, and a second endpoint that disagrees or is down.
  describe("what the RPC returns, and a second opinion", function () {
    let server2: http.Server;
    let url2: string;
    let chain2: Chain;
    before(async function () {
      server2 = http.createServer((req, res) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          const { id, method, params } = JSON.parse(body);
          try {
            res.end(JSON.stringify({ jsonrpc: "2.0", id, result: chain2.handle(method, params) }));
          } catch (err) {
            res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: (err as Error).message } }));
          }
        });
      });
      await new Promise<void>((r) => server2.listen(0, "127.0.0.1", r));
      url2 = `http://127.0.0.1:${(server2.address() as AddressInfo).port}`;
    });
    after(() => server2.close());

    /** A second endpoint that starts as an exact copy of the first. */
    const mirror = () => {
      chain2 = Object.assign(new Chain(), chain, { logs: [...chain.logs] });
    };
    const hideTransfers = (c: Chain) => {
      const orig = c.handle.bind(c);
      c.handle = (m: string, p: any[]) => (m === "eth_getLogs" && Array.isArray(p[0].address) ? [] : orig(m, p));
    };
    const both = (fromBlock = 1) => reconcileCrossChecked({ rpcUrls: [url, url2], covenantAddress: COV, fromBlock, chunkSize: 50 });

    it("a log an RPC lists twice is one log: an honest trade stays clean", async function () {
      honestBuy();
      const orig = chain.handle.bind(chain);
      chain.handle = (m: string, p: any[]) => {
        const r = orig(m, p);
        return m === "eth_getLogs" ? [...(r as any[]), ...(r as any[])] : r;
      };
      const r = await run();
      expect(r.violations).to.deep.equal([]);
      expect(r.matched).to.have.length(1);
    });

    it("two endpoints that agree give a clean report with nothing to note", async function () {
      honestBuy();
      mirror();
      const r = await both();
      expect(r.violations).to.deep.equal([]);
      expect(r.notices).to.deep.equal([]);
      expect(r.rpcsUsed).to.deep.equal([url]);
    });

    it("an endpoint that drops every Transfer log hides a bypass from a lone scan, and the second opinion catches it", async function () {
      honestBuy();
      chain.transfer(NVDA, DEX, OLD, 5n * 10n ** 15n, 40, h(4400)); // a swap with no decision at all
      chain.transfer(USDT, OLD, DEX, E18, 40, h(4400));
      mirror();
      hideTransfers(chain); // the first endpoint is the one that lies
      const alone = await run();
      expect(alone.trades, "the lying endpoint reports no trades at all").to.equal(0);
      const checked = await both();
      expect(kinds(checked)).to.include("RPC_DISAGREEMENT");
      expect(checked.clean).to.equal(false);
      // and the honest second endpoint's own report does show the bypass
      expect(kinds(await reconcile({ rpcUrls: [url2], covenantAddress: COV, fromBlock: 1, chunkSize: 50 }))).to.deep.equal(["UNMATCHED_TRADE"]);
    });

    it("an endpoint that hides only the bypass looks perfectly clean alone, and is still caught by the second opinion", async function () {
      honestBuy();
      chain.transfer(NVDA, DEX, OLD, 5n * 10n ** 15n, 40, h(4500)); // a swap with no decision at all
      chain.transfer(USDT, OLD, DEX, E18, 40, h(4500));
      mirror();
      const orig = chain.handle.bind(chain);
      chain.handle = (m: string, p: any[]) => {
        const r = orig(m, p);
        return m === "eth_getLogs" ? (r as any[]).filter((l) => l.transactionHash !== h(4500)) : r;
      };
      const alone = await run();
      expect(alone.violations, "the lying endpoint's own report").to.deep.equal([]);
      expect(alone.clean).to.equal(true);
      const checked = await both();
      expect(kinds(checked)).to.deep.equal(["RPC_DISAGREEMENT"]);
      expect(checked.clean).to.equal(false);
    });

    it("an endpoint that refuses log requests is asked once, not on every range", async function () {
      honestBuy();
      let refusals = 0;
      const refuser = http.createServer((req, res) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          const { id, method } = JSON.parse(body);
          if (method === "eth_getLogs") refusals++;
          res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32005, message: "limit exceeded" } }));
        });
      });
      await new Promise<void>((r) => refuser.listen(0, "127.0.0.1", r));
      try {
        const refuserUrl = `http://127.0.0.1:${(refuser.address() as AddressInfo).port}`;
        const r = await reconcile({ rpcUrls: [refuserUrl, url], covenantAddress: COV, fromBlock: 1, chunkSize: 50 }); // 20 ranges
        expect(r.violations).to.deep.equal([]);
        expect(r.rpcsUsed).to.deep.equal([url]);
        expect(refusals, "getLogs requests sent to the endpoint that refuses them").to.be.lessThan(3);
      } finally {
        refuser.close();
      }
    });

    it("a request that fails a few times is retried instead of ending the whole scan", async function () {
      honestBuy();
      let failed = 0;
      const flaky = http.createServer((req, res) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", async () => {
          if (JSON.parse(body).method === "eth_getLogs" && failed < 3) {
            failed++;
            res.statusCode = 500;
            res.end("boom");
            return;
          }
          const up = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body });
          res.end(await up.text());
        });
      });
      await new Promise<void>((r) => flaky.listen(0, "127.0.0.1", r));
      try {
        const flakyUrl = `http://127.0.0.1:${(flaky.address() as AddressInfo).port}`;
        const r = await reconcile({ rpcUrls: [flakyUrl], covenantAddress: COV, fromBlock: 1, chunkSize: 50, rpcRounds: 5, retryDelayMs: 5 });
        expect(failed, "log requests that were failed on purpose").to.equal(3);
        expect(r.violations).to.deep.equal([]);
      } finally {
        flaky.close();
      }
    });

    it("still gives up, with the endpoint's own error, when every try fails", async function () {
      honestBuy();
      let error: unknown;
      try {
        await reconcile({ rpcUrls: ["http://127.0.0.1:1"], covenantAddress: COV, fromBlock: 1, chunkSize: 50, rpcRounds: 2, retryDelayMs: 5 });
      } catch (e) {
        error = e;
      }
      expect(String(error)).to.match(/all RPCs failed/);
    });

    it("says so when no second endpoint can complete the scan, rather than passing quietly", async function () {
      honestBuy();
      const noSecond = await reconcileCrossChecked({ rpcUrls: [url, "http://127.0.0.1:1"], covenantAddress: COV, fromBlock: 1, chunkSize: 50, rpcRounds: 1 });
      expect(noSecond.violations).to.deep.equal([]);
      expect(noSecond.notices.map((n) => n.kind)).to.deep.equal(["CROSS_CHECK_UNAVAILABLE"]);
      const single = await reconcileCrossChecked({ rpcUrls: [url], covenantAddress: COV, fromBlock: 1, chunkSize: 50 });
      expect(single.notices.map((n) => n.kind)).to.deep.equal(["CROSS_CHECK_UNAVAILABLE"]);
    });
  });

});
