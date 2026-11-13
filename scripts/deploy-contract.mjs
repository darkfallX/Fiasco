// Deploys the Fiasco market contract to NEAR testnet.
//
//   node scripts/deploy-contract.mjs [contractAccountId] [wasmPath]
//
// Reads NEAR_RELAYER_ACCOUNT_ID and NEAR_RELAYER_PRIVATE_KEY from .env.local. The contract
// goes to a sub-account of the relayer (default fiasco.<relayer>), created and funded here
// if it does not exist yet. The relayer becomes the verifier, the only account allowed to
// write to the ledger. Afterwards set NEAR_CONTRACT_ID in .env.local to the printed id.
import fs from "node:fs";
import path from "node:path";
import { connect, keyStores, KeyPair, utils } from "near-api-js";

const env = Object.fromEntries(
  fs
    .readFileSync(".env.local", "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);

const relayer = env.NEAR_RELAYER_ACCOUNT_ID;
const secret = env.NEAR_RELAYER_PRIVATE_KEY;
if (!relayer || !secret) {
  console.error("Set NEAR_RELAYER_ACCOUNT_ID and NEAR_RELAYER_PRIVATE_KEY in .env.local first.");
  process.exit(1);
}

const contractId = process.argv[2] || `fiasco.${relayer}`;
const wasmPath =
  process.argv[3] ||
  path.join("contracts", "fiasco-market", "target", "wasm32-unknown-unknown", "release", "fiasco_market.wasm");
const wasm = fs.readFileSync(wasmPath);

const keyPair = KeyPair.fromString(secret);
const keyStore = new keyStores.InMemoryKeyStore();
await keyStore.setKey("testnet", relayer, keyPair);
await keyStore.setKey("testnet", contractId, keyPair);
const near = await connect({
  networkId: "testnet",
  keyStore,
  nodeUrl: env.NEAR_TESTNET_RPC_URL || "https://test.rpc.fastnear.com",
});

const relayerAccount = await near.account(relayer);
const contractAccount = await near.account(contractId);

let exists = true;
try {
  await contractAccount.state();
} catch {
  exists = false;
}
if (!exists) {
  console.log(`Creating ${contractId} with 6 NEAR for storage`);
  await relayerAccount.createAccount(contractId, keyPair.getPublicKey(), utils.format.parseNearAmount("6"));
}

console.log(`Deploying ${wasm.length} bytes to ${contractId}`);
const deployed = await contractAccount.deployContract(wasm);
console.log(`Deploy tx ${deployed.transaction_outcome.id}`);

try {
  const init = await contractAccount.functionCall({
    contractId,
    methodName: "new",
    args: { verifier: relayer },
    gas: BigInt("30000000000000"),
  });
  console.log(`Init tx ${init.transaction_outcome.id}`);
} catch (err) {
  console.log(`Init skipped: ${String(err?.message || err).slice(0, 120)}`);
}

const stats = await relayerAccount.viewFunction({ contractId, methodName: "get_stats", args: {} });
console.log("Ledger stats:", JSON.stringify(stats));
console.log(`\nNEAR_CONTRACT_ID=${contractId}`);
