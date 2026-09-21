import hardhatToolboxMochaEthersPlugin from "@nomicfoundation/hardhat-toolbox-mocha-ethers";
import { defineConfig } from "hardhat/config";

// bsc-dataseed.binance.org and bsc.publicnode.com both refuse historical state
// (missing trie node / archive-token-required) once Hardhat pins a fork block a
// few seconds behind their tip - neither is an archive node on the free tier.
// blastapi's public BSC endpoint does serve state at least 50 blocks back, which
// is what forking actually needs. Logged in docs/partner-feedback/friction-log.md.
const BSC_RPC_URL =
  process.env.BSC_RPC_URL ?? "https://bsc-mainnet.public.blastapi.io";

export default defineConfig({
  plugins: [hardhatToolboxMochaEthersPlugin],
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
      },
      production: {
        version: "0.8.34",
        settings: {
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
  },
});
