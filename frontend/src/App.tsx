import { useEffect, useState, type ReactNode } from "react";
import { fetchSnapshot, BSC_CHAIN_ID, fmtAmount, describeDecision, guardedVsUnguarded, bossFor, tokenName, type CovenantSnapshot, type Decision } from "./lib/covenant";
import { TradingCard } from "./components/TradingCard";
import { GameCanvas } from "./components/GameCanvas";
import { monsterFor } from "./game/logic";
import narration from "./data/narration.json";

const WIDE_MIN_PX = 900;
/** The menu's width (360) plus its 12px margin and a 12px gap before the town. */
const PANEL_STRIP_PX = 384;

function readUrlParams() {
  const params = new URLSearchParams(location.search);
  return {
    rpc: params.get("rpc") ?? "",
    contract: params.get("contract") ?? "",
    fromBlock: params.get("fromBlock") ?? "",
  };
}

// JS Date is only meaningful up to +275760-09-13 (8.64e15 ms since epoch).
// A mandate expiry is a uint256 and can legitimately be set to something
// absurdly large (e.g. type(uint256).max) as a "doesn't really expire"
// sentinel; Number() on that silently rounds to Infinity and new Date()
// then prints "Invalid Date" instead of failing loudly.
const MAX_SAFE_UNIX_SECONDS = 8_640_000_000_000n / 1000n;

function fmtTime(unixSeconds: bigint): string {
  if (unixSeconds === 0n) return "never";
  if (unixSeconds > MAX_SAFE_UNIX_SECONDS) return "effectively never (far past year 9999)";
  return new Date(Number(unixSeconds) * 1000).toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

/** A Pokemon-menu window: cream fill, thick dark frame with a light inner rule, pixel-font title. */
function PokeBox({ title, children, className = "" }: { title?: string; children: ReactNode; className?: string }) {
  return (
    <section
      className={`rounded-xl border-4 border-slate-800 bg-[#fffdf3] p-3 text-slate-800 shadow-[inset_0_0_0_2px_#cbd5e1,0_4px_0_#1e293b] ${className}`}
    >
      {title && <h2 className="font-pixel mb-3 text-[9px] text-slate-700">▶ {title}</h2>}
      {children}
    </section>
  );
}

const INPUT =
  "w-full rounded-md border-2 border-slate-400 bg-white px-2 py-1.5 text-xs text-slate-800 outline-none placeholder:text-slate-400 focus:border-blue-500";

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-slate-100 px-2 py-1.5">
      <div className="font-pixel text-[7px] leading-relaxed text-slate-500">{label.toUpperCase()}</div>
      <div className="mt-0.5 text-sm font-semibold text-slate-800">{value}</div>
    </div>
  );
}

function DecisionRow({ d }: { d: Decision }) {
  const c = d.commit;
  const plain = describeDecision(d, fmtAmount);
  const twin = guardedVsUnguarded(d, fmtAmount);
  const boss = c && !c.allowed ? bossFor(c.reason) : null;
  const monster = c && !c.allowed ? monsterFor(c.reason).name : null;

  return (
    <div className="border-b-2 border-dashed border-slate-300 py-2.5 last:border-b-0">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-slate-500">
        <span className="font-pixel text-[8px] text-slate-800">No.{d.id}</span>
        {c && <span className="font-semibold uppercase">{c.side}</span>}
        {c && (
          <span className="font-semibold text-blue-700" title={c.token}>
            {tokenName(c.token)}
          </span>
        )}
        <StatusBadge d={d} />
      </div>
      <p className="mt-1 text-xs text-slate-600">{plain}</p>
      {c && (narration as Record<string, string>)[c.txHash] && (
        <p className="mt-1 text-xs font-semibold text-amber-700">🎙️ {(narration as Record<string, string>)[c.txHash]}</p>
      )}
      {twin && <p className="mt-1.5 rounded-md border-2 border-green-200 bg-green-50 px-2 py-1 text-xs text-green-800">{twin}</p>}
      {boss && (
        <p className="mt-1.5 text-[11px] text-slate-500">
          {boss.icon} In the game: lost to the <span className="font-semibold text-red-700">{monster}</span>.
        </p>
      )}
      {c?.allowed && (
        <p className="mt-1.5 text-[11px] text-slate-500">
          In the game: beat the <span className="font-semibold text-green-700">RULE CHECKER</span>.
        </p>
      )}
    </div>
  );
}

