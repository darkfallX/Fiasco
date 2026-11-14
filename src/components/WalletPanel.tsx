"use client";

import React from "react";
import { ArenaState } from "@/lib/types";
import type { Wallet } from "./useWallet";
import { money } from "./Tote";

function Figure({ label, value, unit }: { label: string; value: string; unit: string }) {
  return (
    <div className="flex-1 border-2 border-[#1A1915] px-3 py-2">
      <div className="font-display text-sm font-bold leading-none text-[#5E584B]">{label}</div>
      <div className="mt-1 font-display text-3xl font-extrabold leading-none tnum">
        {value}
        <span className="ml-1 text-base">{unit}</span>
      </div>
    </div>
  );
}

/** Connect a NEAR account, and move chips between the table and the wallet. */
export function WalletPanel({ arena, wallet }: { arena: ArenaState; wallet: Wallet }) {
  if (!arena.chain.enabled) return null;
  const table = arena.userCredits;
  const chips = arena.chain.wallet?.chips ?? null;
  const settledOrFresh = arena.tradingStatus !== "LOCKED";

  return (
    <div className="mb-5 border-b-2 border-[#1A1915] pb-5">
      <h3 className="font-display text-xl font-bold leading-none mb-2">YOUR NEAR ACCOUNT</h3>

      {!wallet.accountId && (
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={wallet.working}
            onClick={() => void wallet.connect()}
            className="bg-[#1A1915] px-4 py-3 font-display text-xl font-bold leading-none text-[#F7F2E6] disabled:bg-[#8A8372]"
          >
            {wallet.working ? "WAITING FOR WALLET" : "CONNECT WALLET"}
          </button>
          <p className="max-w-md text-sm text-[#5E584B]">
            Testnet. Approve one transaction that gives this browser a key able only to place bets and move
            chips. You sign every bet; the game pays the gas.
          </p>
        </div>
      )}

      {wallet.accountId && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-mono-num text-sm font-semibold break-all">{wallet.accountId}</span>
            <span className="font-display text-base font-bold leading-none">
              {wallet.linked ? (
                <span className="text-[#1F7A4D]">SIGNING YOUR OWN BETS</span>
              ) : wallet.working ? (
                <span className="skeleton inline-block h-4 w-32 align-middle" />
              ) : (
                <button type="button" onClick={() => wallet.retry()} className="underline">
                  RECONNECT
                </button>
              )}
            </span>
          </div>

          {wallet.linked && (
            <>
              <div className="flex gap-2">
                <Figure label="ON THE TABLE" value={money(table)} unit="" />
                <Figure label="IN YOUR WALLET" value={chips === null ? "..." : money(chips)} unit="CHIP" />
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={wallet.working || table < 0.01 || !settledOrFresh}
                  onClick={() => wallet.move("out", table)}
                  className="flex-1 bg-[#1A1915] px-3 py-3 font-display text-lg font-bold leading-none text-[#F7F2E6] disabled:bg-[#E6DDC8] disabled:text-[#8A8372]"
                >
                  CASH OUT {money(table)} TO WALLET
                </button>
                <button
                  type="button"
                  disabled={wallet.working || !chips || chips < 0.01 || !settledOrFresh}
                  onClick={() => chips && wallet.move("in", chips)}
                  className="flex-1 border-2 border-[#1A1915] px-3 py-3 font-display text-lg font-bold leading-none disabled:border-[#B5AB93] disabled:text-[#8A8372]"
                >
                  BUY IN {chips ? money(chips) : "0.00"} CHIP
                </button>
              </div>
            </>
          )}

          <button type="button" onClick={() => void wallet.disconnect()} className="font-mono-num text-xs underline">
            DISCONNECT
          </button>
        </div>
      )}

      {wallet.error && <div className="mt-3 bg-[#C22A1C] px-3 py-2 text-sm font-semibold text-[#F7F2E6]">{wallet.error}</div>}
    </div>
  );
}
