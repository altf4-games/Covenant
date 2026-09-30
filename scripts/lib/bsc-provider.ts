import { ethers } from "ethers";
import { DEFAULT_BSC_RPCS } from "../../skills/covenant-mandate/scripts/cli.mjs";

/**
 * The provider every mainnet script uses. An explicit `BSC_RPC_URL` is used as
 * given (someone who set it chose it). Otherwise it's several free endpoints
 * behind ethers' FallbackProvider with a quorum of one: a read goes to the
 * first that answers and a transaction is broadcast to all of them, so one
 * endpoint rate-limiting or going down doesn't stop the unattended oracle
 * updater (which, if it misses updates, leaves every commit denied
 * OracleStale). The old default was a single endpoint that rate-limited within
 * minutes of ordinary use.
 */
export function bscProvider(explicitUrl?: string): ethers.Provider {
  const network = ethers.Network.from(56);
  if (explicitUrl) return new ethers.JsonRpcProvider(explicitUrl, network, { staticNetwork: network });
  return new LowestGasFallbackProvider(
    DEFAULT_BSC_RPCS.map((url) => new ethers.JsonRpcProvider(url, network, { staticNetwork: network })),
    network,
  );
}

/**
 * A FallbackProvider whose fee data uses the lowest gas price any endpoint
 * quotes. Probed 2026-09-30: 48Club reports 1 gwei while bloXroute and
 * publicnode report 0.05 (the price that median BSC transactions actually pay),
 * so a transaction priced by whichever endpoint answered first could cost 20
 * times more and drain the small wallets these scripts run from.
 */
export class LowestGasFallbackProvider extends ethers.FallbackProvider {
  private readonly members: ethers.JsonRpcProvider[];
  constructor(members: ethers.JsonRpcProvider[], network: ethers.Network) {
    super(members, network, { quorum: 1 });
    this.members = members;
  }
  /**
   * Ask each endpoint in turn and return the first receipt found; an endpoint
   * that errors (publicnode answers a lookup for a just-sent transaction with
   * a 403 "archive request", not null) is skipped. Only if every endpoint
   * errors does this throw. The stock FallbackProvider surfaced that 403 and
   * crashed the first mainnet deploy and the first oracle update right after
   * their transactions had already mined.
   */
  override async getTransactionReceipt(hash: string): Promise<ethers.TransactionReceipt | null> {
    let lastError: unknown;
    let answered = false;
    for (const m of this.members) {
      try {
        const receipt = await m.getTransactionReceipt(hash);
        if (receipt) return receipt;
        answered = true;
      } catch (error) {
        lastError = error;
      }
    }
    if (!answered && lastError) throw lastError;
    return null;
  }

  override async getFeeData(): Promise<ethers.FeeData> {
    const quotes = await Promise.allSettled(this.members.map((m) => m.getFeeData()));
    const prices = quotes.flatMap((q) => (q.status === "fulfilled" && q.value.gasPrice ? [q.value.gasPrice] : []));
    if (prices.length === 0) return super.getFeeData();
    return new ethers.FeeData(prices.reduce((a, b) => (b < a ? b : a)), null, null);
  }
}
