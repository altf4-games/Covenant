import { fmtAmount, tokenName, type Decision } from "../lib/covenant";
import { TERRITORY_TOKENS, fmtUsdShort, type Platform, type TerritoryToken } from "../data/liquidity";

/**
 * Pure game logic - no Phaser, no canvas, no DOM. The town layout, the
 * road network the agent walks along, and every line of battle dialogue are
 * computed here and unit-tested; WorldScene only draws what this file says.
 */

// ---------------------------------------------------------------------------
// Sprites. Frame numbers index Kenney's CC0 "Tiny Dungeon" / "Tiny Town"
// packed sheets (public/game/kenney-tiny-*.png, 12 frames per row, frame N
// is the pack's tile_N.png).

export const HERO_FRAME = 85;
/** A friendly armored guard - the opponent for a trade that follows every rule. */
export const RULE_CHECKER_FRAME = 96;

// Only real monsters (tiles 108-124). An earlier mapping picked tiles by
// eye from a thumbnail and ended up with townspeople and a shield icon as
// "bosses".
export const MONSTER: Record<string, { frame: number; name: string }> = {
  MandateInactive: { frame: 121, name: "EXPIRED GHOST" },
  MandateExpired: { frame: 121, name: "EXPIRED GHOST" },
  TokenNotAllowed: { frame: 122, name: "WRONG-SHOP SPIDER" },
  NotionalExceeded: { frame: 109, name: "SPENDING CAP" },
  PositionLimit: { frame: 109, name: "SPENDING CAP" },
  DailyNotionalExceeded: { frame: 109, name: "SPENDING CAP" },
  InvalidAmount: { frame: 111, name: "BROKEN-NUMBER GHOUL" },
  DailyLimitExceeded: { frame: 120, name: "BEDTIME BAT" },
  OracleStale: { frame: 108, name: "OLD-NEWS GHOST" },
  OracleHalted: { frame: 124, name: "MARKET-CLOSED RAT" },
  SlippageTooLoose: { frame: 123, name: "SLIPPERY SNAIL" },
  DecisionOpen: { frame: 112, name: "ONE-AT-A-TIME GUARD" },
  ClosedMarketDrift: { frame: 110, name: "WEEKEND GAP DEMON" },
};
const UNKNOWN_MONSTER = { frame: 111, name: "MYSTERY RULE" };

export function monsterFor(reason: string): { frame: number; name: string } {
  return MONSTER[reason] ?? UNKNOWN_MONSTER;
}

const ATTACK_NAME: Record<string, string> = {
  MandateInactive: "EXPIRY CURSE",
  MandateExpired: "EXPIRY CURSE",
  TokenNotAllowed: "BLACKLIST BARRIER",
  NotionalExceeded: "OVERDRAFT SLAM",
  PositionLimit: "OVERDRAFT SLAM",
  DailyNotionalExceeded: "OVERDRAFT SLAM",
  InvalidAmount: "OVERFLOW GUARD",
  DailyLimitExceeded: "RATE LIMIT WALL",
  OracleStale: "STALE FOG",
  OracleHalted: "HALT FIELD",
  SlippageTooLoose: "SLIPPAGE TRAP",
  DecisionOpen: "QUEUE LOCK",
  ClosedMarketDrift: "WEEKEND GAP SURGE",
};

export function attackNameFor(reason: string): string {
  return ATTACK_NAME[reason] ?? "UNKNOWN GUARD";
}

// ---------------------------------------------------------------------------
// The town. Every coordinate below is a tile (16px) in a 32x18 grid.
//
//   row  1      shop signs (row A)
//   rows 2-4    row A houses: roof, roof, wall with door
//   row  5      doorsteps
//   row  6      ROAD A ───────────────┐
//   row  8      shop signs (row B)    │ connector (col 20)
//   rows 9-11   row B houses          │
//   row 12      doorsteps             │
//   row 13      ROAD B ───────────────┘
//   rows 14-17  open land (town square, wasteland)

