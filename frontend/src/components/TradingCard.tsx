import { useMemo } from "react";
import identityEvidence from "../../../docs/evidence/erc8004-registration.json";
import type { Decision } from "../lib/covenant";
import { computeTrackRecord, classifyRarity, RARITY_STYLE } from "../lib/rarity";

interface TradingCardProps {
  decisions: Decision[];
}

/**
 * The real ERC-8004 identity registered on BSC mainnet for this build
 * (docs/evidence/erc8004-registration.json - agentId, registry, tx hash,
 * and an on-chain re-read all captured by scripts/register-erc8004.ts at
 * registration time, not typed in here by hand).
 */
export function TradingCard({ decisions }: TradingCardProps) {
  const record = useMemo(() => computeTrackRecord(decisions), [decisions]);
  const rarity = classifyRarity(record);
  const style = RARITY_STYLE[rarity];

  return (
    <div
      className={`relative w-72 overflow-hidden rounded-xl border-2 bg-gradient-to-br p-4 shadow-2xl ${style.gradient}`}
      style={{ borderColor: style.glow, boxShadow: `0 0 24px ${style.glow}` }}
    >
      <div className="flex items-center justify-between">
        <span className="rounded-full bg-black/40 px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest text-white">
          {style.label}
        </span>
        <span className="text-[10px] font-mono text-white/70">#{identityEvidence.agentId}</span>
      </div>

      <div className="mt-3 flex items-center justify-center text-6xl">🛡️</div>

      <h3 className="mt-2 text-center text-lg font-extrabold tracking-wide text-white drop-shadow">
        {identityEvidence.registrationDoc.name}
      </h3>
      <p className="text-center text-[11px] text-white/70">ERC-8004 Trustless Agent</p>

      <div className="mt-4 grid grid-cols-3 gap-2 rounded-lg bg-black/30 p-2 text-center">
        <div>
          <div className="text-lg font-bold text-white">{record.total}</div>
          <div className="text-[9px] uppercase tracking-wide text-white/60">Decisions</div>
        </div>
        <div>
          <div className="text-lg font-bold text-white">{record.denied}</div>
          <div className="text-[9px] uppercase tracking-wide text-white/60">Denied</div>
        </div>
        <div>
          <div className="text-lg font-bold text-white">{record.longestDenialStreak}</div>
          <div className="text-[9px] uppercase tracking-wide text-white/60">Best streak</div>
        </div>
      </div>

      <div className="mt-3 space-y-0.5 text-[10px] text-white/60">
        <div className="truncate" title={identityEvidence.owner}>
          owner: {identityEvidence.owner.slice(0, 6)}…{identityEvidence.owner.slice(-4)}
        </div>
        <div className="truncate" title={identityEvidence.txHash}>
          minted: {identityEvidence.txHash.slice(0, 10)}…
        </div>
      </div>
    </div>
  );
}
