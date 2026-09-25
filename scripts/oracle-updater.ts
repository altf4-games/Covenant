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
 * Usage:
 *   npx tsx scripts/oracle-updater.ts
 * Env: ORACLE_UPDATER_PRIVATE_KEY, COVENANT_ADDRESS, optional BSC_RPC_URL,
 *      ORACLE_TOKEN_ADDRESS (default real NVDAB), ORACLE_BINANCE_CHAIN_ID (default 56).
 */
import { ethers } from "ethers";
import covenantArtifact from "../artifacts/contracts/Covenant.sol/Covenant.json" with { type: "json" };
import { fetchAssetMarketStatus, isHalted, priceToUsdE18, fetchHourlyKlines, closePriceAt, type AssetMarketStatus } from "./lib/rwa-status.js";
import { isRegularSessionOpen, lastRegularClose } from "./lib/nyse-calendar.js";
import { fetchDynamic } from "../skills/covenant-mandate/scripts/cli.mjs";

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
}

/** Reads every live source. Throws rather than returning a partial reading. */
export async function readLiveOracle(chainId: number, token: string, now: Date = new Date()): Promise<LiveOracleReading> {
  const [status, dynamic, klines] = await Promise.all([
    fetchAssetMarketStatus(chainId, token),
    fetchDynamic(chainId, token),
    fetchHourlyKlines(chainId, token),
  ]);
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
    const rpcUrl = process.env.BSC_RPC_URL || "https://bsc-mainnet.public.blastapi.io";

    const reading = await readLiveOracle(chainId, token);
    console.log(`live: openState=${reading.status.openState} reasonCode=${reading.status.reasonCode} -> halted=${reading.halted}, price=${reading.rawPrice}`);
    console.log(`NYSE session open: ${reading.sessionOpen}; last close ${reading.lastCloseAt.toISOString()} at ${reading.rawLastClose}`);

    const signer = new ethers.Wallet(privateKey, new ethers.JsonRpcProvider(rpcUrl));
    const result = await pushOracleUpdate({ signer, covenantAddress, token, reading });
    console.log(`posted in ${result.txHash}; on chain now halted=${result.halted} priceUsd=${ethers.formatUnits(result.priceUsd, 18)}`);
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
