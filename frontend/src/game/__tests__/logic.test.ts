import { describe, expect, it } from "vitest";
import {
  buildQuest,
  buildings,
  route,
  walkableTiles,
  standSpot,
  roofTop,
  monsterFor,
  attackNameFor,
  kidExplanation,
  prettyAmount,
  doorCol,
  battleLines,
  battleStageFor,
  isPortraitScreen,
  portraitTownZoom,
  TILE,
  HOME,
  HOME_STAND,
  UNKNOWN_STAND,
  RULE_CHECKER_FRAME,
  WORLD_COLS,
  WORLD_ROWS,
  type Spot,
} from "../logic";
import { TERRITORY_TOKENS } from "../../data/liquidity";
import { DENIAL_REASONS } from "../../lib/covenant";
import type { Decision } from "../../lib/covenant";

const NVDAB = "0x02fca66c1d1afb4e2a7884261eb00f63598a7436";
const NVDAON = "0xa9ee28c80f960b889dfbd1902055218cba016f75";
const IMPERSONATOR = "0x2F701b108a9aF5558960325A0239D0a13c2C4444";
const ONE = 10n ** 18n;

function commit(overrides: Partial<NonNullable<Decision["commit"]>>): Decision["commit"] {
  return {
    token: NVDAB,
    side: "buy",
    allowed: true,
    reason: "None",
    amountIn: ONE,
    quotedOut: 1n,
    minOut: 1n,
    expiresAt: 0,
    mandateMaxNotionalPerTradeUsd: ONE,
    mandateMaxTradesPerDay: 10n,
    mandateExpiry: 0,
    oracleUpdatedAt: 0,
    blockNumber: 1,
    txHash: "0xabc",
    ...overrides,
  };
}

const realReasons = DENIAL_REASONS.filter((r: string) => r !== "None");

describe("monsters, moves, and explanations", () => {
  it("gives every real DenialReason a real monster, move, and plain-English explanation", () => {
    for (const reason of realReasons) {
      expect(monsterFor(reason).name, reason).not.toBe("MYSTERY RULE");
      expect(attackNameFor(reason), reason).not.toBe("UNKNOWN GUARD");
      expect(kidExplanation(reason), reason).not.toContain("A safety rule said no");
    }
  });

  it("only uses monster tiles (108-124) as monsters, never a townsperson or item", () => {
    for (const reason of realReasons) {
      const f = monsterFor(reason).frame;
      expect(f >= 108 && f <= 124, `${reason} -> frame ${f}`).toBe(true);
    }
  });

  it("falls back instead of throwing for a reason added to the contract later", () => {
    expect(monsterFor("SomeFutureReason").name).toBe("MYSTERY RULE");
    expect(attackNameFor("SomeFutureReason")).toBe("UNKNOWN GUARD");
    expect(kidExplanation("SomeFutureReason")).toContain("SomeFutureReason");
  });

  it("quotes the real per-trade cap from the commit in the NotionalExceeded explanation", () => {
    const c = commit({ allowed: false, reason: "NotionalExceeded", mandateMaxNotionalPerTradeUsd: 5n * ONE });
    expect(kidExplanation("NotionalExceeded", c!)).toContain("$5");
  });

  it("formats wei amounts without trailing zeros", () => {
    expect(prettyAmount(ONE)).toBe("1");
    expect(prettyAmount(4_412_345_000_000_000n)).toBe("0.004412");
    expect(prettyAmount(0n)).toBe("0");
  });

  // H15 (Covenant.sol) now lets amountIn range all the way up to
  // type(uint128).max wei; on the small end a real dust trade can be far
  // below one token. Both extremes used to come out in exponential notation
  // ("1.235e-8", "3.403e+20") because the old implementation round-tripped
  // through toPrecision(4) and Number(), and JS itself renders any Number
  // outside [1e-6, 1e21) that way regardless of toPrecision's own output.
  it("never renders scientific notation, even at H15's amount extremes", () => {
    const dust = 12n; // 12 wei = 0.000000000000000012 tokens
    expect(prettyAmount(dust)).not.toMatch(/e[+-]/i);
    expect(prettyAmount(dust)).toBe("0.000000000000000012");

    const max128 = (2n ** 128n - 1n) * ONE; // MAX_AMOUNT wei, scaled to a whole-token count
    expect(prettyAmount(max128)).not.toMatch(/e[+-]/i);
    expect(prettyAmount(max128)).toBe("3402" + "0".repeat(35));
  });
});

