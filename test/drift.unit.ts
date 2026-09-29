import { expect } from "chai";
import { readFileSync } from "node:fs";
import { ethers } from "ethers";
import covenantArtifact from "../artifacts/contracts/Covenant.sol/Covenant.json" with { type: "json" };
import { SELECTORS, DENIAL_REASONS as CLI_REASONS } from "../skills/covenant-mandate/scripts/cli.mjs";
import { DENIAL_REASONS as LIB_REASONS, BOSSES, ABI as STATUS_PAGE_ABI } from "../status-page/lib.mjs";
import { TOPICS } from "../scripts/judge.js";

// Several files copy facts that live in Covenant.sol: 4-byte selectors, event
// topic hashes, the DenialReason list. A copy that drifts fails silently (a
// decoder reads the wrong reason, a selector calls nothing), so this checks
// every copy against the compiled contract. No network.
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const iface = new ethers.Interface(covenantArtifact.abi);

function solidityDenialReasons(): string[] {
  const body = read("contracts/Covenant.sol").match(/enum DenialReason \{([\s\S]*?)\n    \}/)![1].replace(/\/\/.*$/gm, "");
  return body.split(",").map((n) => n.trim()).filter(Boolean);
}

describe("copies of contract facts match the compiled contract (drift guard)", function () {
  it("every selector in the skill CLI is the real selector of the function it names", function () {
    for (const [name, selector] of Object.entries(SELECTORS)) {
      expect(iface.getFunction(name)?.selector, name).to.equal(selector);
    }
  });

  it("the event topic hashes in judge.ts and verify.ts are the real ones", function () {
    for (const [name, topic] of Object.entries(TOPICS)) expect(iface.getEvent(name)?.topicHash, name).to.equal(topic);
    const verify = read("scripts/verify.ts");
    for (const name of ["TokenConfigured", "AgentChanged", "OracleUpdaterChanged", "MandateRevoked"]) {
      expect(verify, name).to.contain(iface.getEvent(name)!.topicHash);
    }
    for (const fn of ["agent()", "quoteToken()", "decisionTtl()"]) {
      expect(verify, fn).to.contain(iface.getFunction(fn)!.selector);
    }
  });

  it("the DenialReason list is identical, in order, in the contract, the CLI and the status page", function () {
    const reasons = solidityDenialReasons();
    expect(reasons.length).to.be.greaterThan(10);
    expect(CLI_REASONS).to.deep.equal(reasons);
    expect(LIB_REASONS).to.deep.equal(reasons);
  });

  it("every denial reason has a boss, a monster, an attack name and a kid-friendly explanation in the UI", function () {
    const logic = read("frontend/src/game/logic.ts");
    for (const reason of solidityDenialReasons().filter((r) => r !== "None")) {
      expect(BOSSES[reason as keyof typeof BOSSES], `boss for ${reason}`).to.not.equal(undefined);
      expect(logic, `monster for ${reason}`).to.match(new RegExp(`\\b${reason}: \\{ frame:`));
      expect(logic, `attack name for ${reason}`).to.match(new RegExp(`\\b${reason}: "[A-Z -]+",`));
      expect(logic, `explanation for ${reason}`).to.contain(`case "${reason}"`);
    }
  });

  it("the status page's ABI fragments describe events and views the contract really has", function () {
    for (const fragment of STATUS_PAGE_ABI) {
      const parsed = ethers.Fragment.from(fragment);
      if (parsed.type === "event") {
        expect(iface.getEvent(parsed.format("sighash")), fragment).to.not.equal(null);
      } else {
        expect(iface.getFunction(parsed.format("sighash")), fragment).to.not.equal(null);
      }
    }
  });
});
