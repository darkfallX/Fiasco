import { KeyPair, keyStores, connect, providers } from "near-api-js";
import type { Account } from "near-api-js";
import type { KeyPairString } from "@near-js/crypto";
import { OnChainReceipt, RoundSeed } from "../types";
import { DelegatePayload, signedDelegateAction } from "./delegate";

export const DEFAULT_RPC_URL = "https://test.rpc.fastnear.com";

export type RelayerSession = {
  accountId: string;
  publicKey: string;
  secretKey: KeyPairString;
  contractDeployed: boolean;
  contractId: string;
};

/** One write to the on-chain ledger. Field names match the contract's `Op`. */
export type LedgerOp = {
  kind: "publish" | "lock" | "bet" | "sell" | "settle" | "void" | "rebuy";
  round_id: string;
  player: string;
  agent: string;
  yes: boolean;
  shares_e4: number;
  cents: number;
  a: string;
  b: string;
  n: number;
  winners: string[];
};

export function ledgerOp(partial: Partial<LedgerOp> & Pick<LedgerOp, "kind">): LedgerOp {
  return {
    round_id: "",
    player: "",
    agent: "",
    yes: false,
    shares_e4: 0,
    cents: 0,
    a: "",
    b: "",
    n: 0,
    winners: [],
    ...partial,
  };
}

const globalNear = globalThis as unknown as {
  __fiascoRelayer?: RelayerSession | null;
  __fiascoAccount?: Promise<Account>;
};

function rpcUrl(): string {
  return process.env.NEAR_TESTNET_RPC_URL || DEFAULT_RPC_URL;
}

/**
 * The relayer is configured only through server environment variables. Nothing a
 * visitor sends can change which account signs.
 */
export function getActiveRelayer(): RelayerSession | null {
  if (globalNear.__fiascoRelayer !== undefined) return globalNear.__fiascoRelayer;
  const accountId = process.env.NEAR_RELAYER_ACCOUNT_ID;
  const secretKey = process.env.NEAR_RELAYER_PRIVATE_KEY as KeyPairString | undefined;
  const contractId = process.env.NEAR_CONTRACT_ID;
  if (!accountId || !secretKey) {
    globalNear.__fiascoRelayer = null;
    return null;
  }
  try {
    const kp = KeyPair.fromString(secretKey);
    globalNear.__fiascoRelayer = {
      accountId,
      publicKey: kp.getPublicKey().toString(),
      secretKey,
      contractDeployed: Boolean(contractId),
      contractId: contractId || accountId,
    };
  } catch {
    globalNear.__fiascoRelayer = null;
  }
  return globalNear.__fiascoRelayer;
}

export function chainEnabled(): boolean {
  const relayer = getActiveRelayer();
  return Boolean(relayer && relayer.contractDeployed);
}

async function getRelayerAccount(): Promise<Account> {
  const relayer = getActiveRelayer();
  if (!relayer) throw new Error("No relayer configured");
  if (!globalNear.__fiascoAccount) {
    globalNear.__fiascoAccount = (async () => {
      const keyStore = new keyStores.InMemoryKeyStore();
      await keyStore.setKey("testnet", relayer.accountId, KeyPair.fromString(relayer.secretKey));
      const near = await connect({ networkId: "testnet", keyStore, nodeUrl: rpcUrl() });
      return near.account(relayer.accountId);
    })();
  }
  return globalNear.__fiascoAccount;
}

/** Sends one batch of ledger ops in a single transaction. */
export async function sendLedgerBatch(
  ops: LedgerOp[]
): Promise<{ receipt: OnChainReceipt; results: string[] }> {
  const relayer = getActiveRelayer();
  if (!relayer || !relayer.contractDeployed) throw new Error("Chain ledger not configured");
  const account = await getRelayerAccount();
  const outcome = await account.functionCall({
    contractId: relayer.contractId,
    methodName: "apply",
    args: { ops },
    gas: BigInt("300000000000000"),
  });
  const txHash = outcome.transaction_outcome.id;
  const raw = providers.getTransactionLastResult(outcome) as unknown;
  const results = Array.isArray(raw) ? (raw as string[]) : [];
  const rejected = results.filter((r) => r !== "ok");
  const kinds = ops.map((o) => o.kind);
  const summary = [...new Set(kinds)]
    .map((k) => `${kinds.filter((x) => x === k).length} ${k}`)
    .join(", ");
  return {
    results,
    receipt: {
      id: `tx-${txHash.slice(0, 10)}`,
      method: summary,
      note: rejected.length ? rejected.join("; ") : undefined,
      txHash,
      signerId: relayer.accountId,
      contractId: relayer.contractId,
      timestamp: new Date().toISOString(),
      explorerUrl: `https://testnet.nearblocks.io/txns/${txHash}`,
    },
  };
}

