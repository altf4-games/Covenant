import type { Decision } from "../lib/covenant";
import { TERRITORY_TOKENS, type Platform } from "../data/liquidity";

/**
 * Pure game logic - no Phaser, no canvas, no DOM. Kept separate so the
 * queueing/mapping rules are unit-testable (Phaser needs a real browser
 * canvas and isn't meaningfully testable under Vitest/jsdom); the Scene
 * itself is a thin renderer over exactly what this file computes.
 */

// Real sprite files, copied from Kenney's CC0 "Tiny Dungeon" pack
// (frontend/assets-src/ - see frontend/assets-src/LICENSE.txt) into
// public/game/dungeon/. One boss reason can share a monster with a
// conceptually related one (the same "spending cap" idea appears at three
// moments: per trade, per position, per day), the same grouping
// TerritoryMap already used for the icon/name version.
export const BOSS_SPRITE: Record<string, string> = {
  MandateInactive: "boss_ghost",
  MandateExpired: "boss_ghost",
  TokenNotAllowed: "boss_hood",
  NotionalExceeded: "boss_golem",
  PositionLimit: "boss_golem",
  DailyNotionalExceeded: "boss_golem",
  DailyLimitExceeded: "boss_skeleton",
  OracleStale: "boss_purple",
  OracleHalted: "boss_demon2",
  SlippageTooLoose: "boss_skeleton2",
  DecisionOpen: "boss_mummy",
  ClosedMarketDrift: "boss_demon", // flagship - Feature 1's own denial
};

export function spriteForReason(reason: string): string {
  return BOSS_SPRITE[reason] ?? "boss_goblin";
}

export interface WorldZone {
  platform: Platform;
  x: number;
  width: number;
}

export const WORLD_ZONES: WorldZone[] = [
  { platform: "bstock", x: 0, width: 12 },
  { platform: "ondo", x: 12, width: 5 },
  { platform: "xstock", x: 17, width: 4 },
];
export const WORLD_COLS = 21;
export const WORLD_ROWS = 9;
export const HOME_TILE = { col: 2, row: 4 };

/** Real per-token positions, deterministic and derived from liquidity rank within its zone - not random, so the same data always lays out the same way. */
export function tokenTilePositions(): Map<string, { col: number; row: number; platform: Platform }> {
  const out = new Map<string, { col: number; row: number; platform: Platform }>();
  for (const zone of WORLD_ZONES) {
    const tokensInZone = TERRITORY_TOKENS.filter((t) => t.platform === zone.platform).sort((a, b) => b.reservesUsd - a.reservesUsd);
    tokensInZone.forEach((t, i) => {
      const col = zone.x + 1 + (i % Math.max(zone.width - 2, 1));
      const row = 2 + Math.floor(i / Math.max(zone.width - 2, 1)) * 2;
      out.set(t.ticker, { col: Math.min(col, WORLD_COLS - 1), row: Math.min(row, WORLD_ROWS - 1), platform: zone.platform });
    });
  }
  return out;
}

export type QuestStep =
  | { kind: "walk"; toCol: number; toRow: number; decisionId: string }
  | { kind: "battle"; decisionId: string; reason: string; sprite: string; allowed: false }
  | { kind: "arrive"; decisionId: string; allowed: true };

/**
 * Turns a real decision list into an ordered quest: walk to where the
 * trade happened, then either a battle (denied) or a quiet arrival
 * (allowed - nothing to fight, the mandate had nothing to say no to).
 * Decisions with no commit in range (settle-only) are skipped - there's
 * nowhere on the map to send the hero for one.
 */
export function buildQuest(decisions: Decision[]): QuestStep[] {
  const positions = tokenTilePositions();
  const steps: QuestStep[] = [];
  // decisions arrive newest-first (App.tsx); play them oldest-first so the
  // hero's journey reads in the order things actually happened on chain.
  const chronological = [...decisions].reverse();

  for (const d of chronological) {
    const c = d.commit;
    if (!c) continue;
    // A denied decision's token might be an impersonator/unrecognized
    // address with no real liquidity entry - walk toward a fixed
    // "unrecognized territory" marker just past the edge of every zone
    // instead of guessing a fake position for it.
    const target = findTokenPosition(c.token, positions);
    steps.push({ kind: "walk", toCol: target.col, toRow: target.row, decisionId: d.id });
    if (!c.allowed) {
      steps.push({ kind: "battle", decisionId: d.id, reason: c.reason, sprite: spriteForReason(c.reason), allowed: false });
    } else {
      steps.push({ kind: "arrive", decisionId: d.id, allowed: true });
    }
  }
  return steps;
}

function findTokenPosition(
  tokenAddress: string,
  positions: Map<string, { col: number; row: number; platform: Platform }>,
): { col: number; row: number } {
  const known = TERRITORY_TOKENS.find((t) => t.address?.toLowerCase() === tokenAddress.toLowerCase());
  if (known) {
    const pos = positions.get(known.ticker);
    if (pos) return pos;
  }
  // Unrecognized territory: just past the last zone's edge.
  return { col: WORLD_COLS - 1, row: WORLD_ROWS - 1 };
}
