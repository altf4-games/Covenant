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
      <div className="text-[11px] uppercase tracking-wide text-[var(--muted)]">{label}</div>
      <div className="mt-0.5 text-lg">{value}</div>
    </div>
  );
}

function DecisionRow({ d }: { d: Decision }) {
  const c = d.commit;
  const plain = describeDecision(d, fmtAmount);
  const twin = guardedVsUnguarded(d, fmtAmount);
  const boss = c && !c.allowed ? bossFor(c.reason) : null;

  return (
    <div className="border-b border-[var(--border)] py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--muted)]">
        <span className="font-semibold text-[var(--text)]">#{d.id}</span>
        {c && <span>{c.blockNumber}</span>}
        {c && <span className="uppercase">{c.side}</span>}
        {c && (
          <span className="text-[var(--accent)]" title={c.token}>
            {tokenName(c.token)}
          </span>
        )}
        <StatusBadge d={d} />
      </div>
      <p className="mt-1 text-sm italic text-[var(--muted)]">{plain}</p>
      {(narration as Record<string, string>)[d.id] && (
        <p className="mt-1 text-sm font-semibold text-[var(--gold)]">🎙️ {(narration as Record<string, string>)[d.id]}</p>
      )}
      {twin && (
        <p className="mt-1 rounded bg-[rgba(62,207,142,.06)] px-2 py-1 text-sm text-[var(--allow)]">{twin}</p>
      )}
      {boss && (
        <p className="mt-1 text-xs text-[var(--muted)]">
          {boss.icon} Fought in the world above as <span className="font-semibold">{boss.name}</span>.
        </p>
      )}
    </div>
  );
}

function StatusBadge({ d }: { d: Decision }) {
  if (!d.commit) return <span className="rounded-full bg-white/10 px-2 py-0.5 text-[11px] font-semibold">SETTLED</span>;
  if (!d.commit.allowed) return <span className="rounded-full bg-[rgba(229,72,77,.15)] px-2 py-0.5 text-[11px] font-semibold text-[var(--deny)]">DENIED</span>;
  if (d.cancelled) return <span className="rounded-full bg-white/10 px-2 py-0.5 text-[11px] font-semibold">CANCELLED</span>;
  if (d.settle) return <span className="rounded-full bg-[rgba(62,207,142,.15)] px-2 py-0.5 text-[11px] font-semibold text-[var(--allow)]">{d.settle.belowMin ? "SETTLED, BELOW MIN" : "SETTLED"}</span>;
  return <span className="rounded-full bg-[rgba(62,207,142,.15)] px-2 py-0.5 text-[11px] font-semibold text-[var(--allow)]">ALLOWED</span>;
}

export default function App() {
  const initial = readUrlParams();
  const [rpc, setRpc] = useState(initial.rpc);
  const [contract, setContract] = useState(initial.contract);
  const [fromBlock, setFromBlock] = useState(initial.fromBlock);
  const [snapshot, setSnapshot] = useState<CovenantSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

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
    <main className="mx-auto max-w-4xl px-4 py-8">
      <h1 className="text-lg font-semibold text-[var(--text)]">Covenant — mandate status</h1>
      <p className="mt-1 text-xs text-[var(--muted)]">
        Read-only, straight off chain. No backend — every value here is an eth_call or an event log read live from the RPC endpoint below.
      </p>

      <section className="mt-6 rounded-lg border border-[var(--border)] bg-[var(--panel)] p-4">
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Connection</h2>
        <div className="flex flex-wrap gap-2">
          <input
            className="min-w-[220px] flex-1 rounded border border-[var(--border)] bg-[#0e1013] px-3 py-2 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
            placeholder="RPC URL"
            value={rpc}
            onChange={(e) => setRpc(e.target.value)}
          />
          <input
            className="min-w-[220px] flex-1 rounded border border-[var(--border)] bg-[#0e1013] px-3 py-2 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
            placeholder="Covenant contract address (0x...)"
            value={contract}
            onChange={(e) => setContract(e.target.value)}
          />
        </div>
        <div className="mt-2 flex gap-2">
          <input
            className="flex-1 rounded border border-[var(--border)] bg-[#0e1013] px-3 py-2 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
            placeholder="fromBlock (optional)"
            value={fromBlock}
            onChange={(e) => setFromBlock(e.target.value)}
          />
          <button
            onClick={load}
            disabled={loading}
            className="rounded bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-[#0b0d10] disabled:opacity-50"
          >
            {loading ? "Loading…" : "Load"}
          </button>
        </div>
        {error && <p className="mt-2 text-sm text-[var(--deny)]">{error}</p>}
      </section>

      {snapshot && (
        <>
          <section className="mt-6 flex justify-center">
            <TradingCard decisions={snapshot.decisions} />
          </section>

          <section className="mt-4">
            <GameCanvas decisions={snapshot.decisions} />
          </section>

          <section className="mt-4 rounded-lg border border-[var(--border)] bg-[var(--panel)] p-4">
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Mandate</h2>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <StatTile label="Active" value={snapshot.mandate.active ? "yes" : "no"} />
              <StatTile label="Max per trade" value={`$${fmtAmount(snapshot.mandate.maxNotionalPerTradeUsd)}`} />
              <StatTile label="Trades today" value={`${snapshot.tradesUsedToday} / ${snapshot.mandate.maxTradesPerDay}`} />
              <StatTile label="Expires" value={fmtTime(snapshot.mandate.expiry)} />
              <StatTile label="Daily notional cap" value={snapshot.maxDailyNotionalUsd === 0n ? "off" : `$${fmtAmount(snapshot.maxDailyNotionalUsd)}`} />
              <StatTile label="Spent today" value={`$${fmtAmount(snapshot.notionalUsedToday)}`} />
              <StatTile label="Oracle staleness bound" value={`${snapshot.stalenessBound}s`} />
              <StatTile label="Agent" value={snapshot.agent.slice(0, 6) + "…" + snapshot.agent.slice(-4)} />
            </div>
          </section>

          <section className="mt-4 rounded-lg border border-[var(--border)] bg-[var(--panel)] p-4">
            <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Decisions (most recent first)</h2>
            {snapshot.decisions.length === 0 ? (
              <p className="text-sm italic text-[var(--muted)]">No decisions found in the scanned block range.</p>
            ) : (
              snapshot.decisions.map((d) => <DecisionRow key={d.id} d={d} />)
            )}
          </section>
        </>
      )}
    </main>
  );
}