/**
 * Relays one player-signed action (NEP-366). The outer transaction is signed and paid
 * for by the relayer; the contract sees the player as the caller.
 */
export async function sendMetaTransaction(
  p: DelegatePayload
): Promise<{ ok: boolean; receipt: OnChainReceipt | null; error?: string }> {
  const relayer = getActiveRelayer();
  if (!relayer || !relayer.contractDeployed) return { ok: false, receipt: null, error: "Chain ledger not configured" };
  const receiptFor = (txHash: string, note?: string): OnChainReceipt => ({
    id: `tx-${txHash.slice(0, 10)}`,
    method: `${p.methodName.replace("place_", "")} signed by ${p.senderId}`,
    note,
    txHash,
    signerId: p.senderId,
    contractId: relayer.contractId,
    timestamp: new Date().toISOString(),
    explorerUrl: `https://testnet.nearblocks.io/txns/${txHash}`,
  });
  try {
    const account = await getRelayerAccount();
    const outcome = await account.signAndSendTransaction({
      receiverId: p.senderId,
      actions: [signedDelegateAction(p)],
    });
    return { ok: true, receipt: receiptFor(outcome.transaction_outcome.id) };
  } catch (err) {
    const e = err as { message?: string; transaction_outcome?: { id?: string } };
    const message = (e.message || "transaction failed").slice(0, 120);
    const hash = e.transaction_outcome?.id;
    return { ok: false, receipt: hash ? receiptFor(hash, message) : null, error: message };
  }
}

/** Nonce and current block for a player's wallet key, used to sign the next action. */
export async function viewAccessKey(
  accountId: string,
  publicKey: string
): Promise<{ nonce: string; blockHeight: number; receiverId: string | null; fullAccess: boolean } | null> {
  try {
    const res = await fetch(rpcUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "key",
        method: "query",
        params: { request_type: "view_access_key", finality: "final", account_id: accountId, public_key: publicKey },
      }),
      signal: AbortSignal.timeout(5000),
    });
    const json = (await res.json()) as {
      result?: {
        nonce?: number | string;
        block_height?: number;
        permission?: "FullAccess" | { FunctionCall?: { receiver_id?: string } };
      };
    };
    const r = json.result;
    if (!r || r.nonce === undefined || r.block_height === undefined) return null;
    const fullAccess = r.permission === "FullAccess";
    const receiverId =
      typeof r.permission === "object" && r.permission?.FunctionCall ? r.permission.FunctionCall.receiver_id ?? null : null;
    return { nonce: String(r.nonce), blockHeight: r.block_height, receiverId, fullAccess };
  } catch {
    return null;
  }
}

export async function viewLedger<T>(methodName: string, args: Record<string, unknown>): Promise<T | null> {
  const relayer = getActiveRelayer();
  if (!relayer || !relayer.contractDeployed) return null;
  try {
    const account = await getRelayerAccount();
    const call = account.viewFunction({ contractId: relayer.contractId, methodName, args });
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 9000));
    return (await Promise.race([call, timeout])) as T | null;
  } catch {
    return null;
  }
}

/**
 * Seed for a round: the latest final NEAR testnet block. Needs no key. Falls back to
 * local randomness (and says so) when the RPC cannot be reached.
 */
export async function fetchRoundSeed(): Promise<RoundSeed> {
  for (const url of [rpcUrl(), "https://rpc.testnet.near.org"]) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "seed",
          method: "block",
          params: { finality: "final" },
        }),
        signal: AbortSignal.timeout(4000),
      });
      const json = (await res.json()) as {
        result?: { header?: { height?: number; hash?: string } };
      };
      const header = json.result?.header;
      if (header?.hash && typeof header.height === "number") {
        return { source: "near-block", blockHeight: header.height, blockHash: header.hash };
      }
    } catch {
      // try the next endpoint
    }
  }
  const local = Array.from({ length: 4 }, () => Math.random().toString(36).slice(2)).join("");
  return { source: "local", blockHeight: null, blockHash: local };
}
