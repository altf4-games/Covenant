import { network } from "hardhat";

const NVDAB_ADDRESS = "0x02fca66c1d1afb4e2a7884261eb00f63598a7436";
const ERC20_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
];

async function main() {
  const { ethers } = await network.connect("bscFork");
  const nvdab = new ethers.Contract(NVDAB_ADDRESS, ERC20_ABI, ethers.provider);

  const [name, symbol, decimals, blockNumber] = await Promise.all([
    nvdab.name(),
    nvdab.symbol(),
    nvdab.decimals(),
    ethers.provider.getBlockNumber(),
  ]);

  console.log(`Fork block: ${blockNumber}`);
  console.log(`NVDAB name(): ${name}`);
  console.log(`NVDAB symbol(): ${symbol}`);
  console.log(`NVDAB decimals(): ${decimals}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
