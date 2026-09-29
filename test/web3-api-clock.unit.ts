import { expect } from "chai";
import { createHmac } from "node:crypto";
import { web3ApiGet, resetClockOffset } from "../scripts/lib/web3-api-client.js";

const creds = { apiKey: "k", secretKey: "s" };

describe("Web3 API client: a local clock outside the receive window (unit, mocked fetch)", function () {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    resetClockOffset();
  });

  it("retries once with the server's own time, then succeeds", async function () {
    const serverNow = Date.now() + 19_000; // this machine is 19 seconds slow
    const stamps: string[] = [];
    globalThis.fetch = (async (_url: unknown, init: { headers: Record<string, string> }) => {
      stamps.push(init.headers["X-OC-TIMESTAMP"]);
      const skew = Math.abs(Date.parse(init.headers["X-OC-TIMESTAMP"]) - serverNow);
      const body =
        skew > 5_000
          ? { code: 40103, msg: `Timestamp outside recv_window. serverTime=${new Date(serverNow).toISOString().replace("Z", "123456Z")}` }
          : { code: 0, data: { ok: true } };
      return { ok: skew <= 5_000, status: skew <= 5_000 ? 200 : 401, json: async () => body };
    }) as unknown as typeof fetch;

    expect(await web3ApiGet(creds, "/api/v1/x")).to.deep.equal({ ok: true });
    expect(stamps).to.have.length(2);
    expect(Date.parse(stamps[1]) - Date.parse(stamps[0])).to.be.greaterThan(15_000);

    // the correction is remembered: the next call goes straight through
    stamps.length = 0;
    await web3ApiGet(creds, "/api/v1/y");
    expect(stamps).to.have.length(1);
  });

  it("gives up after one correction instead of looping, and reports the API's own error", async function () {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return { ok: false, status: 401, json: async () => ({ code: 40103, msg: "Timestamp outside recv_window. serverTime=2026-09-29T09:37:13.075Z" }) };
    }) as unknown as typeof fetch;
    let message = "";
    try {
      await web3ApiGet(creds, "/api/v1/x");
    } catch (e) {
      message = (e as Error).message;
    }
    expect(calls).to.equal(2);
    expect(message).to.match(/code=40103/);
  });

  it("does not retry other errors", async function () {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return { ok: false, status: 403, json: async () => ({ code: 40304, msg: "compliance restriction" }) };
    }) as unknown as typeof fetch;
    let message = "";
    try {
      await web3ApiGet(creds, "/api/v1/x");
    } catch (e) {
      message = (e as Error).message;
    }
    expect(calls).to.equal(1);
    expect(message).to.match(/compliance restriction/);
  });

  it("does not retry an error that happens to mention a server time", async function () {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return { ok: false, status: 403, json: async () => ({ code: 40304, msg: "compliance restriction, serverTime=2026-09-29T09:37:13.075Z" }) };
    }) as unknown as typeof fetch;
    let message = "";
    try {
      await web3ApiGet(creds, "/api/v1/x");
    } catch (e) {
      message = (e as Error).message;
    }
    expect(calls).to.equal(1);
    expect(message).to.match(/compliance restriction/);
  });

  it("treats an HTTP error status as an error even when the body says code 0", async function () {
    globalThis.fetch = (async () => ({ ok: false, status: 502, json: async () => ({ code: 0, data: { fake: true } }) })) as unknown as typeof fetch;
    let message = "";
    try {
      await web3ApiGet(creds, "/api/v1/x");
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).to.match(/HTTP 502/);
  });

  it("signs timestamp + GET + /build + path + query with HMAC-SHA256 of the secret, base64", async function () {
    let seen: { url: string; headers: Record<string, string> } | undefined;
    globalThis.fetch = (async (url: string, init: { headers: Record<string, string> }) => {
      seen = { url, headers: init.headers };
      return { ok: true, status: 200, json: async () => ({ code: 0, data: 1 }) };
    }) as unknown as typeof fetch;
    await web3ApiGet(creds, "/api/v1/dex/market/rwa/tokens", { platformId: "bstock", note: "a b&c" });
    const query = "platformId=bstock&note=a%20b%26c";
    expect(seen!.url).to.equal(`https://web3.binance.com/build/api/v1/dex/market/rwa/tokens?${query}`);
    const expected = createHmac("sha256", "s").update(seen!.headers["X-OC-TIMESTAMP"] + "GET" + `/build/api/v1/dex/market/rwa/tokens?${query}`, "utf8").digest("base64");
    expect(seen!.headers["X-OC-SIGN"]).to.equal(expected);
    expect(seen!.headers["X-OC-APIKEY"]).to.equal("k");
  });
});
