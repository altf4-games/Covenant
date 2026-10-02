import { readFileSync } from "node:fs";

const RECORD = new URL("../../docs/evidence/covenant-mainnet.json", import.meta.url).pathname;

export interface RecordedDeployment {
  covenant: string;
  deployBlock: number;
}

/**
 * The mainnet deployment this repo documents (docs/evidence/covenant-mainnet.json,
 * committed), so `npm run judge` and `npm run verify` work with no setup for
 * anyone who clones the repo. COVENANT_ADDRESS and VERIFY_FROM_BLOCK still win,
 * for pointing the same scripts at a different deployment.
 */
export function recordedDeployment(): RecordedDeployment | null {
  try {
    const d = JSON.parse(readFileSync(RECORD, "utf8"));
    if (typeof d.covenant === "string" && Number.isInteger(d.deployBlock)) return { covenant: d.covenant, deployBlock: d.deployBlock };
  } catch {
    // no record in this checkout
  }
  return null;
}
