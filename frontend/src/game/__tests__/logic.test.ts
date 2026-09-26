import { describe, expect, it } from "vitest";
import { buildQuest, spriteForReason, tokenTilePositions, BOSS_SPRITE, WORLD_COLS, WORLD_ROWS } from "../logic";
import { TERRITORY_TOKENS } from "../../data/liquidity";
import { DENIAL_REASONS } from "../../lib/covenant";
import type { Decision } from "../../lib/covenant";

const NVDAB = "0x02fca66c1d1afb4e2a7884261eb00f63598a7436";
const IMPERSONATOR = "0x2F701b108a9aF5558960325A0239D0a13c2C4444";

function commit(overrides: Partial<NonNullable<Decision["commit"]>>): Decision["commit"] {
  return {
    token: NVDAB,
    side: "buy",
    allowed: true,
    reason: "None",
    amountIn: 1n,
    quotedOut: 1n,
    minOut: 1n,
    expiresAt: 0,
    mandateMaxNotionalPerTradeUsd: 1n,
    mandateMaxTradesPerDay: 1n,
    mandateExpiry: 0,
    oracleUpdatedAt: 0,
    blockNumber: 1,
    txHash: "0xabc",
    ...overrides,
  };
}

describe("spriteForReason / BOSS_SPRITE", () => {
  it("assigns a real sprite key to every real DenialReason except None", () => {
    for (const reason of DENIAL_REASONS) {
      if (reason === "None") continue;
      expect(BOSS_SPRITE[reason], `no sprite mapped for real reason ${reason}`).toBeDefined();
    }
  });

  it("falls back to a default sprite for an unrecognized reason rather than throwing", () => {
    expect(spriteForReason("SomeFutureReasonNotYetMapped")).toBe("boss_goblin");
  });
});

describe("tokenTilePositions", () => {
  it("places every real territory token inside the world grid bounds", () => {
    const positions = tokenTilePositions();
    for (const token of TERRITORY_TOKENS) {
      const pos = positions.get(token.ticker);
      expect(pos, `no position for ${token.ticker}`).toBeDefined();
      expect(pos!.col).toBeGreaterThanOrEqual(0);
      expect(pos!.col).toBeLessThan(WORLD_COLS);
      expect(pos!.row).toBeGreaterThanOrEqual(0);
      expect(pos!.row).toBeLessThan(WORLD_ROWS);
      expect(pos!.platform).toBe(token.platform);
    }
  });

  it("is deterministic - the same real data always lays out the same way", () => {
    const a = tokenTilePositions();
    const b = tokenTilePositions();
    expect([...a.entries()]).toEqual([...b.entries()]);
  });
});

describe("buildQuest", () => {
  it("walks to NVDAB's real position, then battles the real boss for a denied decision", () => {
    const decisions: Decision[] = [
      { id: "1", commit: commit({ allowed: false, reason: "NotionalExceeded" }), settle: null, cancelled: false },
    ];
    const quest = buildQuest(decisions);
    expect(quest).toHaveLength(2);
    expect(quest[0]).toMatchObject({ kind: "walk", decisionId: "1" });
    expect(quest[1]).toMatchObject({ kind: "battle", decisionId: "1", reason: "NotionalExceeded", sprite: "boss_golem", bossName: "The Spending Cap", bossIcon: "💰" });

    const nvdabPos = tokenTilePositions().get("NVDAB")!;
    expect((quest[0] as any).toCol).toBe(nvdabPos.col);
    expect((quest[0] as any).toRow).toBe(nvdabPos.row);
  });

  it("arrives quietly for an allowed decision - no battle for a trade that wasn't stopped", () => {
    const decisions: Decision[] = [{ id: "1", commit: commit({ allowed: true }), settle: null, cancelled: false }];
    const quest = buildQuest(decisions);
    expect(quest.map((s) => s.kind)).toEqual(["walk", "arrive"]);
  });

  it("sends an unrecognized token (an impersonator, no real liquidity entry) to the unrecognized-territory marker, never a guessed real position", () => {
    const decisions: Decision[] = [
      { id: "1", commit: commit({ token: IMPERSONATOR, allowed: false, reason: "TokenNotAllowed" }), settle: null, cancelled: false },
    ];
    const quest = buildQuest(decisions);
    expect((quest[0] as any).toCol).toBe(WORLD_COLS - 1);
    expect((quest[0] as any).toRow).toBe(WORLD_ROWS - 1);
  });

  it("skips a decision whose commit fell outside the scanned block range - nowhere real to send the hero", () => {
    const settleOnly: Decision = { id: "9", commit: null, settle: { swapTxHash: "0x1", amountOut: 1n, executionMode: "pool", belowMin: false, txHash: "0x1" }, cancelled: false };
    expect(buildQuest([settleOnly])).toEqual([]);
  });

  it("plays decisions oldest-first even though the input list is newest-first", () => {
    const decisions: Decision[] = [
      { id: "2", commit: commit({ allowed: false, reason: "OracleHalted" }), settle: null, cancelled: false },
      { id: "1", commit: commit({ allowed: false, reason: "TokenNotAllowed" }), settle: null, cancelled: false },
    ];
    const quest = buildQuest(decisions);
    const decisionOrder = quest.map((s) => s.decisionId);
    expect(decisionOrder).toEqual(["1", "1", "2", "2"]);
  });
});
