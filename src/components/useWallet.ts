"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { DelegatePayload, newWalletKey, PlayerMethod, signLinkProof, signPlayerAction } from "@/lib/near/delegate";
import { ArenaState } from "@/lib/types";

type StoredWallet = { accountId: string; publicKey: string; secretKey: string };

const STORE = "fiasco_wallet";
const PENDING = "fiasco_wallet_pending";

function readStore<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

/**
 * The player's own NEAR account. The browser keeps a key that the account has allowed
 * to call only the game's player methods, signs each bet with it, and the game relays
 * the signed action and pays the gas.
 */
export function useWallet(arena: ArenaState, setArena: (a: ArenaState) => void) {
  const [stored, setStored] = useState<StoredWallet | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const nonceRef = useRef<bigint>(BigInt(0));
  const triedRef = useRef<string | null>(null);

  // Load a saved wallet. A key still marked pending (a wallet that redirected away while
  // approving it) is tried once: the server only accepts it if it is on the account.
  useEffect(() => {
    const saved = readStore<StoredWallet>(STORE);
    const pending = readStore<StoredWallet>(PENDING);
    setStored(saved ?? (pending?.accountId ? pending : null));
    const params = new URLSearchParams(window.location.search);
    if (params.get("transactionHashes") || params.get("errorCode")) {
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

  const link = useCallback(
    async (w: StoredWallet) => {
      setWorking(true);
      setError(null);
      try {
        const issuedAt = Date.now();
        const res = await fetch("/api/wallet/link", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            accountId: w.accountId,
            publicKey: w.publicKey,
            issuedAt,
            signature: signLinkProof(w.secretKey, w.accountId, issuedAt),
          }),
        });
        const data = await res.json();
        if (!res.ok) setError(data.error || "Could not connect the wallet");
        else {
          if (data.arena) setArena(data.arena);
          try {
            localStorage.setItem(STORE, JSON.stringify(w));
            localStorage.removeItem(PENDING);
          } catch {
            // storage blocked: the wallet works for this page view only
          }
        }
      } catch {
        setError("Could not reach the game server");
      } finally {
        setWorking(false);
      }
    },
    [setArena]
  );

  const linked = Boolean(stored && arena.chain.wallet?.accountId === stored.accountId);

  // Reconnect after a reload or a server restart, once per page view.
  useEffect(() => {
    if (!stored || !arena.chain.enabled || linked || triedRef.current === stored.accountId) return;
    triedRef.current = stored.accountId;
    void link(stored);
  }, [stored, arena.chain.enabled, linked, link]);

  const connect = useCallback(async () => {
    const key = newWalletKey();
    setWorking(true);
    setError(null);
    try {
      localStorage.setItem(PENDING, JSON.stringify(key));
      const { connectAndAddKey } = await import("./walletSelector");
      const { accountId } = await connectAndAddKey(arena.chain.contractId, key.publicKey);
      const w = { accountId, ...key };
      localStorage.setItem(PENDING, JSON.stringify(w));
      setStored(w);
      triedRef.current = accountId;
      await link(w);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Wallet connection failed");
    } finally {
      setWorking(false);
    }
  }, [arena.chain.contractId, link]);

  const sign = useCallback(
    async (methodName: PlayerMethod, args: Record<string, unknown>): Promise<DelegatePayload> => {
      if (!stored) throw new Error("No wallet");
      const res = await fetch("/api/wallet/key");
      const key = await res.json();
      if (!res.ok) throw new Error(key.error || "Could not read the wallet key");
      const chainNonce = BigInt(key.nonce);
      const next = (chainNonce > nonceRef.current ? chainNonce : nonceRef.current) + BigInt(1);
      nonceRef.current = next;
      return signPlayerAction({
        secretKey: stored.secretKey,
        senderId: stored.accountId,
        receiverId: arena.chain.contractId,
        methodName,
        args,
        nonce: next,
        blockHeight: key.blockHeight,
      });
    },
    [stored, arena.chain.contractId]
  );

  const move = useCallback(
    async (direction: "out" | "in", chips: number) => {
      const cents = Math.floor(chips * 100);
      if (cents <= 0) return;
      setWorking(true);
      setError(null);
      try {
        const meta = await sign(direction === "out" ? "cash_out" : "buy_in", { cents });
        const res = await fetch("/api/wallet/move", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ direction, meta }),
        });
        const data = await res.json();
        if (!res.ok) setError(data.error || "Move failed");
        else if (data.arena) setArena(data.arena);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Move failed");
      } finally {
        setWorking(false);
      }
    },
    [sign, setArena]
  );

  const disconnect = useCallback(async () => {
    try {
      localStorage.removeItem(STORE);
    } catch {
      // nothing stored
    }
    setStored(null);
    triedRef.current = null;
    const res = await fetch("/api/wallet/unlink", { method: "POST" });
    const data = await res.json().catch(() => ({}));
    if (data.arena) setArena(data.arena);
  }, [setArena]);

  return {
    accountId: stored?.accountId ?? null,
    linked,
    working,
    error,
    connect,
    retry: () => stored && link(stored),
    sign,
    move,
    disconnect,
  };
}

export type Wallet = ReturnType<typeof useWallet>;