describe("the town", () => {
  const all = buildings();

  it("has exactly one building per real territory token, plus the agent's home", () => {
    expect(all.length).toBe(TERRITORY_TOKENS.length + 1);
    for (const t of TERRITORY_TOKENS) {
      expect(all.filter((b) => b.token?.ticker === t.ticker)).toHaveLength(1);
    }
  });

  it("gives bigger real markets bigger houses", () => {
    const shops = all.filter((b) => b.token?.platform === "bstock");
    const byReserves = [...shops].sort((a, b) => b.token!.reservesUsd - a.token!.reservesUsd);
    for (let i = 1; i < byReserves.length; i++) {
      expect(byReserves[i].width).toBeLessThanOrEqual(byReserves[i - 1].width);
    }
  });

  it("marks xStocks lots as ruins - the real pools hold almost nothing", () => {
    for (const b of all.filter((b) => b.token?.platform === "xstock")) expect(b.kind).toBe("ruin");
  });

  it("keeps every building on the map and never overlaps two buildings or a building and a road", () => {
    const walk = walkableTiles();
    const used = new Set<string>();
    for (const b of all) {
      for (let r = roofTop(b); r < roofTop(b) + 3; r++) {
        for (let c = b.x; c < b.x + b.width; c++) {
          expect(c >= 0 && c < WORLD_COLS && r >= 0 && r < WORLD_ROWS, `${b.id} off map`).toBe(true);
          expect(used.has(`${c},${r}`), `${b.id} overlaps another building at ${c},${r}`).toBe(false);
          expect(walk.has(`${c},${r}`), `${b.id} sits on a road at ${c},${r}`).toBe(false);
          used.add(`${c},${r}`);
        }
      }
    }
  });

  it("puts every doorstep on a walkable tile right in front of its door", () => {
    const walk = walkableTiles();
    for (const b of all) {
      const s = standSpot(b);
      expect(walk.has(`${s.col},${s.row}`), b.id).toBe(true);
      expect(s.row).toBe(roofTop(b) + 3);
    }
  });
});

describe("route", () => {
  const walk = walkableTiles();

  function expectWalkable(from: Spot, pts: { col: number; row: number }[]) {
    let prev = { col: from.col, row: from.row };
    for (const p of pts) {
      expect(p.col === prev.col || p.row === prev.row, `diagonal step ${JSON.stringify(prev)} -> ${JSON.stringify(p)}`).toBe(true);
      const dc = Math.sign(p.col - prev.col);
      const dr = Math.sign(p.row - prev.row);
      for (let c = prev.col, r = prev.row; c !== p.col || r !== p.row; ) {
        c += dc;
        r += dr;
        expect(walk.has(`${c},${r}`), `walked off the road at ${c},${r}`).toBe(true);
      }
      prev = p;
    }
  }

  it("walks along roads - never through a house - between every pair of places", () => {
    const spots = [...buildings().map(standSpot), UNKNOWN_STAND];
    for (const a of spots) {
      for (const b of spots) {
        const pts = route(a, b);
        expectWalkable(a, pts);
        if (a.col !== b.col || a.row !== b.row) expect(pts[pts.length - 1]).toEqual({ col: b.col, row: b.row });
      }
    }
  });
});

