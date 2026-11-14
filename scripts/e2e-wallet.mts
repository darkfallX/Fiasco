// End-to-end check of self-signed play against a running game server and testnet.
//
//   npx tsx scripts/e2e-wallet.mts [baseUrl]
//
// Creates (once) a testnet player account under the relayer, gives it a key that may only
// call the game's player methods (what MyNearWallet does at login), then plays a round
// through the HTTP API exactly as the browser does: link, signed bet, run to settlement,
// cash out to the wallet as CHIP, buy back in. Also checks that tampered and forged
// signatures are refused. Needs .env.local with the relayer and contract.
import fs from "node:fs";
import { connect, keyStores, KeyPair, utils } from "near-api-js";
import type { KeyPairString } from "@near-js/crypto";
import { PLAYER_METHODS, signLinkProof, signPlayerAction } from "../src/lib/near/delegate";
import { quoteBuyByCredits } from "../src/lib/market/lmsr";
import type { ArenaState } from "../src/lib/types";

const base = process.argv[2] || "http://localhost:3000";
const env = Object.fromEntries(
  fs
    .readFileSync(".env.local", "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
const relayerId = env.NEAR_RELAYER_ACCOUNT_ID;
const contractId = env.NEAR_CONTRACT_ID;
const relayerKey = KeyPair.fromString(env.NEAR_RELAYER_PRIVATE_KEY as KeyPairString);
const playerId = `player1.${relayerId}`;

let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}`);
  if (!ok) failures++;
};

const ks = new keyStores.InMemoryKeyStore();
await ks.setKey("testnet", relayerId, relayerKey);
await ks.setKey("testnet", playerId, relayerKey);
const near = await connect({ networkId: "testnet", keyStore: ks, nodeUrl: env.NEAR_TESTNET_RPC_URL || "https://test.rpc.fastnear.com" });
const relayer = await near.account(relayerId);
const player = await near.account(playerId);
const view = <T>(methodName: string, args: Record<string, unknown>) =>
  relayer.viewFunction({ contractId, methodName, args }) as Promise<T>;

let exists = true;
try {
  await player.state();
} catch {
  exists = false;
}
if (!exists) {
  await relayer.createAccount(playerId, relayerKey.getPublicKey(), BigInt(utils.format.parseNearAmount("0.3") as string));
  console.log("created", playerId);
}

// What MyNearWallet does at login: add a function-call key for the game's player methods.
const browserKey = KeyPair.fromRandom("ed25519");
await player.addKey(browserKey.getPublicKey(), contractId, [...PLAYER_METHODS], BigInt(utils.format.parseNearAmount("0.25") as string));
const secretKey = browserKey.toString();
const publicKey = browserKey.getPublicKey().toString();

let cookie = "";
async function api(path: string, body?: unknown): Promise<{ status: number; data: Record<string, unknown> }> {
  const res = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const set = res.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0];
  return { status: res.status, data: (await res.json()) as Record<string, unknown> };
}
const arenaOf = (d: Record<string, unknown>) => d.arena as ArenaState;

let nonce = BigInt(0);
async function sign(methodName: (typeof PLAYER_METHODS)[number], args: Record<string, unknown>, key = secretKey) {
  const k = await api("/api/wallet/key");
  const chainNonce = BigInt(k.data.nonce as string);
  nonce = (chainNonce > nonce ? chainNonce : nonce) + BigInt(1);
  return signPlayerAction({ secretKey: key, senderId: playerId, receiverId: contractId, methodName, args, nonce, blockHeight: k.data.blockHeight as number });
}
async function settleQueue() {
  for (let i = 0; i < 60; i++) {
    const l = await api("/api/near/relayer");
    if ((l.data.pendingOps as number) === 0) return l.data;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error("ledger queue did not drain");
}

await api("/api/arena/state");
const issuedAt = Date.now();
const linked = await api("/api/wallet/link", { accountId: playerId, publicKey, issuedAt, signature: signLinkProof(secretKey, playerId, issuedAt) });
let arena = arenaOf(linked.data);
check(linked.status === 200 && arena.chain.wallet?.accountId === playerId, `link ${playerId}`);
const forgedLink = await api("/api/wallet/link", {
  accountId: playerId,
  publicKey,
  issuedAt,
  signature: signLinkProof(KeyPair.fromRandom("ed25519").toString(), playerId, issuedAt),
});
check(forgedLink.status === 400, `link with a forged proof refused (${forgedLink.data.error})`);

const startCredits = arena.userCredits;
const market = arena.markets.pivot;
const amount = 100;
const q = quoteBuyByCredits(market, "YES", amount);
const args = { round_id: arena.roundId, agent: "pivot", yes: true, shares_e4: Math.round(q.shares * 10000), cents: amount * 100 };

const tampered = await sign("place_bet", args);
tampered.args = { ...tampered.args, cents: 1 };
const t1 = await api("/api/arena/trade", { agentId: "pivot", action: "BUY", side: "YES", amount, meta: tampered });
check(t1.status === 400, `tampered bet refused (${t1.data.error})`);

const otherKey = await sign("place_bet", args, KeyPair.fromRandom("ed25519").toString());
const t2 = await api("/api/arena/trade", { agentId: "pivot", action: "BUY", side: "YES", amount, meta: otherKey });
check(t2.status === 400, `bet signed with a stranger's key refused (${t2.data.error})`);

const unsigned = await api("/api/arena/trade", { agentId: "pivot", action: "BUY", side: "YES", amount });
check(unsigned.status === 400, `unsigned bet refused (${unsigned.data.error})`);

const good = await sign("place_bet", args);
const t3 = await api("/api/arena/trade", { agentId: "pivot", action: "BUY", side: "YES", amount, meta: good });
check(t3.status === 200, "signed bet accepted");

for (let i = 0; i < 4; i++) {
  const s = await api("/api/arena/step", { mode: "phase" });
  arena = arenaOf(s.data);
  if (arena.phase === "SETTLED") break;
}
check(arena.phase === "SETTLED", `round settled (pivot ${arena.agents.pivot.status})`);
const ledger = await settleQueue();
check((ledger.rejectedOps as number) === 0, `all ${ledger.confirmedOps} writes confirmed, none rejected`);
const receipts = arena.evidence.nearContractSpec.receipts.map((r) => r.method);
const after = (await api("/api/arena/state")).data;
arena = arenaOf(after);
const signedReceipt = arena.evidence.nearContractSpec.receipts.find((r) => r.method.includes("signed by"));
check(Boolean(signedReceipt), `bet relayed as a meta transaction: ${signedReceipt?.explorerUrl ?? receipts.join(" | ")}`);

const onChain = await view<{ balance_cents: number } | null>("get_player", { player: playerId });
check(onChain !== null && onChain.balance_cents === Math.round(arena.userCredits * 100), `table balance on-chain ${onChain?.balance_cents} = game ${Math.round(arena.userCredits * 100)} (started ${Math.round(startCredits * 100)})`);
const pos = await view<{ yes_e4: number }>("get_position", { round_id: args.round_id, agent: "pivot", player: playerId });
check(pos.yes_e4 === args.shares_e4, `position held by ${playerId}: ${pos.yes_e4} = ${args.shares_e4}`);

const walletBefore = BigInt(await view<string>("ft_balance_of", { account_id: playerId }));
const out = await api("/api/wallet/move", { direction: "out", meta: await sign("cash_out", { cents: 25000 }) });
check(out.status === 200, "cash out 250.00 accepted");
await settleQueue();
const walletAfter = BigInt(await view<string>("ft_balance_of", { account_id: playerId }));
check(walletAfter - walletBefore === BigInt(25000), `wallet CHIP +250.00 (${walletBefore} -> ${walletAfter})`);
const back = await api("/api/wallet/move", { direction: "in", meta: await sign("buy_in", { cents: 10000 }) });
check(back.status === 200, "buy in 100.00 accepted");
await settleQueue();
const walletEnd = BigInt(await view<string>("ft_balance_of", { account_id: playerId }));
check(walletAfter - walletEnd === BigInt(10000), `wallet CHIP -100.00 (${walletAfter} -> ${walletEnd})`);
arena = arenaOf((await api("/api/arena/state")).data);
const tableEnd = await view<{ balance_cents: number }>("get_player", { player: playerId });
check(tableEnd.balance_cents === Math.round(arena.userCredits * 100), `table after moves on-chain ${tableEnd.balance_cents} = game ${Math.round(arena.userCredits * 100)}`);
const meta = await view<{ symbol: string }>("ft_metadata", {});
console.log(`CHIP supply ${await view<string>("ft_total_supply", {})}, symbol ${meta.symbol}`);

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures ? 1 : 0);
