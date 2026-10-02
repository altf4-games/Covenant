import { expect } from "chai";
import { readFileSync } from "node:fs";
import { recordedDeployment } from "../scripts/lib/deployment.js";

describe("recorded mainnet deployment (what `npm run judge` and `npm run verify` default to)", () => {
  const record = JSON.parse(readFileSync(new URL("../docs/evidence/covenant-mainnet.json", import.meta.url), "utf8"));

  it("is read from the committed evidence file", () => {
    const d = recordedDeployment();
    expect(d).to.not.equal(null);
    expect(d!.covenant).to.equal(record.covenant);
    expect(d!.deployBlock).to.equal(record.deployBlock);
  });

  it("is a real address and a plausible BSC block, so a bad edit to the evidence file fails here, not in front of a judge", () => {
    const d = recordedDeployment()!;
    expect(d.covenant).to.match(/^0x[0-9a-fA-F]{40}$/);
    expect(d.deployBlock).to.be.greaterThan(100_000_000);
  });
});