describe("buildQuest", () => {
  it("fights a monster at NVIDIA's shop for a denied trade, and the agent loses", () => {
    const quest = buildQuest([{ id: "1", commit: commit({ allowed: false, reason: "NotionalExceeded" }), settle: null, cancelled: false }]);
    expect(quest.map((s) => s.kind)).toEqual(["walk", "battle", "walk"]);
    const battle = quest[1] as Extract<(typeof quest)[number], { kind: "battle" }>;
    expect(battle.won).toBe(false);
    expect(battle.foeName).toBe("SPENDING CAP");
    const text = battle.lines.map((l) => l.text).join(" ");
    expect(text).toContain("NVIDIA");
    expect(text).toContain("TRADE BLOCKED");
    expect(text).toContain("OVERDRAFT SLAM");
    expect(battle.lines.some((l) => l.cue === "heroFaint")).toBe(true);

    const nvdaShop = buildings().find((b) => b.id === "NVDAB")!;
    const walk = quest[0] as Extract<(typeof quest)[number], { kind: "walk" }>;
    expect(walk.route[walk.route.length - 1]).toEqual({ col: standSpot(nvdaShop).col, row: standSpot(nvdaShop).row });
  });

  it("still battles for an allowed trade - the agent beats the Rule Checker", () => {
    const d: Decision = {
      id: "2",
      commit: commit({ allowed: true }),
      settle: { swapTxHash: "0x1", amountOut: 4_412_345_000_000_000n, executionMode: "pool", belowMin: false, txHash: "0x2" },
      cancelled: false,
    };
    const battle = buildQuest([d])[1] as Extract<ReturnType<typeof buildQuest>[number], { kind: "battle" }>;
    expect(battle.kind).toBe("battle");
    expect(battle.won).toBe(true);
    expect(battle.foeFrame).toBe(RULE_CHECKER_FRAME);
    const text = battle.lines.map((l) => l.text).join(" ");
    expect(text).toContain("TRADE ALLOWED");
    expect(text).toContain("0.004412 NVIDIA shares");
    expect(battle.lines.some((l) => l.cue === "foeFaint")).toBe(true);
    expect(battle.lines.some((l) => l.cue === "heroFaint")).toBe(false);
  });

  it("says so when an allowed trade was abandoned instead of filled", () => {
    const d: Decision = { id: "3", commit: commit({ allowed: true }), settle: null, cancelled: true };
    const battle = buildQuest([d])[1] as Extract<ReturnType<typeof buildQuest>[number], { kind: "battle" }>;
    expect(battle.lines[battle.lines.length - 1].text).toContain("changed its mind");
  });

  it("sends a token with no shop in town (an impersonator) to the unknown lot, never a guessed shop", () => {
    const quest = buildQuest([
      { id: "1", commit: commit({ token: IMPERSONATOR, allowed: false, reason: "TokenNotAllowed" }), settle: null, cancelled: false },
    ]);
    const walk = quest[0] as Extract<(typeof quest)[number], { kind: "walk" }>;
    expect(walk.route[walk.route.length - 1]).toEqual({ col: UNKNOWN_STAND.col, row: UNKNOWN_STAND.row });
    // Kids see "MYSTERY", never a hex address.
    expect(walk.placeLabel).toBe("MYSTERY");
    const battle = quest[1] as Extract<(typeof quest)[number], { kind: "battle" }>;
    for (const line of battle.lines) expect(line.text).not.toMatch(/0x[0-9a-f]/i);
  });

  it("routes to Ondo's NVIDIA shop, not the bStocks one, for the Ondo token", () => {
    const quest = buildQuest([{ id: "1", commit: commit({ token: NVDAON }), settle: null, cancelled: false }]);
    const ondoShop = buildings().find((b) => b.id === "NVDAon")!;
    const walk = quest[0] as Extract<(typeof quest)[number], { kind: "walk" }>;
    expect(walk.route[walk.route.length - 1].col).toBe(standSpot(ondoShop).col);
  });

  it("replays oldest first, starts from home, and walks home at the end", () => {
    const quest = buildQuest([
      { id: "2", commit: commit({ allowed: false, reason: "OracleHalted" }), settle: null, cancelled: false },
      { id: "1", commit: commit({ allowed: true }), settle: null, cancelled: false },
    ]);
    expect(quest.map((s) => s.decisionId)).toEqual(["1", "1", "2", "2", null]);
    const last = quest[quest.length - 1] as Extract<(typeof quest)[number], { kind: "walk" }>;
    expect(last.placeLabel).toBe(HOME.label);
    expect(last.route[last.route.length - 1]).toEqual({ col: HOME_STAND.col, row: HOME_STAND.row });
  });

  it("skips a decision whose commit fell outside the scanned range, and has nothing to do with no decisions", () => {
    const settleOnly: Decision = { id: "9", commit: null, settle: { swapTxHash: "0x1", amountOut: 1n, executionMode: "pool", belowMin: false, txHash: "0x1" }, cancelled: false };
    expect(buildQuest([settleOnly])).toEqual([]);
    expect(buildQuest([])).toEqual([]);
  });
});

