import hardhatToolboxMochaEthersPlugin from "@nomicfoundation/hardhat-toolbox-mocha-ethers";
import { defineConfig } from "hardhat/config";

// Node 20.6+ ships this natively - no need for the `dotenv` package. Without
// it, nothing in .env ever reaches process.env: every script here (and any
// value read via process.env.* below) would silently see undefined instead
// of a real error pointing at a missing .env, which is exactly what almost
// happened running oracle-updater.ts against a freshly filled .env.
try {
  process.loadEnvFile();
} catch {
  // No .env file present - fine for CI or a machine that only sets real
  // environment variables directly.
}

// bsc-dataseed.binance.org and bsc.publicnode.com both refuse historical state
// (missing trie node / archive-token-required) once Hardhat pins a fork block a
// few seconds behind their tip - neither is an archive node on the free tier.
// blastapi's public BSC endpoint does serve state at least 50 blocks back, which
// is what forking actually needs. Logged in docs/partner-feedback/friction-log.md.
// `?? default` alone isn't enough here: a .env line like `BSC_RPC_URL=`
// (present, deliberately left blank, as .env.example ships it) sets
// process.env.BSC_RPC_URL to "" - not undefined - so `??` never falls back
// and Hardhat rejects the empty string as an invalid URL. Caught live
// running oracle-updater.ts against a freshly filled-in .env.
const BSC_RPC_URL = process.env.BSC_RPC_URL || "https://bsc-mainnet.public.blastapi.io";

export default defineConfig({
  plugins: [hardhatToolboxMochaEthersPlugin],
  // Etherscan API V2: one key covers BSC and 60+ other EVM chains now,
  // rather than a BscScan-specific key. hardhat-verify is bundled via the
  // toolbox above, so this is the only config needed - see
  // node_modules/@nomicfoundation/hardhat-verify/README.md.
  verify: {
    etherscan: {
      apiKey: process.env.ETHERSCAN_API_KEY || "",
    },
  },
  // EDR only ships built-in hardfork-activation history for Ethereum mainnet and
  // OP chains, not BSC (chain id 56) - without this it refuses to fork with
  // "no known hardfork for execution on historical block". BSC's Cancun-equivalent
  // upgrade (Pascal/Cancun) has been active since well before any block we'd fork
  // from, so a single activation at block 0 is sufficient here.
  chainDescriptors: {
    56: {
      name: "bnb-smart-chain",
      chainType: "l1",
      hardforkHistory: {
        cancun: { blockNumber: 0 },
      },
    },
  },
  solidity: {
    profiles: {
      default: {
        version: "0.8.34",
        // Red-team H11's enriched DecisionCommitted event pushed commit()
        // over the legacy codegen's stack depth (HHE910 "stack too deep").
        // viaIR is the standard Solidity fix for that - it changes only
        // compilation internals, not contract behavior - so it's on for
        // both profiles rather than routing around the error with fewer
        // event fields.
        settings: {
          viaIR: true,
        },
      },
      production: {
        version: "0.8.34",
        settings: {
          viaIR: true,
          evmVersion: "cancun",
          optimizer: {
            enabled: true,
            runs: 200,
          },
        },
      },
    },
  },
  networks: {
    hardhatMainnet: {
      type: "edr-simulated",
      chainType: "l1",
    },
    bscFork: {
      type: "edr-simulated",
      chainType: "l1",
      chainId: 56,
      hardfork: "cancun",
      forking: {
        url: BSC_RPC_URL,
      },
    },
    // A REAL, persistent node - `npx hardhat node --fork <url> --chain-id 56`
    // run separately - as opposed to `bscFork` above. `bscFork` is an
    // edr-simulated network: every `npx hardhat run ... --network bscFork`
    // spins up its own fresh, throwaway in-process chain and discards it
    // when the script exits. That's exactly right for tests (isolation), but
    // it means deploy.ts and oracle-updater.ts run as two separate `hardhat
    // run` commands against `--network bscFork` talk to two different,
    // unrelated chains - a deployed contract from one is simply gone by the
    // time the next command starts. `localhost` here is an http network
    // pointed at the actual standalone node process, so state persists
    // between separate script invocations the way a real deployment needs
    // to. `accounts` is omitted deliberately - it defaults to "remote",
    // which uses the node's own already-unlocked accounts rather than a
    // hardcoded private key.
    localhost: {
      type: "http",
      chainType: "l1",
      url: "http://127.0.0.1:8545",
      chainId: 56,
    },
    // The real thing - Phase 3. Not used until then; scaffolded now so
    // deploy day is a config fill-in (BSC_RPC_URL + DEPLOYER_PRIVATE_KEY in
    // .env, both gitignored) rather than editing this file under time
    // pressure with real funds already in the wallet. `accounts` is deliberately
    // an empty array by default - Hardhat refuses to sign for this network
    // until a real key is supplied, rather than silently falling back to
    // something unsafe.
    bsc: {
      type: "http",
      chainType: "l1",
      url: BSC_RPC_URL,
      chainId: 56,
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
    },
  },
});
