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
  // Decisions are newest-first (App.tsx reverses joinDecisions' oldest-first
  // order) - walk oldest-first here so "streak" reads left-to-right in time.
  const chronological = [...decisions].reverse();
  let total = 0;
  let denied = 0;
  let settled = 0;
  let longestDenialStreak = 0;
  let currentStreak = 0;
  let sawFlagshipDenial = false;

  for (const d of chronological) {
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

export const RARITY_STYLE: Record<Rarity, { gradient: string; glow: string; label: string }> = {
  Bronze: { gradient: "from-[#5a4632] to-[#2a2118]", glow: "rgba(180,140,90,.35)", label: "Bronze" },
  Silver: { gradient: "from-[#7d8794] to-[#2c3038]", glow: "rgba(190,200,215,.4)", label: "Silver" },
  Gold: { gradient: "from-[#caa33d] to-[#3a2c0f]", glow: "rgba(245,196,81,.55)", label: "Gold" },
  Legendary: { gradient: "from-[#e5484d] via-[#f5c451] to-[#3a0f10]", glow: "rgba(229,72,77,.6)", label: "Legendary" },
};
