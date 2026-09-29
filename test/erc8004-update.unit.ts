import { expect } from "chai";
import { withContract } from "../scripts/update-erc8004.js";

const REGISTRY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";
const COV = "0x" + "ab".repeat(20);
const base = {
  name: "Covenant",
  services: [{ name: "web", endpoint: "https://example.test" }, { name: "agentWallet", endpoint: "eip155:56:0xwallet" }],
  registrations: [{ agentId: null, agentRegistry: `eip155:56:${REGISTRY}` }],
};

describe("ERC-8004 identity update (unit)", function () {
  it("adds the contract as a service and fills in the agent's own id, keeping everything else", function () {
    const doc = withContract(base, "358509", REGISTRY, COV);
    expect(doc.services).to.deep.equal([...base.services, { name: "covenant", endpoint: `eip155:56:${COV}` }]);
    expect(doc.registrations).to.deep.equal([{ agentId: 358509, agentRegistry: `eip155:56:${REGISTRY}` }]);
    expect(doc.name).to.equal("Covenant");
  });
  it("is idempotent: running it twice doesn't duplicate the service", function () {
    const once = withContract(base, "358509", REGISTRY, COV);
    expect(withContract(once, "358509", REGISTRY, COV).services).to.have.length(3);
  });
  it("refuses something that isn't an address", function () {
    expect(() => withContract(base, "358509", REGISTRY, "NVDA")).to.throw(/20-byte address/);
  });
});
