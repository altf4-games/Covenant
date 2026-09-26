import { useEffect, useState } from "react";
import { fetchSnapshot, fmtAmount, describeDecision, guardedVsUnguarded, bossFor, tokenName, type CovenantSnapshot, type Decision } from "./lib/covenant";
import { TradingCard } from "./components/TradingCard";
import { GameCanvas } from "./components/GameCanvas";
import narration from "./data/narration.json";

function readUrlParams() {
  const params = new URLSearchParams(location.search);
  return {
    rpc: params.get("rpc") ?? "",
    contract: params.get("contract") ?? "",
    fromBlock: params.get("fromBlock") ?? "",
  };
}

function fmtTime(unixSeconds: bigint): string {
  if (unixSeconds === 0n) return "never";
  return new Date(Number(unixSeconds) * 1000).toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-[var(--muted)]">{label}</div>
      <div className="mt-0.5 text-sm">{value}</div>
    </div>
  );
}

function DecisionRow({ d }: { d: Decision }) {
  const c = d.commit;
  const plain = describeDecision(d, fmtAmount);
  const twin = guardedVsUnguarded(d, fmtAmount);
  const boss = c && !c.allowed ? bossFor(c.reason) : null;

  return (
    <div className="border-b border-[var(--border)] py-2.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-[var(--muted)]">
        <span className="font-semibold text-[var(--text)]">#{d.id}</span>
        {c && <span className="uppercase">{c.side}</span>}
        {c && (
          <span className="text-[var(--accent)]" title={c.token}>
            {tokenName(c.token)}
          </span>
        )}
        <StatusBadge d={d} />
      </div>
      <p className="mt-1 text-xs italic text-[var(--muted)]">{plain}</p>
      {(narration as Record<string, string>)[d.id] && (
        <p className="mt-1 text-xs font-semibold text-[var(--gold)]">🎙️ {(narration as Record<string, string>)[d.id]}</p>
      )}
      {twin && <p className="mt-1 rounded bg-[rgba(62,207,142,.06)] px-2 py-1 text-xs text-[var(--allow)]">{twin}</p>}
      {boss && (
        <p className="mt-1 text-[11px] text-[var(--muted)]">
          {boss.icon} Fought in the world as <span className="font-semibold">{boss.name}</span>.
        </p>
      )}
    </div>
  );
}

function StatusBadge({ d }: { d: Decision }) {
  if (!d.commit) return <span className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] font-semibold">SETTLED</span>;
  if (!d.commit.allowed) return <span className="rounded-full bg-[rgba(229,72,77,.15)] px-2 py-0.5 text-[10px] font-semibold text-[var(--deny)]">DENIED</span>;
  if (d.cancelled) return <span className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] font-semibold">CANCELLED</span>;
  if (d.settle) return <span className="rounded-full bg-[rgba(62,207,142,.15)] px-2 py-0.5 text-[10px] font-semibold text-[var(--allow)]">{d.settle.belowMin ? "SETTLED, BELOW MIN" : "SETTLED"}</span>;
  return <span className="rounded-full bg-[rgba(62,207,142,.15)] px-2 py-0.5 text-[10px] font-semibold text-[var(--allow)]">ALLOWED</span>;
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
      {/* The game fills the entire screen - it is the app, not a panel next
          to the app. Everything else (connection form, trading card,
          mandate stats, decision log) is a Pokemon-menu-style overlay that
          floats ON TOP of the game canvas and can be pulled up or dismissed,
          rather than a sidebar that permanently shrinks the game area. Per
          direction: "I kind of wanted it to only be a game, and others can
          be sidepanels" + "the panels can be in game only." */}
      {snapshot ? (
        <GameCanvas decisions={snapshot.decisions} />
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
        className="font-pixel absolute right-3 top-3 z-20 rounded border-2 border-[var(--text)] bg-[var(--panel)] px-3 py-2 text-[10px] text-[var(--text)] shadow-lg hover:border-[var(--accent)] hover:text-[var(--accent)]"
      >
        {panelOpen ? "✕" : "☰ MENU"}
      </button>

      {panelOpen && (
        <aside className="absolute right-3 top-14 z-20 max-h-[calc(100%-4.5rem)] w-[360px] overflow-y-auto rounded-lg border-2 border-[var(--text)] bg-[var(--panel-2)]/95 p-3 text-sm shadow-2xl backdrop-blur-sm">
          <section className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-3">
            <h2 className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--muted)]">Connection</h2>
            <input
              className="mb-2 w-full rounded border border-[var(--border)] bg-[#0e1013] px-2 py-1.5 text-xs text-[var(--text)] outline-none focus:border-[var(--accent)]"
              placeholder="RPC URL"
              value={rpc}
              onChange={(e) => setRpc(e.target.value)}
            />
            <input
              className="mb-2 w-full rounded border border-[var(--border)] bg-[#0e1013] px-2 py-1.5 text-xs text-[var(--text)] outline-none focus:border-[var(--accent)]"
              placeholder="Covenant contract address (0x...)"
              value={contract}
              onChange={(e) => setContract(e.target.value)}
            />
            <div className="flex gap-2">
              <input
                className="flex-1 rounded border border-[var(--border)] bg-[#0e1013] px-2 py-1.5 text-xs text-[var(--text)] outline-none focus:border-[var(--accent)]"
                placeholder="fromBlock (optional)"
                value={fromBlock}
                onChange={(e) => setFromBlock(e.target.value)}
              />
              <button
                onClick={load}
                disabled={loading}
                className="rounded bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-[#0b0d10] disabled:opacity-50"
              >
                {loading ? "…" : "Load"}
              </button>
            </div>
            {error && <p className="mt-2 text-xs text-[var(--deny)]">{error}</p>}
          </section>

          {snapshot && (
            <>
              <section className="mt-3 flex justify-center">
                <TradingCard decisions={snapshot.decisions} />
              </section>

              <section className="mt-3 rounded-lg border border-[var(--border)] bg-[var(--panel)] p-3">
                <h2 className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--muted)]">Mandate</h2>
                <div className="grid grid-cols-2 gap-2">
                  <StatTile label="Active" value={snapshot.mandate.active ? "yes" : "no"} />
                  <StatTile label="Max per trade" value={`$${fmtAmount(snapshot.mandate.maxNotionalPerTradeUsd)}`} />
                  <StatTile label="Trades today" value={`${snapshot.tradesUsedToday} / ${snapshot.mandate.maxTradesPerDay}`} />
                  <StatTile label="Expires" value={fmtTime(snapshot.mandate.expiry)} />
                  <StatTile label="Daily notional cap" value={snapshot.maxDailyNotionalUsd === 0n ? "off" : `$${fmtAmount(snapshot.maxDailyNotionalUsd)}`} />
                  <StatTile label="Spent today" value={`$${fmtAmount(snapshot.notionalUsedToday)}`} />
                  <StatTile label="Agent" value={snapshot.agent.slice(0, 6) + "…" + snapshot.agent.slice(-4)} />
                </div>
              </section>

              <section className="mt-3 rounded-lg border border-[var(--border)] bg-[var(--panel)] p-3">
                <h2 className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--muted)]">Decisions (most recent first)</h2>
                {snapshot.decisions.length === 0 ? (
                  <p className="text-xs italic text-[var(--muted)]">No decisions found in the scanned block range.</p>
                ) : (
                  snapshot.decisions.map((d) => <DecisionRow key={d.id} d={d} />)
                )}
              </section>
            </>
          )}
        </aside>
      )}
    </main>
  );
}
