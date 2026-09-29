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
  return new ethers.FallbackProvider(
    DEFAULT_BSC_RPCS.map((url) => new ethers.JsonRpcProvider(url, network, { staticNetwork: network })),
    network,
    { quorum: 1 },
  );
}
