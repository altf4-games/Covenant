import { expect } from "chai";
import { ethers } from "ethers";
import { LowestGasFallbackProvider } from "../scripts/lib/bsc-provider.js";

const network = ethers.Network.from(56);

/** A member that quotes a fixed gas price (or fails) and never touches the network. */
class Quote extends ethers.JsonRpcProvider {
  receipt: "error" | "null" | ethers.TransactionReceipt = "null";
  constructor(private readonly gwei: string | null) {
    super("http://127.0.0.1:1", network, { staticNetwork: network });
  }
  override async getFeeData(): Promise<ethers.FeeData> {
    if (this.gwei === null) throw new Error("endpoint down");
    return new ethers.FeeData(ethers.parseUnits(this.gwei, "gwei"), null, null);
  }
}

describe("bscProvider gas pricing and receipts", () => {
  it("uses the lowest quote, not whichever endpoint answered first (48Club quotes 1 gwei, the rest 0.05)", async () => {
    const p = new LowestGasFallbackProvider([new Quote("1"), new Quote("0.05"), new Quote("0.05")], network);
    expect((await p.getFeeData()).gasPrice).to.equal(ethers.parseUnits("0.05", "gwei"));
    await p.destroy();
  });

  it("ignores an endpoint that fails", async () => {
    const p = new LowestGasFallbackProvider([new Quote(null), new Quote("0.07")], network);
    expect((await p.getFeeData()).gasPrice).to.equal(ethers.parseUnits("0.07", "gwei"));
    await p.destroy();
  });

  const FOUND = { hash: "0xabc", status: 1 } as unknown as ethers.TransactionReceipt;

  it("skips an endpoint whose receipt lookup errors (publicnode's 403 on a just-sent tx) and uses another that has it", async () => {
    const [bad, good] = [new Quote("0.05"), new Quote("0.05")];
    bad.getTransactionReceipt = async () => { throw new Error("403 archive requests require a token"); };
    good.getTransactionReceipt = async () => FOUND;
    const p = new LowestGasFallbackProvider([bad, good], network);
    expect(await p.getTransactionReceipt("0xabc")).to.equal(FOUND);
    await p.destroy();
  });

  it("returns null (not an error) when some endpoint errors and the rest simply don't have the tx yet", async () => {
    const [bad, none] = [new Quote("0.05"), new Quote("0.05")];
    bad.getTransactionReceipt = async () => { throw new Error("403"); };
    none.getTransactionReceipt = async () => null;
    const p = new LowestGasFallbackProvider([bad, none], network);
    expect(await p.getTransactionReceipt("0xabc")).to.equal(null);
    await p.destroy();
  });

  it("throws only when every endpoint errors", async () => {
    const a = new Quote("0.05");
    a.getTransactionReceipt = async () => { throw new Error("all down"); };
    const p = new LowestGasFallbackProvider([a], network);
    let threw = false;
    await p.getTransactionReceipt("0xabc").catch(() => (threw = true));
    expect(threw).to.equal(true);
    await p.destroy();
  });
});
