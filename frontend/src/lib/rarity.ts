import type { Decision } from "./covenant";

export type Rarity = "Bronze" | "Silver" | "Gold" | "Legendary";

export interface TrackRecord {
  total: number;
  denied: number;
  settled: number;
  longestDenialStreak: number;
  sawFlagshipDenial: boolean; // a real ClosedMarketDrift catch
}

export function computeTrackRecord(decisions: Decision[]): TrackRecord {
  // Every figure below is the same whichever way the list is walked (a longest
  // run of denials doesn't depend on direction), so no reordering is needed.
  let total = 0;
  let denied = 0;
  let settled = 0;
  let longestDenialStreak = 0;
  let currentStreak = 0;
  let sawFlagshipDenial = false;

  for (const d of decisions) {
    if (!d.commit) continue;
    total++;
    if (!d.commit.allowed) {
      denied++;
      currentStreak++;
      longestDenialStreak = Math.max(longestDenialStreak, currentStreak);
      if (d.commit.reason === "ClosedMarketDrift") sawFlagshipDenial = true;
    } else {
      currentStreak = 0;
      if (d.settle) settled++;
    }
  }

  return { total, denied, settled, longestDenialStreak, sawFlagshipDenial };
}

/**
 * Rarity tier from a real track record - a real classification task
 * (messy stats in, one fixed category out), which is exactly what TypeSafe's
 * Jev model (a "System One" classifier, not a text generator - confirmed by
 * reading its own docs, 2026-09-26) is built for, unlike Gemini's narration
 * job. Wired here as a deterministic, fully disclosed heuristic instead of
 * a live Jev call: getting a real Jev API key needs a new third-party
 * account sign-up this session can't do on the user's behalf, the same
 * constraint as Gemini's free-tier key. Swap this function's body for a
 * real `jevClassify(record, ["Bronze","Silver","Gold","Legendary"])` call
 * once a key exists - the rest of the card doesn't need to change.
 */
export function classifyRarity(record: TrackRecord): Rarity {
  if (record.sawFlagshipDenial) return "Legendary";
  if (record.denied > 0 && record.settled >= 1) return "Gold";
  if (record.total >= 3) return "Silver";
  return "Bronze";
}

/**
 * Trading-card look per tier: the inner panel color (like a card's type
 * color) and a corner rarity symbol, the way a real TCG card marks rarity.
 */
export const RARITY_STYLE: Record<Rarity, { panel: string; symbol: string; label: string }> = {
  Bronze: { panel: "bg-gradient-to-b from-orange-100 to-amber-200", symbol: "●", label: "BRONZE" },
  Silver: { panel: "bg-gradient-to-b from-slate-100 to-slate-300", symbol: "◆", label: "SILVER" },
  Gold: { panel: "bg-gradient-to-b from-yellow-100 to-amber-300", symbol: "★", label: "GOLD" },
  Legendary: { panel: "bg-gradient-to-b from-rose-100 via-amber-100 to-violet-200", symbol: "★★", label: "LEGENDARY" },
};
