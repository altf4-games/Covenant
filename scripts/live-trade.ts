/**
 * One full iteration of the Covenant loop against the real Agentic Wallet:
 * refresh the oracle if stale, quote, check, commit, swap, settle from the
 * receipt's net movement. Run from the repo root under Node 22; `baw` is run
 * under Node 20 because its login session is stored per Node version.
 *
 *   npx tsx scripts/live-trade.ts <buy|sell> <qty> [deny]
 *   MINBPS=9500 npx tsx scripts/live-trade.ts buy 0.1 deny   (minOut at 95% of the quote: SlippageTooLoose)
 *
 * "deny" commits even when `check` says the decision would be denied, to put
 * the denial on chain. It never cancels a decision on its own: after the first
 * live sell, a status lookup that found nothing led an earlier version to
 * cancel a decision whose swap had already filled, and a cancelled decision
 * can't be settled, so that sell is permanently an UNMATCHED_TRADE.
 * The swap's own `orderId` is one off from the listed order's id, so the
 * order is found by token pair and start time instead.
 */
import { ethers } from "ethers";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { bscProvider } from "./lib/bsc-provider.js";
import covenantArtifact from "../artifacts/contracts/Covenant.sol/Covenant.json" with { type: "json" };
process.loadEnvFile();
const COV = process.env.COVENANT_ADDRESS!;
const WALLET = process.env.AGENT_ADDRESS!;
const NVDAB = "0x02fca66c1d1afb4e2a7884261eb00f63598a7436";
const USDT = "0x55d398326f99059fF775485246999027B3197955";
const ROUTER = "0xb300000b72deaeb607a12d5f54773d1c19c7028d";
const RPC = "https://rpc-bsc.48.club";
const iface = new ethers.Interface(covenantArtifact.abi);
const provider = bscProvider();
const BAWENV = { ...process.env, PATH: "/opt/homebrew/opt/node@20/bin:" + process.env.PATH };
const cli = (cmd: string, p: object) => JSON.parse(execFileSync("node", ["skills/covenant-mandate/scripts/cli.mjs", cmd, JSON.stringify(p)], { encoding: "utf8" }));
const baw = (...a: string[]) => {
  const out = execFileSync("baw", [...a, "--json"], { encoding: "utf8", cwd: "/tmp", env: BAWENV });
  const j = JSON.parse(out);
  if (!j.success) throw new Error("baw failed: " + out);
  return j.data;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function receiptOf(hash: string) {
  for (let i = 0; i < 90; i++) { const r = await provider.getTransactionReceipt(hash).catch(() => null); if (r) return r; await sleep(2000); }
  throw new Error("no receipt " + hash);
}
async function callCov(calldata: string) {
  const pre = baw("contract-call", "preview", "--binanceChainId", "56", "--from", WALLET, "--to", COV, "--value", "0", "--inputData", calldata);
  if (pre.requireConfirmation || pre.risks?.riskDetails?.length) throw new Error("preview flagged: " + JSON.stringify(pre.risks) + " confirm=" + pre.requireConfirmation);
  const ex = baw("contract-call", "execute", "--requestId", pre.requestId);
  if (!ex.txHash) throw new Error("no txHash: " + JSON.stringify(ex));
  const r = await receiptOf(ex.txHash);
  if (r.status !== 1) throw new Error("tx reverted " + ex.txHash);
  return r;
}

const [side, qty, mode] = process.argv.slice(2); // side buy|sell, qty in baw units, mode: "" | "deny"
const isBuy = side === "buy";
const fromToken = isBuy ? USDT : NVDAB, toToken = isBuy ? NVDAB : USDT;
// oracle fresh?
const cov = new ethers.Contract(COV, covenantArtifact.abi, provider);
const os = await cov.oracleStatus(NVDAB);
if (Date.now() / 1000 - Number(os.updatedAt) > 420) {
  console.log("refreshing oracle...");
  try { execFileSync("npx", ["tsx", "scripts/oracle-updater.ts"], { encoding: "utf8", stdio: "pipe" }); } catch (e: any) { throw new Error("oracle update failed: " + e.stdout + e.stderr); }
}
const quoteRaw = execFileSync("baw", ["market-order", "quote", "--binanceChainId", "56", "--fromTokenQty", qty, "--fromToken", fromToken, "--toToken", toToken, "--json"], { encoding: "utf8", cwd: "/tmp", env: BAWENV });
const quote = JSON.parse(quoteRaw).data;
console.log("quote", qty, quote.fromCoinSymbol, "->", quote.toCoinAmount, quote.toCoinSymbol);
const quoteRef = cli("hash-ref", { text: quoteRaw }).hash ?? cli("hash-ref", { text: quoteRaw });
let amountIn = ethers.parseUnits(qty, 18);
if (!isBuy) amountIn = (amountIn * 1002n) / 1000n; // shares vs token units (friction-log C17): commit a hair above the real outflow
const quotedOut = ethers.parseUnits(quote.toCoinAmount, 18);
const minOut = (quotedOut * BigInt(process.env.MINBPS ?? "9950")) / 10000n;
const args = { side, tokenAddress: NVDAB, amountIn: amountIn.toString(), quotedOut: quotedOut.toString(), minOut: minOut.toString() };
const chk = cli("check", { rpcUrl: RPC, covenantAddress: COV, ...args });
console.log("check:", JSON.stringify(chk.decision ?? chk));
const allowedByCheck = (chk.decision ?? chk).allowed;
if (!allowedByCheck && mode !== "deny") throw new Error("denied by check; not committing (use deny mode to record a denial)");
const cd = cli("build-commit-calldata", { ...args, quoteRef: typeof quoteRef === "string" ? quoteRef : quoteRef.ref ?? quoteRef.quoteRef });
const commitCalldata = cd.calldata ?? cd.inputData ?? cd;
const cr = await callCov(commitCalldata);
let id = 0n, allowed = false, reason = -1;
for (const l of cr.logs) { try { const p = iface.parseLog(l as any); if (p?.name === "DecisionCommitted") { id = p.args.id; allowed = p.args.allowed; reason = Number(p.args.reason); } } catch {} }
console.log(`commit tx ${cr.hash}: decision #${id} allowed=${allowed} reason=${reason}`);
if (!allowed) { console.log("DENIED on chain - no swap."); process.exit(0); }
const startMs = Date.now() - 5000;
const sw = baw("market-order", "swap", "--binanceChainId", "56", "--fromTokenQty", qty, "--fromToken", fromToken, "--toToken", toToken);
console.log("swap response", JSON.stringify(sw));
let txHash = "";
for (let i = 0; i < 60 && !txHash; i++) {
  await sleep(3000);
  const l = baw("market-order", "list", "--binanceChainId", "56", "--fromToken", fromToken, "--toToken", toToken, "--startTime", String(startMs));
  const o = (l.list ?? [])[0];
  if (!o) continue;
  if (o.status === "FINISHED") { txHash = o.txHash; console.log("swap FINISHED", txHash, "order", o.orderId); }
  else if (o.status === "FAILED") { console.log("swap FAILED - decision", id.toString(), "left OPEN; inspect, then cancel by hand:", JSON.stringify(o)); process.exit(1); }
}
if (!txHash) { console.log("swap status unknown after 3 min - decision", id.toString(), "left OPEN. Check `baw market-order list` and the wallet balance before touching it."); process.exit(1); }
const sr = await receiptOf(txHash);
const tIface = new ethers.Interface(["event Transfer(address indexed from,address indexed to,uint256 value)"]);
const outTok = toToken.toLowerCase();
let net = 0n;
for (const l of sr.logs) {
  if (l.address.toLowerCase() !== outTok) continue;
  try { const p = tIface.parseLog(l as any)!; if (p.args.to.toLowerCase() === WALLET.toLowerCase()) net += p.args.value; if (p.args.from.toLowerCase() === WALLET.toLowerCase()) net -= p.args.value; } catch {}
}
const em = cli("classify-execution-mode", { to: sr.to });
const execMode = em.executionMode ?? em.mode ?? em;
console.log("swap tx to", sr.to, "net received", ethers.formatUnits(net, 18), "mode", execMode);
const sd = cli("build-settle-calldata", { decisionId: id.toString(), swapTxHash: txHash, amountOut: net.toString(), executionMode: execMode });
const setr = await callCov(sd.calldata ?? sd.inputData ?? sd);
console.log("settle tx", setr.hash);
const d = await cov.getDecision?.(id).catch(() => null);
console.log("DONE decision", id.toString());
