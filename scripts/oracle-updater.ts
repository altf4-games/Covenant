/**
 * Pushes a token's live market status and price into Covenant's on-chain
 * oracle, signed by the oracle-updater key (never the owner's or the
 * agent's: the contract rejects role overlap).
 *
 * Status comes from Binance's public RWA asset-market-status endpoint;
 * price from the RWA dynamic endpoint's `tokenInfo.price`, the token's own
 * on-chain price (bStocks' independent reference price is null, see
 * friction-log.md B6). Fail-closed: if either read fails, nothing is
 * posted, the oracle ages past its staleness bound, and every commit is
 * denied `OracleStale`. A missing price is never guessed.
 *
 * Feature 1 adds two fields: whether the NYSE regular session is open,
 * from scripts/lib/nyse-calendar.ts (Binance's status endpoint says
 * "TRADING" for bStocks around the clock, friction-log.md C18), and the
 * token's price at the last NYSE close, from the hourly candle ending
 * exactly then on Binance's K-line endpoint.
 *
 * Uses a raw ethers.Wallet, not hardhat-ethers's wrapped signer, for the
 * same reason as scripts/deploy.ts (friction-log.md C16).
 *
 * Red-team H10 fix: before trusting a price for `token`, confirm that exact
 * address is genuinely listed on Binance's authenticated, HMAC-signed
 * Market API (scripts/lib/web3-api-client.ts) - the part of the "Binance
 * Web3 API stack" requirement this project otherwise never touched (every
 * other call here goes to public, unauthenticated `bapi` endpoints). Same
 * fail-closed philosophy as the rest of this function: if the signed API
 * can't confirm the listing, nothing is posted.
 *
 * Usage:
 *   npx tsx scripts/oracle-updater.ts
 * Env: ORACLE_UPDATER_PRIVATE_KEY, COVENANT_ADDRESS, WEB3_API_KEY, WEB3_API_SECRET,
 *      optional BSC_RPC_URL, ORACLE_TOKEN_ADDRESS (default real NVDAB),
 *      ORACLE_BINANCE_CHAIN_ID (default 56), ORACLE_PLATFORM_ID (default "bstock").
 */
import { ethers } from "ethers";
import covenantArtifact from "../artifacts/contracts/Covenant.sol/Covenant.json" with { type: "json" };
import { fetchAssetMarketStatus, isHalted, priceToUsdE18, fetchHourlyKlines, closePriceAt, type AssetMarketStatus } from "./lib/rwa-status.js";
import { isRegularSessionOpen, lastRegularClose } from "./lib/nyse-calendar.js";
import { fetchDynamic } from "../skills/covenant-mandate/scripts/cli.mjs";
import { loadWeb3ApiCredentials, verifyTokenListed, type RwaTokenListing } from "./lib/web3-api-client.js";

const DEFAULT_CHAIN_ID = 56;
const DEFAULT_TOKEN = "0x02fca66c1d1afb4e2a7884261eb00f63598a7436"; // real NVDAB, verified-facts.md

export interface LiveOracleReading {
  status: AssetMarketStatus;
  halted: boolean;
  rawPrice: string;
  priceUsd: bigint;
  sessionOpen: boolean;
  lastCloseAt: Date;
  rawLastClose: string;
  lastCloseUsd: bigint;
  /** Red-team H10: the authenticated listing that confirmed this address. */
  authenticatedListing: RwaTokenListing;
}

/**
 * Reads every live source. Throws rather than returning a partial reading.
 * `platformId` selects which authenticated listing to check `token`
 * against - see red-team H10 in the file doc comment above.
 */
