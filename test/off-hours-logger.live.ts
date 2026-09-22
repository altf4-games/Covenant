import { expect } from "chai";
import { readFile, rm } from "node:fs/promises";
import { logOnePoll, pollToken, TRACKED_TOKENS, resolveLogPath } from "../scripts/off-hours-logger.js";

// Real HTTP calls to Binance's live endpoints, real file writes - nothing
// mocked. Uses a temp log path (OFF_HOURS_LOG_PATH) so this doesn't collide
// with the real, accumulating data/off-hours-log.jsonl. resolveLogPath()
// reads that env var at call time, not import time - see its doc comment
// in scripts/off-hours-logger.ts for the bug that made this necessary.
const TEST_LOG_PATH = new URL("../data/off-hours-log.test.jsonl", import.meta.url).pathname;

describe("off-hours logger (live, real data, real file writes)", function () {
  this.timeout(30_000);

  before(function () {
    process.env.OFF_HOURS_LOG_PATH = TEST_LOG_PATH;
    expect(resolveLogPath()).to.equal(TEST_LOG_PATH);
  });

  after(function () {
    delete process.env.OFF_HOURS_LOG_PATH;
  });

  afterEach(async function () {
    await rm(TEST_LOG_PATH, { force: true });
  });

  it("polls real live status for all three tracked NVDA providers", async function () {
    expect(TRACKED_TOKENS).to.have.length(3);
    expect(TRACKED_TOKENS.map((t) => t.provider).sort()).to.deep.equal(["bstock", "ondo", "xstock"]);

    const [bstock] = TRACKED_TOKENS;
    const result = await pollToken(bstock);
    expect("error" in result).to.equal(false);
    if (!("error" in result)) {
      expect(result.symbol).to.equal("NVDAB");
      expect(typeof result.openState).to.equal("boolean");
      expect(result.onChainPrice).to.not.equal(null);
      // Real, documented finding (friction-log.md B6): bStocks' reference
      // price field is null via this endpoint, unlike Ondo's.
      expect(result.referencePrice).to.equal(null);
    }
  });

  it("appends one real, valid JSON line per call to the real log file on disk", async function () {
    const entry1 = await logOnePoll();
    const entry2 = await logOnePoll();

    expect(entry1.polledAt).to.not.equal(entry2.polledAt);
    expect(entry1.tokens).to.have.length(3);

    const fileContent = await readFile(TEST_LOG_PATH, "utf8");
    const lines = fileContent.trim().split("\n");
    expect(lines).to.have.length(2);

    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed).to.have.property("polledAt");
      expect(parsed.tokens).to.have.length(3);
    }
  });
});