// Mutation testing (changing a digit count, a rounding direction, a case
// comparison) showed these behaviours had no test.
describe("prettyAmount: four significant digits, never exponential", () => {
  const wei = (s: string) => BigInt(Math.round(Number(s) * 1e6)) * 10n ** 12n;
  it("keeps four significant digits on either side of the point", () => {
    expect(prettyAmount(wei("1.5"))).toBe("1.5");
    expect(prettyAmount(wei("12.3456"))).toBe("12.34");
    expect(prettyAmount(wei("123.456"))).toBe("123.4");
    expect(prettyAmount(wei("1234.56"))).toBe("1234");
    expect(prettyAmount(wei("0.004412345"))).toBe("0.004412");
  });
  it("shortens a five-digit or longer whole number to four digits, zero-padded to its magnitude", () => {
    expect(prettyAmount(12345n * 10n ** 18n)).toBe("12340");
    expect(prettyAmount(123456789n * 10n ** 18n)).toBe("123400000");
  });
});

describe("the town's geometry and lookups", () => {
  it("a shop's door is the middle tile of an odd-width house, and the left of the middle pair on an even one", () => {
    expect(doorCol({ x: 7, width: 5 } as never)).toBe(9);
    expect(doorCol({ x: 2, width: 4 } as never)).toBe(4);
    expect(doorCol({ x: 2, width: 3 } as never)).toBe(3);
  });

  it("finds a shop whatever the case of the address the chain gave, and never sends a known token to the mystery lot", () => {
    const checksummed = "0x02FCA66C1D1AFB4E2A7884261EB00F63598A7436";
    const steps = buildQuest([{ id: "1", commit: commit({ token: checksummed }), settle: null, cancelled: false }]);
    const walk = steps.find((s) => s.kind === "walk") as { placeLabel: string };
    expect(walk.placeLabel).toBe("NVIDIA");
  });
});

describe("battle wording", () => {
  it("a sell talks about shares of the stock, not dollars", () => {
    const lines = battleLines({ id: "1", commit: commit({ side: "sell", amountIn: ONE }), settle: null, cancelled: false }, "NVIDIA");
    expect(lines[1].text).toBe("AGENT wants to sell 1 NVIDIA shares.");
    expect(lines[1].text).not.toContain("$");
  });

  it("says when a fill came in under the promised minimum, and when the agent changed its mind", () => {
    const settle = { swapTxHash: "0x1", amountOut: ONE, executionMode: "pool", belowMin: true, txHash: "0x1" };
    const below = battleLines({ id: "1", commit: commit({}), settle, cancelled: false }, "NVIDIA").map((l) => l.text).join(" ");
    expect(below).toContain("less than promised");
    const fine = battleLines({ id: "1", commit: commit({}), settle: { ...settle, belowMin: false }, cancelled: false }, "NVIDIA").map((l) => l.text).join(" ");
    expect(fine).not.toContain("less than promised");
    const cancelled = battleLines({ id: "1", commit: commit({}), settle: null, cancelled: true }, "NVIDIA").map((l) => l.text).join(" ");
    expect(cancelled).toContain("changed its mind");
  });
});

describe("fitting the game to the screen", () => {
  const townW = WORLD_COLS * TILE;
  const townH = WORLD_ROWS * TILE;

  it("a screen is portrait only when it is taller than wide", () => {
    expect(isPortraitScreen(750, 1624)).toBe(true);
    expect(isPortraitScreen(1280, 800)).toBe(false);
    expect(isPortraitScreen(800, 800)).toBe(false);
  });

  it("a landscape battle is drawn on the town's own rectangle, as it always was", () => {
    expect(battleStageFor(1280, 800)).toEqual({ w: townW, h: townH, portrait: false });
  });

  it("a portrait battle gets a stage as wide as the phone can make readable, with the screen's proportions", () => {
    const stage = battleStageFor(750, 1624);
    expect(stage.portrait).toBe(true);
    expect(stage.w).toBe(240);
    expect(stage.h).toBe(Math.round((240 * 1624) / 750));
    // 8px dialogue text at the zoom that fits this stage is ~12 CSS px on a 2x phone
    const zoom = Math.min(750 / stage.w, 1624 / stage.h) * 0.97;
    expect((8 * zoom) / 2).toBeGreaterThan(10);
  });

  it("on a phone the town is zoomed until its shop signs can be read, and never less than fitting it all", () => {
    const zoom = portraitTownZoom(750, 1624);
    expect((6 * zoom) / 2).toBeGreaterThan(8); // a 6px sign becomes at least ~8 CSS px
    // a tall tablet-sized portrait window: fitting the whole town is already the bigger zoom
    expect(portraitTownZoom(2000, 2100)).toBeGreaterThanOrEqual(Math.min(2000 / townW, 2100 / townH) * 0.97);
  });
});