function Badge({ color, children }: { color: string; children: ReactNode }) {
  return <span className={`font-pixel rounded-md border-2 border-slate-800 px-1.5 py-0.5 text-[7px] text-white ${color}`}>{children}</span>;
}

function StatusBadge({ d }: { d: Decision }) {
  if (!d.commit) return <Badge color="bg-blue-600">SETTLED</Badge>;
  if (!d.commit.allowed) return <Badge color="bg-red-600">BLOCKED</Badge>;
  if (d.cancelled) return <Badge color="bg-slate-500">CANCELLED</Badge>;
  if (d.settle) return <Badge color="bg-green-600">{d.settle.belowMin ? "FILLED, BELOW MIN" : "FILLED"}</Badge>;
  return <Badge color="bg-green-600">ALLOWED</Badge>;
}

export default function App() {
  const initial = readUrlParams();
  const [rpc, setRpc] = useState(initial.rpc);
  const [contract, setContract] = useState(initial.contract);
  const [fromBlock, setFromBlock] = useState(initial.fromBlock);
  const [snapshot, setSnapshot] = useState<CovenantSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);
  const [wide, setWide] = useState(() => window.innerWidth >= WIDE_MIN_PX);

  useEffect(() => {
    const onResize = () => setWide(window.innerWidth >= WIDE_MIN_PX);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // On a wide screen the open menu reserves its strip and the town recenters
  // beside it, so the menu can stay open without ever covering a battle. On
  // a narrow screen there's no room for both, so the menu overlays and
  // closes itself when the replay starts.
  const rightInset = panelOpen && wide ? PANEL_STRIP_PX : 0;

  async function load() {
    setError(null);
    if (!rpc || !contract) {
      setError("Both RPC URL and contract address are required.");
      return;
    }
    setLoading(true);
    try {
      const snap = await fetchSnapshot(rpc, contract, fromBlock);
      setSnapshot(snap);
      // Wide screens keep the menu open beside the town. A narrow screen has
      // no room for both, and the menu would hide the start card.
      if (window.innerWidth < WIDE_MIN_PX) setPanelOpen(false);
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (initial.rpc && initial.contract) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <main className="relative h-screen w-screen overflow-hidden bg-[var(--bg)]">
      {/* The game fills the entire screen; the menu floats on top of it. */}
      {snapshot ? (
        <GameCanvas
          // Force a remount on every new LOAD: Phaser owns its own internal
          // scene state (sprite positions, which decisions it's already
          // animated), and reusing the same canvas instance across a second
          // fetchSnapshot() call (a different contract, or the same one re-
          // scanned) would leave stale sprites from the previous snapshot
          // mixed in with the new one instead of starting clean.
          key={`${rpc}:${contract}:${fromBlock}`}
          decisions={snapshot.decisions}
          rightInset={rightInset}
          onStart={() => {
            if (!wide) setPanelOpen(false);
          }}
        />
      ) : (
        <div className="flex h-full flex-col items-center justify-center gap-6 bg-[var(--bg)] px-6 text-center">
          <h1 className="font-pixel text-xl text-[var(--text)] sm:text-2xl">COVENANT</h1>
          <p className="max-w-sm text-xs text-[var(--muted)]">
            A guarded trading agent's real on-chain mandate, played back as a world you walk through.
          </p>
          <p className="font-pixel animate-pulse text-[10px] text-[var(--accent)]">▶ OPEN THE MENU TO START</p>
        </div>
      )}

      <button
        onClick={() => setPanelOpen((v) => !v)}
        className="font-pixel absolute right-3 top-3 z-20 rounded-lg border-4 border-slate-800 bg-[#fffdf3] px-3 py-2 text-[10px] text-slate-800 shadow-[0_4px_0_#1e293b] transition hover:bg-yellow-200 active:translate-y-1 active:shadow-none"
      >
        {panelOpen ? "✕ CLOSE" : "☰ MENU"}
      </button>

      {panelOpen && (
        <aside className="absolute right-3 top-16 z-20 max-h-[calc(100%-5rem)] w-[360px] space-y-3 overflow-y-auto rounded-2xl border-4 border-slate-800 bg-sky-200/95 p-3 text-sm shadow-2xl">
          <PokeBox title="CONNECT">
            <div className="space-y-2">
              <input className={INPUT} placeholder="RPC URL" value={rpc} onChange={(e) => setRpc(e.target.value)} />
              <input
                className={INPUT}
                placeholder="Covenant contract address (0x...)"
                value={contract}
                onChange={(e) => setContract(e.target.value)}
              />
              <div className="flex gap-2">
                <input
                  className={INPUT}
                  placeholder="fromBlock (optional)"
                  value={fromBlock}
                  onChange={(e) => setFromBlock(e.target.value)}
                />
                <button
                  onClick={load}
                  disabled={loading}
                  className="font-pixel shrink-0 rounded-md border-2 border-slate-800 bg-yellow-300 px-3 text-[9px] text-slate-900 shadow-[0_3px_0_#1e293b] transition hover:bg-yellow-200 active:translate-y-0.5 active:shadow-none disabled:opacity-50"
                >
                  {loading ? "…" : "LOAD"}
                </button>
              </div>
            </div>
            {error && <p className="mt-2 rounded-md bg-red-50 px-2 py-1 text-xs text-red-700">{error}</p>}
          </PokeBox>

          {snapshot && (
            <>
              <section className="flex justify-center">
                <TradingCard record={snapshot.trackRecord} contract={snapshot.contractAddress} rpcHost={snapshot.rpcHost} chainId={snapshot.chainId} />
              </section>

              <PokeBox title="THE RULES">
                <div className="grid grid-cols-2 gap-2">
                  <StatTile label="Active" value={snapshot.mandate.active ? "yes" : "no"} />
                  <StatTile label="Max per trade" value={`$${fmtAmount(snapshot.mandate.maxNotionalPerTradeUsd)}`} />
                  <StatTile label="Trades today" value={`${snapshot.tradesUsedToday} / ${snapshot.mandate.maxTradesPerDay}`} />
                  <StatTile label="Expires" value={fmtTime(snapshot.mandate.expiry)} />
                  <StatTile label="Daily notional cap" value={snapshot.maxDailyNotionalUsd === 0n ? "off" : `$${fmtAmount(snapshot.maxDailyNotionalUsd)}`} />
                  <StatTile label="Spent today" value={`$${fmtAmount(snapshot.notionalUsedToday)}`} />
                  <StatTile label="Agent" value={snapshot.agent.slice(0, 6) + "…" + snapshot.agent.slice(-4)} />
                </div>
                <p className={`mt-2 text-[10px] ${snapshot.chainId === BSC_CHAIN_ID ? "text-slate-500" : "font-semibold text-red-700"}`}>
                  Read from {snapshot.rpcHost}, chain {snapshot.chainId}
                  {snapshot.chainId === BSC_CHAIN_ID ? "." : " - not BSC mainnet."} This page shows only what that RPC returned; to check it independently, run verify.ts.
                </p>
              </PokeBox>

              <PokeBox title={snapshot.totalDecisions > snapshot.decisions.length ? `TRADE LOG (NEWEST ${snapshot.decisions.length} OF ${snapshot.totalDecisions})` : "TRADE LOG (NEWEST FIRST)"}>
                {snapshot.decisions.length === 0 ? (
                  <p className="text-xs italic text-slate-500">No decisions found in the scanned block range.</p>
                ) : (
                  snapshot.decisions.map((d) => <DecisionRow key={d.id} d={d} />)
                )}
              </PokeBox>
            </>
          )}
        </aside>
      )}
    </main>
  );
}