export async function readLiveOracle(
  chainId: number,
  token: string,
  now: Date = new Date(),
  platformId: string = "bstock",
): Promise<LiveOracleReading> {
  const creds = loadWeb3ApiCredentials();
  if (!creds) {
    throw new Error(
      "WEB3_API_KEY / WEB3_API_SECRET not set - required so every oracle push is cross-checked against Binance's " +
        "authenticated Market API, not just the public bapi endpoints (red-team H10).",
    );
  }
  const [status, dynamic, klines, authenticatedListing] = await Promise.all([
    fetchAssetMarketStatus(chainId, token),
    fetchDynamic(chainId, token),
    fetchHourlyKlines(chainId, token),
    verifyTokenListed(creds, platformId, chainId, token),
  ]);
  if (!authenticatedListing) {
    throw new Error(
      `${token} on chain ${chainId} is not listed under platformId="${platformId}" on Binance's authenticated ` +
        `Market API - refusing to post a price for an address that API won't confirm.`,
    );
  }
  const rawPrice = dynamic?.tokenInfo?.price;
  if (typeof rawPrice !== "string" && typeof rawPrice !== "number") {
    throw new Error(`no live price for ${token} on chain ${chainId} - refusing to post a guess`);
  }
  const priceUsd = priceToUsdE18(String(rawPrice));
  if (priceUsd === 0n) throw new Error(`live price for ${token} is zero - refusing to post it`);

  const lastCloseAt = lastRegularClose(now);
  const rawLastClose = closePriceAt(klines, lastCloseAt);
  const lastCloseUsd = priceToUsdE18(rawLastClose);
  if (lastCloseUsd === 0n) throw new Error(`last-close price for ${token} is zero - refusing to post it`);

  return {
    status,
    halted: isHalted(status),
    rawPrice: String(rawPrice),
    priceUsd,
    sessionOpen: isRegularSessionOpen(now),
    lastCloseAt,
    rawLastClose,
    lastCloseUsd,
    authenticatedListing,
  };
}

/** Posts a reading and confirms it by reading the contract back. */
export async function pushOracleUpdate(opts: {
  signer: ethers.Signer;
  covenantAddress: string;
  token: string;
  reading: Pick<LiveOracleReading, "halted" | "priceUsd" | "sessionOpen" | "lastCloseUsd">;
}) {
  const covenant = new ethers.Contract(opts.covenantAddress, covenantArtifact.abi, opts.signer);
  const r = opts.reading;
  const tx = await covenant.updateOracle(opts.token, r.halted, r.priceUsd, r.sessionOpen, r.lastCloseUsd);
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) throw new Error(`updateOracle reverted (tx ${tx.hash})`);

  const onChain = await covenant.oracleStatus(opts.token);
  if (
    onChain.halted !== r.halted ||
    onChain.priceUsd !== r.priceUsd ||
    onChain.sessionOpen !== r.sessionOpen ||
    onChain.lastCloseUsd !== r.lastCloseUsd
  ) {
    throw new Error("on-chain oracle state doesn't match what was just submitted");
  }
  return {
    txHash: receipt.hash as string,
    halted: onChain.halted as boolean,
    priceUsd: onChain.priceUsd as bigint,
    sessionOpen: onChain.sessionOpen as boolean,
    lastCloseUsd: onChain.lastCloseUsd as bigint,
    updatedAt: onChain.updatedAt as bigint,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    try {
      process.loadEnvFile();
    } catch {
      // no .env - real environment variables only
    }
    const privateKey = process.env.ORACLE_UPDATER_PRIVATE_KEY;
    const covenantAddress = process.env.COVENANT_ADDRESS;
    if (!privateKey || !covenantAddress) throw new Error("Set ORACLE_UPDATER_PRIVATE_KEY and COVENANT_ADDRESS.");
    // `||`, not `??`: .env.example ships these present but blank.
    const token = process.env.ORACLE_TOKEN_ADDRESS || DEFAULT_TOKEN;
    const chainId = Number(process.env.ORACLE_BINANCE_CHAIN_ID || DEFAULT_CHAIN_ID);
    const platformId = process.env.ORACLE_PLATFORM_ID || "bstock";
    const rpcUrl = process.env.BSC_RPC_URL || "https://bsc-mainnet.public.blastapi.io";

    const reading = await readLiveOracle(chainId, token, new Date(), platformId);
    console.log(`live: openState=${reading.status.openState} reasonCode=${reading.status.reasonCode} -> halted=${reading.halted}, price=${reading.rawPrice}`);
    console.log(`NYSE session open: ${reading.sessionOpen}; last close ${reading.lastCloseAt.toISOString()} at ${reading.rawLastClose}`);
    console.log(
      `authenticated Market API confirms ${reading.authenticatedListing.tokenSymbol} (platformId=${reading.authenticatedListing.platformId}, chain ${reading.authenticatedListing.binanceChainId}) - red-team H10`,
    );

    const signer = new ethers.Wallet(privateKey, new ethers.JsonRpcProvider(rpcUrl));
    const result = await pushOracleUpdate({ signer, covenantAddress, token, reading });
    console.log(`posted in ${result.txHash}; on chain now halted=${result.halted} priceUsd=${ethers.formatUnits(result.priceUsd, 18)}`);
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
