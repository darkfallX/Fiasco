"use client";

import React, { useEffect, useState } from "react";
import { ArenaState } from "@/lib/types";
import { GlyphExternal } from "./Glyphs";

type OnChainPlayer = {
  balance_cents: number;
  bets: number;
  rounds_settled: number;
  rebuys: number;
} | null;

type LedgerView =
  | { enabled: false; error?: string }
  | {
      enabled: true;
      contractId: string;
      verifierId: string;
      explorerUrl: string;
      playerId: string;
      player: OnChainPlayer;
      punters: { id: string; name: string; onChain: OnChainPlayer }[];
      stats: { rounds: number; settled: number; players: number; bets: number; volume_cents: number } | null;
      round: { status: number; winners: string[]; seed_height: number; bettors: string[] } | null;
      pendingOps: number;
      confirmedOps: number;
      rejectedOps: number;
    };

const ROUND_STATUS = ["OPEN", "LOCKED", "SETTLED", "VOID"];

function chips(cents: number | undefined): string {
  if (cents === undefined) return "0.00";
  return (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5 border-b border-[#CDC3AC] last:border-b-0">
      <span className="font-mono-num text-[11px] text-[#5E584B] shrink-0">{k}</span>
      <span className="font-mono-num text-xs font-semibold text-right break-all">{v}</span>
    </div>
  );
}

/** What the NEAR contract holds for this player, the punters and the current round. */
export function ChainLedger({ arena }: { arena: ArenaState }) {
  const [view, setView] = useState<LedgerView | null>(null);
  const receipts = arena.evidence.nearContractSpec.receipts;
  const refreshKey = `${arena.roundId}:${arena.chain.confirmedOps}:${arena.chain.rejectedOps}`;

  useEffect(() => {
    let live = true;
    fetch("/api/near/relayer")
      .then((r) => r.json())
      .then((d) => {
        if (live) setView(d as LedgerView);
      })
      .catch(() => {
        if (live) setView({ enabled: false, error: "Ledger unreachable" });
      });
    return () => {
      live = false;
    };
  }, [refreshKey]);

  if (!view) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="skeleton h-6" style={{ width: `${92 - i * 9}%` }} />
        ))}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-8 gap-y-5">
      <div>
        <h3 className="font-display text-xl font-bold leading-none mb-2">THIS ROUND</h3>
        <Row k="ROUND" v={arena.roundId} />
        <Row
          k="SEED BLOCK"
          v={
            arena.seed.source === "near-block" ? (
              <a
                className="underline inline-flex items-center gap-1"
                href={`https://testnet.nearblocks.io/blocks/${arena.seed.blockHash}`}
                target="_blank"
                rel="noreferrer"
              >
                {arena.seed.blockHeight}
                <GlyphExternal className="h-3 w-3" />
              </a>
            ) : (
              "LOCAL RANDOM"
            )
          }
        />
        <Row k="SEED HASH" v={arena.seed.blockHash} />
        <Row k="MISSION HASH" v={arena.evidence.missionHash.slice(0, 34)} />
        <Row k="ACTION LOG" v={arena.evidence.actionLogHash.slice(0, 34)} />
        <Row k="SETTLEMENT" v={arena.evidence.settlementHash.slice(0, 34)} />
        {view.enabled && (
          <Row
            k="ON-CHAIN STATE"
            v={view.round ? ROUND_STATUS[view.round.status] ?? "?" : "NOT WRITTEN YET"}
          />
        )}
        <Row k="COURIER BRAIN" v={arena.evidence.nearAiAttestation.model} />
      </div>

      <div>
        <h3 className="font-display text-xl font-bold leading-none mb-2">CHIP LEDGER</h3>
        {view.enabled ? (
          <>
            <Row
              k="CONTRACT"
              v={
                <a
                  className="underline inline-flex items-center gap-1"
                  href={view.explorerUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  {view.contractId}
                  <GlyphExternal className="h-3 w-3" />
                </a>
              }
            />
            <Row k="YOU" v={view.playerId} />
            <Row
              k="YOUR CHIPS ON-CHAIN"
              v={view.player ? chips(view.player.balance_cents) : "NO BETS YET"}
            />
            {view.punters.map((p) => (
              <Row
                key={p.id}
                k={p.name.toUpperCase()}
                v={p.onChain ? chips(p.onChain.balance_cents) : "NO BETS YET"}
              />
            ))}
            <Row
              k="ALL GAMES"
              v={
                view.stats
                  ? `${view.stats.rounds} ROUNDS / ${view.stats.bets} BETS / ${chips(view.stats.volume_cents)} STAKED`
                  : "UNAVAILABLE"
              }
            />
            <Row
              k="YOUR WRITES"
              v={`${view.confirmedOps} CONFIRMED / ${view.pendingOps} PENDING / ${view.rejectedOps} REJECTED`}
            />
          </>
        ) : (
          <p className="text-sm text-[#5E584B]">
            Running on the local ledger. Set the relayer and contract variables in .env.local to
            write every bet and payout to NEAR testnet.
          </p>
        )}
      </div>

      <div className="lg:col-span-2">
        <h3 className="font-display text-xl font-bold leading-none mb-2">
          TRANSACTIONS ({receipts.length})
        </h3>
        {receipts.length === 0 ? (
          <div className="border border-dashed border-[#CDC3AC] p-4 font-mono-num text-xs text-[#8A8372]">
            NOTHING WRITTEN FOR THIS ROUND YET
          </div>
        ) : (
          <div className="border border-[#CDC3AC] divide-y divide-[#CDC3AC]">
            {receipts.map((r) => (
              <a
                key={r.id}
                href={r.explorerUrl}
                target="_blank"
                rel="noreferrer"
                className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 font-mono-num text-[11px]"
              >
                <span className="font-semibold uppercase">{r.method}</span>
                {r.note && <span className="text-[#C22A1C]">{r.note}</span>}
                <span className="inline-flex items-center gap-1 underline">
                  {r.txHash.slice(0, 16)}
                  <GlyphExternal className="h-3 w-3" />
                </span>
              </a>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