export const TILE = 16;
export const WORLD_COLS = 32;
export const WORLD_ROWS = 18;
export const ROAD_A_ROW = 6;
export const ROAD_B_ROW = 13;
export const CONNECTOR_COL = 20;
export const ROAD_FIRST_COL = 1;
export const ROAD_LAST_COL = 30;

export type Band = "A" | "B";
const BAND_ROOF_TOP: Record<Band, number> = { A: 2, B: 9 };
const BAND_ROAD: Record<Band, number> = { A: ROAD_A_ROW, B: ROAD_B_ROW };

/** A tile the agent can stand on, plus which road it joins. */
export interface Spot {
  col: number;
  row: number;
  roadRow: number;
}

export type HouseStyle = { roof: "red" | "blue"; wall: "wood" | "stone" };

export interface Building {
  id: string;
  kind: "home" | "shop" | "ruin";
  label: string;
  /** Second sign line, e.g. real liquidity "$3.1M". */
  sublabel: string;
  x: number;
  width: number;
  band: Band;
  style: HouseStyle;
  token?: TerritoryToken;
}

export function roofTop(b: Building): number {
  return BAND_ROOF_TOP[b.band];
}
export function doorCol(b: Building): number {
  return b.x + Math.floor(b.width / 2);
}
export function standSpot(b: Building): Spot {
  return { col: doorCol(b), row: roofTop(b) + 3, roadRow: BAND_ROAD[b.band] };
}

interface Slot {
  x: number;
  width: number;
  band: Band;
  style: HouseStyle;
}

// Hand-placed lots, biggest first. Tokens are assigned to lots in order of
// real liquidity, so the biggest house really is the busiest market.
const RED_WOOD: HouseStyle = { roof: "red", wall: "wood" };
const BLUE_STONE: HouseStyle = { roof: "blue", wall: "stone" };
const RED_STONE: HouseStyle = { roof: "red", wall: "stone" };
const BLUE_WOOD: HouseStyle = { roof: "blue", wall: "wood" };

const SLOTS: Record<Platform, Slot[]> = {
  bstock: [
    { x: 7, width: 5, band: "A", style: RED_WOOD },
    { x: 13, width: 5, band: "A", style: BLUE_STONE },
    { x: 19, width: 5, band: "A", style: RED_STONE },
    { x: 2, width: 4, band: "B", style: BLUE_WOOD },
    { x: 7, width: 4, band: "B", style: RED_WOOD },
    { x: 12, width: 3, band: "B", style: BLUE_STONE },
    { x: 16, width: 3, band: "B", style: RED_STONE },
  ],
  ondo: [{ x: 27, width: 3, band: "A", style: BLUE_STONE }],
  xstock: [
    { x: 23, width: 3, band: "B", style: RED_WOOD },
    { x: 27, width: 3, band: "B", style: RED_WOOD },
  ],
};

export const HOME: Building = {
  id: "home",
  kind: "home",
  label: "AGENT HOME",
  sublabel: "",
  x: 2,
  width: 3,
  band: "A",
  style: BLUE_WOOD,
};
export const HOME_STAND: Spot = standSpot(HOME);

/** Where a trade on a token with no shop in town (e.g. an impersonator) is fought. */
export const UNKNOWN_STAND: Spot = { col: 30, row: 15, roadRow: ROAD_B_ROW };
export const UNKNOWN_SIGN = { col: 31, row: 15 };
export const MYSTERY_LABEL = "MYSTERY";

export const WASTELAND = { x: 22, y: 8, width: 10, height: 10 };

