// Upgrades a deployed Fiasco contract in place, keeping every balance, round and stat.
//
//   node scripts/upgrade-contract.mjs [contractAccountId] [wasmPath]
//
// Deploys the new code and calls `migrate` in one transaction, so if the migration
// fails nothing changes. Signs as the contract account using NEAR_RELAYER_PRIVATE_KEY
// from .env.local (deploy-contract.mjs creates the contract account with that key).
import fs from "node:fs";
import path from "node:path";
import { connect, keyStores, KeyPair, transactions } from "near-api-js";

const env = Object.fromEntries(
  fs
    .readFileSync(".env.local", "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);

const contractId = process.argv[2] || env.NEAR_CONTRACT_ID;
const wasmPath =
  process.argv[3] ||
  path.join("contracts", "fiasco-market", "target", "wasm32-unknown-unknown", "release", "fiasco_market.wasm");
if (!contractId || !env.NEAR_RELAYER_PRIVATE_KEY) {
  console.error("Need a contract id and NEAR_RELAYER_PRIVATE_KEY in .env.local");
  process.exit(1);
}

const keyStore = new keyStores.InMemoryKeyStore();
await keyStore.setKey("testnet", contractId, KeyPair.fromString(env.NEAR_RELAYER_PRIVATE_KEY));
const near = await connect({
  networkId: "testnet",
  keyStore,
  nodeUrl: env.NEAR_TESTNET_RPC_URL || "https://test.rpc.fastnear.com",
});
const account = await near.account(contractId);

const before = await account.viewFunction({ contractId, methodName: "get_stats", args: {} });
console.log("before:", JSON.stringify(before));

const wasm = fs.readFileSync(wasmPath);
const outcome = await account.signAndSendTransaction({
  receiverId: contractId,
  actions: [
    transactions.deployContract(wasm),
    transactions.functionCall("migrate", {}, BigInt("100000000000000"), BigInt(0)),
  ],
});
console.log(`upgrade tx ${outcome.transaction_outcome.id}`);

const after = await account.viewFunction({ contractId, methodName: "get_stats", args: {} });
const meta = await account.viewFunction({ contractId, methodName: "ft_metadata", args: {} });
console.log("after: ", JSON.stringify(after));
console.log("token: ", meta.symbol, meta.name, `decimals ${meta.decimals}`);
if (JSON.stringify(before) !== JSON.stringify(after)) {
  console.error("Stats changed during the upgrade. Check the contract.");
  process.exit(1);
}
