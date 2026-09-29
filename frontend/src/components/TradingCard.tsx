import identityEvidence from "../../../docs/evidence/erc8004-registration.json";
import { classifyRarity, RARITY_STYLE, type TrackRecord } from "../lib/rarity";
import { HERO_FRAME } from "../game/logic";
import { Sprite } from "./Sprite";

interface TradingCardProps {
  /** Over every decision in the scanned range (see CovenantSnapshot.trackRecord). */
  record: TrackRecord;
  /** The Covenant contract these numbers were read from. */
  contract: string;
}

function Move({ name, detail, value }: { name: string; detail: string; value: number }) {
  return (
    <div className="flex items-center gap-2 border-b-2 border-slate-800/15 py-1.5 last:border-b-0">
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 border-slate-800 bg-white text-[9px]">★</span>
      <div className="min-w-0 flex-1">
        <div className="font-pixel text-[8px] leading-relaxed text-slate-900">{name}</div>
        <div className="text-[10px] leading-tight text-slate-600">{detail}</div>
      </div>
      <span className="font-pixel text-sm text-slate-900">{value}</span>
    </div>
  );
}

/**
 * The agent's real ERC-8004 identity (registered on BSC mainnet - see
 * docs/evidence/erc8004-registration.json, written by
 * scripts/register-erc8004.ts at registration time) drawn as a Pokemon-style
 * trading card. Every number on it comes from the decisions of the contract that is loaded (named on the card).
 */
export function TradingCard({ record, contract }: TradingCardProps) {
  const rarity = classifyRarity(record);
  const style = RARITY_STYLE[rarity];

  return (
    <div className="w-72 rounded-2xl border-4 border-slate-800 bg-yellow-300 p-2 shadow-[0_4px_0_#1e293b]">
      <div className={`rounded-lg border-2 border-slate-800 p-2 text-slate-900 ${style.panel}`}>
        <div className="flex items-center justify-between">
          <div className="flex items-baseline gap-2">
            <span className="font-pixel rounded border-2 border-slate-800 bg-white px-1 text-[6px] leading-relaxed">AGENT</span>
            <span className="font-pixel text-[11px]">{identityEvidence.registrationDoc.name.toUpperCase()}</span>
          </div>
          <span className="font-pixel text-[7px] text-slate-700">No.{identityEvidence.agentId}</span>
        </div>

        <div className="mt-2 overflow-hidden rounded-md border-4 border-amber-500 bg-gradient-to-b from-sky-300 via-sky-200 to-green-300">
          <div className="flex h-28 items-end justify-center pb-2">
            <div className="flex flex-col items-center">
              <Sprite sheet="dungeon" frame={HERO_FRAME} size={80} />
              <span className="-mt-2 h-2 w-16 rounded-[50%] bg-green-700/40" />
            </div>
          </div>
        </div>
        <p className="mt-1 rounded bg-amber-400/60 px-2 py-0.5 text-center text-[9px] italic text-slate-800">
          ERC-8004 Trustless Agent · BSC mainnet
        </p>

        <div className="mt-2 rounded-md bg-white/60 px-2">
          <Move name="MANDATE CHECK" detail="Trades checked against the rules" value={record.total} />
          <Move name="RULE BLOCK" detail="Risky trades stopped, money kept" value={record.denied} />
          <Move name="IRON WALL" detail="Most blocks in a row" value={record.longestDenialStreak} />
        </div>

        <div className="mt-2 flex items-end justify-between text-[9px] text-slate-600">
          <div className="space-y-0.5">
            <div className="truncate" title={identityEvidence.owner}>
              Trainer {identityEvidence.owner.slice(0, 6)}…{identityEvidence.owner.slice(-4)}
            </div>
            <div className="truncate" title={identityEvidence.txHash}>
              Minted {identityEvidence.txHash.slice(0, 10)}…
            </div>
            <div className="truncate" title={contract}>
              Stats from {contract.slice(0, 6)}…{contract.slice(-4)}
            </div>
          </div>
          <span className="font-pixel text-[7px] text-slate-800" title={`Rarity: ${style.label}`}>
            {style.symbol} {style.label}
          </span>
        </div>
      </div>
    </div>
  );
}