export function buildings(): Building[] {
  const out: Building[] = [HOME];
  for (const platform of ["bstock", "ondo", "xstock"] as Platform[]) {
    const tokens = TERRITORY_TOKENS.filter((t) => t.platform === platform).sort((a, b) => b.reservesUsd - a.reservesUsd);
    tokens.forEach((token, i) => {
      const slot = SLOTS[platform][i];
      if (!slot) throw new Error(`No lot left in ${platform} for ${token.ticker} - add one to SLOTS`);
      out.push({
        id: token.ticker,
        kind: platform === "xstock" ? "ruin" : "shop",
        label: token.name,
        // Real pool reserves - how much money sits in this shop's market.
        sublabel: fmtUsdShort(token.reservesUsd),
        x: slot.x,
        width: slot.width,
        band: slot.band,
        style: slot.style,
        token,
      });
    });
  }
  return out;
}

const key = (col: number, row: number) => `${col},${row}`;

/** Every tile the agent may walk on: both roads, the connector, every doorstep, and the path to the unknown lot. */
export function walkableTiles(): Set<string> {
  const s = new Set<string>();
  for (let c = ROAD_FIRST_COL; c <= ROAD_LAST_COL; c++) {
    s.add(key(c, ROAD_A_ROW));
    s.add(key(c, ROAD_B_ROW));
  }
  for (let r = ROAD_A_ROW; r <= ROAD_B_ROW; r++) s.add(key(CONNECTOR_COL, r));
  for (const b of buildings()) {
    const st = standSpot(b);
    s.add(key(st.col, st.row));
  }
  for (let r = ROAD_B_ROW; r <= UNKNOWN_STAND.row; r++) s.add(key(UNKNOWN_STAND.col, r));
  return s;
}

/**
 * Waypoints from one spot to another along the roads - never a straight
 * diagonal through a house. Excludes the start, includes the destination.
 * Each consecutive pair differs on exactly one axis.
 */
export function route(from: Spot, to: Spot): { col: number; row: number }[] {
  const pts: { col: number; row: number }[] = [];
  const push = (col: number, row: number) => {
    const last = pts[pts.length - 1] ?? from;
    if (last.col !== col || last.row !== row) pts.push({ col, row });
  };
  push(from.col, from.roadRow);
  if (from.roadRow !== to.roadRow) {
    push(CONNECTOR_COL, from.roadRow);
    push(CONNECTOR_COL, to.roadRow);
  }
  push(to.col, to.roadRow);
  push(to.col, to.row);
  return pts;
}

// ---------------------------------------------------------------------------
// Battles, in words a kid can follow.

/**
 * Trims "1.000000000000000000" to "1", "0.004412345" to "0.004412".
 *
 * Deliberately stays in string-land throughout: `String(Number(x.toPrecision(4)))`
 * looks equivalent but isn't - JS renders any Number below 1e-6 or at/above
 * 1e21 in exponential form ("1.235e-8"), and H15's own MAX_AMOUNT
 * (type(uint128).max wei) is large enough in USDT-scale decimal form to
 * land in that range, same as a real dust-sized trade on the small end.
 * A kid-facing battle log should never show "e-8".
 */
export function prettyAmount(wei: bigint): string {
  const s = fmtAmount(wei); // plain decimal string, e.g. "0.004412345" or "340282366920938.463463374607431768211455"
  if (/^0\.?0*$/.test(s)) return "0";

  const [whole, frac = ""] = s.split(".");
  if (whole !== "0") {
    if (whole.length > 4) {
      // Truncate to the first 4 significant digits, zero-padded back out to
      // the real magnitude ("123456789" -> "123400000"), never exponential.
      return whole.slice(0, 4).padEnd(whole.length, "0");
    }
    // 4 or fewer whole digits: spend the remaining significant digits on the fraction.
    const fracDigits = frac.slice(0, 4 - whole.length).replace(/0+$/, "");
    return fracDigits ? `${whole}.${fracDigits}` : whole;
  }
  // < 1: keep the first 4 significant digits after the leading zeros.
  const leadingZeros = frac.match(/^0*/)?.[0].length ?? 0;
  const sig = frac.slice(leadingZeros, leadingZeros + 4).replace(/0+$/, "");
  return sig ? `0.${"0".repeat(leadingZeros)}${sig}` : "0";
}

