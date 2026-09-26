/**
 * Batch play-by-play narration (GAMIFICATION-PLAN-2026-09-25.md item 4),
 * via Gemini - not Jev, which is a pure classifier and can't generate
 * prose at all (confirmed by reading TypeSafe's own docs, 2026-09-26; see
 * frontend/src/lib/rarity.ts for where Jev-style classification *is* the
 * right fit, in this same build).
 *
 * Generated once, in a batch pass over real DecisionCommitted/
 * DecisionSettled events already on chain - not called live per event, per
 * the plan's own recommendation ("simpler, and the narration is generated
 * once, over the real final evidence, not tested repeatedly against fork
 * noise"). Writes frontend/src/data/narration.json, a static file the
 * React app reads - no live API call from the browser, no key exposed
 * client-side.
 *
 * Needs a real Gemini API key - free tier exists but the exact numeric
 * rate limits aren't published without signing in to a real Google
 * account (checked 2026-09-25), which this session can't do for you.
 * Get one at https://aistudio.google.com/apikey and set GEMINI_API_KEY.
 *
 * Usage:
 *   GEMINI_API_KEY=... npx tsx scripts/generate-narration.ts <rpcUrl> <covenantAddress> <fromBlock>
 */
import { ethers } from "ethers";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ABI, fetchDecisionEvents, joinDecisions, bossFor, tokenName, type Decision } from "../status-page/lib.mjs";

const GEMINI_MODEL = "gemini-2.5-flash"; // cheap/fast tier; free-tier-eligible per ai.google.dev's own model list
const GEMINI_URL = (key: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`;

function fmt(wei: bigint): string {
  return ethers.formatUnits(wei, 18);
}

/** One sportscaster-style prompt per decision, grounded only in real on-chain fields - nothing invented for the model to embellish beyond phrasing. */
export function buildPrompt(d: Decision): string | null {
  const c = d.commit;
  if (!c) return null;
  const name = tokenName(c.token);
  const verb = c.side === "buy" ? "buy" : "sell";
  const amount = fmt(c.amountIn);

  if (!c.allowed) {
    const boss = bossFor(c.reason);
    return (
      `Write one excited sportscaster sentence (under 30 words) narrating a trading bot's ${verb} order for ` +
      `$${amount} of ${name} getting DENIED by an on-chain rule called "${boss?.name ?? c.reason}" (technical reason: ${c.reason}). ` +
      `The denial is the good outcome - a safety mandate held. Real enthusiasm, no hedging, no disclaimers, just the call.`
    );
  }
  if (d.settle) {
    return (
      `Write one excited sportscaster sentence (under 30 words) narrating a trading bot's ${verb} order for ` +
      `$${amount} of ${name} getting approved and filled via ${d.settle.executionMode}` +
      `${d.settle.belowMin ? ", though the fill landed just below the minimum accepted" : ""}. Real enthusiasm, no disclaimers.`
    );
  }
  return `Write one excited sportscaster sentence (under 30 words) narrating a trading bot's ${verb} order for $${amount} of ${name} getting approved and waiting to settle. Real enthusiasm, no disclaimers.`;
}

async function narrate(apiKey: string, prompt: string): Promise<string> {
  const res = await fetch(GEMINI_URL(apiKey), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`Gemini API error: HTTP ${res.status} ${JSON.stringify(body)}`);
  const text = body?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (typeof text !== "string" || text.length === 0) throw new Error(`Gemini returned no text: ${JSON.stringify(body)}`);
  return text.trim();
}

async function main() {
  try {
    process.loadEnvFile();
  } catch {
    // no .env - real environment variables only
  }
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("Set GEMINI_API_KEY - get a free one at https://aistudio.google.com/apikey");

  const [rpcUrl, covenantAddress, fromBlockArg] = process.argv.slice(2);
  if (!rpcUrl || !covenantAddress || !fromBlockArg) {
    throw new Error("Usage: generate-narration.ts <rpcUrl> <covenantAddress> <fromBlock>");
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const covenant = new ethers.Contract(covenantAddress, ABI, provider);
  const events = await fetchDecisionEvents(covenant, { fromBlock: Number(fromBlockArg) });
  const decisions = joinDecisions(events);

  const narration: Record<string, string> = {};
  for (const d of decisions) {
    const prompt = buildPrompt(d);
    if (!prompt) continue;
    console.log(`Narrating decision #${d.id}...`);
    narration[d.id] = await narrate(apiKey, prompt);
    console.log(`  "${narration[d.id]}"`);
  }

  const outPath = fileURLToPath(new URL("../frontend/src/data/narration.json", import.meta.url));
  writeFileSync(outPath, JSON.stringify(narration, null, 2) + "\n");
  console.log(`\nWrote ${Object.keys(narration).length} narration lines to frontend/src/data/narration.json`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
