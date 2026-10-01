import { expect } from "chai";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { verifyTx } from "../scripts/judge.js";

const COVENANT = "0x90F642be72b5aD815B924AB3CFFd5f241Dc656aa";
const HASH = "0x" + "ab".repeat(32);

/** A one-method JSON-RPC server: answers eth_getTransactionReceipt with `reply`, or a 500 when it's "down". */
function rpc(reply: unknown | "down"): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const server: Server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (reply === "down") {
          res.statusCode = 500;
          res.end("down");
          return;
        }
        const id = JSON.parse(body).id;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ jsonrpc: "2.0", id, result: reply }));
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() }));
  });
}

// A receipt for a reverted transaction is the simplest real answer: verifyTx reports it
// as "reverted", which proves it was reached, without hand-building event logs.
const REVERTED = { status: "0x0", blockNumber: "0x1", logs: [] };

describe("judge receipt lookup across endpoints", () => {
  const open: Array<{ close: () => void }> = [];
  afterEach(() => open.splice(0).forEach((s) => s.close()));
  const start = async (reply: unknown | "down") => {
    const s = await rpc(reply);
    open.push(s);
    return s.url;
  };

  it("uses a later endpoint when the first has pruned the receipt and answers null", async () => {
    const urls = [await start(null), await start(REVERTED)];
    const r = await verifyTx(urls, COVENANT, HASH);
    expect(r.detail).to.match(/reverted/);
  });

  it("uses a later endpoint when the first is down", async () => {
    const urls = [await start("down"), await start(REVERTED)];
    const r = await verifyTx(urls, COVENANT, HASH);
    expect(r.detail).to.match(/reverted/);
  });

  it("reports not found, and how many endpoints said so, only when every one comes up empty", async () => {
    const urls = [await start(null), await start("down"), await start(null)];
    const r = await verifyTx(urls, COVENANT, HASH);
    expect(r.ok).to.equal(false);
    expect(r.detail).to.match(/no receipt found on any of 3 endpoints/);
  });
});