type Commit = NonNullable<Decision["commit"]>;

/** Why the rule said no - checked against Covenant.sol's _evaluate, one sentence per real DenialReason. */
export function kidExplanation(reason: string, c?: Commit): string {
  switch (reason) {
    case "MandateInactive":
      return "The agent's permission to trade is switched off.";
    case "MandateExpired":
      return "The agent's permission to trade has run out of time.";
    case "TokenNotAllowed":
      return "This shop is not on the agent's allowed list.";
    case "DecisionOpen":
      return "The agent must finish its last trade before starting a new one.";
    case "OracleStale":
      return "The price news is too old to trust.";
    case "OracleHalted":
      return "Trading in this stock is paused right now.";
    case "NotionalExceeded":
      return c
        ? `Too big! The rules only allow $${prettyAmount(c.mandateMaxNotionalPerTradeUsd)} per trade.`
        : "Too big! That trade spends more than the rules allow.";
    case "DailyLimitExceeded":
      return c
        ? `The agent already used all ${c.mandateMaxTradesPerDay} of today's trades.`
        : "The agent already used all of today's trades.";
    case "DailyNotionalExceeded":
      return "The agent already spent its whole allowance for today.";
    case "SlippageTooLoose":
      return "The price the agent expected doesn't match the market, or it would have accepted a much worse one. Too risky!";
    case "ClosedMarketDrift":
      return "The real market is closed, and this price is too far from where it closed.";
    case "PositionLimit":
      return "The agent would own too much of this one stock.";
    case "InvalidAmount":
      return "The trade amount made no sense - zero, or impossibly huge.";
    default:
      return `A safety rule said no (${reason}).`;
  }
}

export type BattleCue = "heroAttack" | "foeAttack" | "heroFaint" | "foeFaint";
export interface BattleLine {
  text: string;
  cue?: BattleCue;
}

export type QuestStep =
  | {
      kind: "walk";
      route: { col: number; row: number }[];
      /** null when walking home at the end. */
      decisionId: string | null;
      placeLabel: string;
    }
  | {
      kind: "battle";
      decisionId: string;
      /** true: the trade followed every rule and went ahead. */
      won: boolean;
      foeFrame: number;
      foeName: string;
      reason: string;
      lines: BattleLine[];
    };

function placeForToken(tokenAddress: string, shops: Building[]): { stand: Spot; label: string } {
  const shop = shops.find((b) => b.token?.address?.toLowerCase() === tokenAddress.toLowerCase());
  if (shop) return { stand: standSpot(shop), label: shop.label };
  // A token with no shop in town (e.g. an impersonator of a real bStock).
  // Known tickers keep their name; a raw address means nothing to a kid.
  const known = tokenName(tokenAddress);
  return { stand: UNKNOWN_STAND, label: known.startsWith("0x") ? MYSTERY_LABEL : known };
}

function wantLine(c: Commit, label: string): string {
  return c.side === "buy"
    ? `AGENT wants to buy ${label} with $${prettyAmount(c.amountIn)}.`
    : `AGENT wants to sell ${prettyAmount(c.amountIn)} ${label} shares.`;
}

