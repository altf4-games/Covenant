import { ethers } from "ethers";
import covenantArtifact from "../artifacts/contracts/Covenant.sol/Covenant.json" with { type: "json" };

const RPC_URL = "http://127.0.0.1:8545";
const FUNDED_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const USDT = "0x55d398326f99059fF775485246999027B3197955";
const NVDAB = "0x02fca66c1d1afb4e2a7884261eb00f63598a7436";
const IMPERSONATOR = "0x2F701b108a9aF5558960325A0239D0a13c2C4444";
const PANCAKE_V3_SWAP_ROUTER = "0x1b81D678ffb9C0263b24A97847620C99d213eB14";
const USDT_WHALE = "0xF977814e90dA44bFA03b6295A0616a897441aceC";

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const signer = new ethers.Wallet(FUNDED_PRIVATE_KEY, provider);

  const factory = new ethers.ContractFactory(covenantArtifact.abi, covenantArtifact.bytecode, signer);
  const covenant = await factory.deploy(USDT, PANCAKE_V3_SWAP_ROUTER, signer.address, 900);
  await covenant.waitForDeployment();
  const addr = await covenant.getAddress();

  await (await (covenant as any).setAllowedToken(NVDAB, true)).wait();
  const latest = (await provider.getBlock("latest"))!.timestamp;
  await (await (covenant as any).setMandate(ethers.parseUnits("50", 18), 10n, latest + 30 * 24 * 60 * 60)).wait();
  await (await (covenant as any).updateOracle(NVDAB, false)).wait();

  // Real deny: impersonator not allowlisted.
  await (await (covenant as any).guardedSwap(IMPERSONATOR, 2500, 1n, 0n)).wait();

  // Real allow: fund via impersonating a real USDT whale, then a real swap.
  await provider.send("hardhat_impersonateAccount", [USDT_WHALE]);
  await provider.send("hardhat_setBalance", [USDT_WHALE, "0xDE0B6B3A7640000"]);
  const whale = new ethers.JsonRpcSigner(provider, USDT_WHALE);
  const usdtAbi = ["function transfer(address,uint256) returns (bool)", "function approve(address,uint256) returns (bool)"];
  const usdtAsWhale = new ethers.Contract(USDT, usdtAbi, whale);
  const amountIn = ethers.parseUnits("5", 18);
  await (await usdtAsWhale.transfer(signer.address, amountIn)).wait();
  await provider.send("hardhat_stopImpersonatingAccount", [USDT_WHALE]);

  const usdtAsSigner = new ethers.Contract(USDT, usdtAbi, signer);
  await (await usdtAsSigner.approve(addr, amountIn)).wait();
  await (await (covenant as any).guardedSwap(NVDAB, 2500, amountIn, 0n)).wait();

  // Another deny: notional exceeded.
  await (await (covenant as any).guardedSwap(NVDAB, 2500, ethers.parseUnits("999", 18), 0n)).wait();

  console.log("COVENANT_ADDRESS=" + addr);
  console.log(`status page URL: file://${new URL("../status-page/index.html", import.meta.url).pathname}?rpc=${encodeURIComponent(RPC_URL)}&contract=${addr}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