export function battleLines(d: Decision, label: string): BattleLine[] {
  const c = d.commit;
  if (!c) return [];
  const move = c.side === "buy" ? "BUY" : "SELL";

  if (!c.allowed) {
    const foe = monsterFor(c.reason).name;
    return [
      { text: `A wild ${foe} appeared!` },
      { text: wantLine(c, label) },
      { text: `AGENT used ${move}!`, cue: "heroAttack" },
      { text: `${foe} used ${attackNameFor(c.reason)}!`, cue: "foeAttack" },
      { text: kidExplanation(c.reason, c) },
      { text: "AGENT fainted! TRADE BLOCKED.", cue: "heroFaint" },
      { text: "The rules kept your money safe!" },
    ];
  }

  let ending: string;
  if (d.settle) {
    const got =
      c.side === "buy" ? `${prettyAmount(d.settle.amountOut)} ${label} shares` : `$${prettyAmount(d.settle.amountOut)}`;
    ending = d.settle.belowMin ? `AGENT got ${got} - less than promised, so it was flagged!` : `AGENT got ${got}!`;
  } else if (d.cancelled) {
    ending = "Then the agent changed its mind and didn't trade.";
  } else {
    ending = "The trade is on its way!";
  }

  return [
    { text: "A wild RULE CHECKER appeared!" },
    { text: wantLine(c, label) },
    { text: `AGENT used ${move}!`, cue: "heroAttack" },
    { text: "It followed every safety rule! It's super effective!" },
    { text: "RULE CHECKER fainted! TRADE ALLOWED.", cue: "foeFaint" },
    { text: ending },
  ];
}

/**
 * Real decisions (newest first, as fetched) -> the day replayed oldest
 * first: walk to the shop, battle there, next shop, then home. Every
 * committed decision gets a battle - allowed trades are battles the agent
 * wins. Settle-only decisions (commit outside the scanned range) are
 * skipped; there's no shop to send the agent to.
 */
export function buildQuest(decisions: Decision[], start: Spot = HOME_STAND): QuestStep[] {
  const shops = buildings();
  const steps: QuestStep[] = [];
  let here = start;

  for (const d of [...decisions].reverse()) {
    const c = d.commit;
    if (!c) continue;
    const place = placeForToken(c.token, shops);
    steps.push({ kind: "walk", route: route(here, place.stand), decisionId: d.id, placeLabel: place.label });
    here = place.stand;
    const foe = c.allowed ? { frame: RULE_CHECKER_FRAME, name: "RULE CHECKER" } : monsterFor(c.reason);
    steps.push({
      kind: "battle",
      decisionId: d.id,
      won: c.allowed,
      foeFrame: foe.frame,
      foeName: foe.name,
      reason: c.reason,
      lines: battleLines(d, place.label),
    });
  }

  if (steps.length > 0) {
    steps.push({ kind: "walk", route: route(here, HOME_STAND), decisionId: null, placeLabel: HOME.label });
  }
  return steps;
}

// ---------------------------------------------------------------------------
// Screen fitting. The town is 32x18 tiles, wider than tall, so on a phone held
// upright fitting it to the width leaves signs a few pixels tall and most of
// the screen empty. Portrait screens get a follow camera and a battle stage
// shaped like the screen instead.

/** How much of the town a portrait screen shows at once, in world pixels. */
export const PORTRAIT_VISIBLE_WORLD_W = 240;
/** Width of the battle stage on a portrait screen, in world pixels (8px text becomes ~12px on a phone). */
export const PORTRAIT_STAGE_W = 240;

export const isPortraitScreen = (gw: number, gh: number) => gw < gh;

/** The camera zoom on a portrait screen: enough to read the signs, never less than fitting the whole town. */
export function portraitTownZoom(gw: number, gh: number): number {
  return Math.max(Math.min(gw / (WORLD_COLS * TILE), gh / (WORLD_ROWS * TILE)) * 0.97, gw / PORTRAIT_VISIBLE_WORLD_W);
}

/** Where a battle is drawn: the town's own rectangle, or on a portrait screen a tall stage with the screen's shape. */
export function battleStageFor(gw: number, gh: number): { w: number; h: number; portrait: boolean } {
  if (!isPortraitScreen(gw, gh)) return { w: WORLD_COLS * TILE, h: WORLD_ROWS * TILE, portrait: false };
  return { w: PORTRAIT_STAGE_W, h: Math.round((PORTRAIT_STAGE_W * gh) / gw), portrait: true };
}
