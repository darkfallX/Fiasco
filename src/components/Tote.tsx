"use client";

import React, { useState } from "react";
import { PAYOUT_PER_SHARE, quoteBuyByCredits, quoteSellShares } from "@/lib/market/lmsr";
import { AGENT_PROFILES } from "@/lib/sim/missions";
import { AGENT_IDS } from "@/lib/sim/engine";
import { AgentId, AgentState, ArenaState, OutcomeSide } from "@/lib/types";

export const AGENT_NUM: Record<AgentId, string> = { vanguard: "1", gridwise: "2", pivot: "3" };
export const AGENT_INK: Record<AgentId, string> = {
  vanguard: "#F7F2E6",
  gridwise: "#F7F2E6",
  pivot: "#1A1915",
};

export function odds(price: number): string {
  return (PAYOUT_PER_SHARE / Math.max(1, price)).toFixed(2);
}

export function money(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

type TradeFn = (params: {
  agentId: AgentId;
  action: "BUY" | "SELL";
  side: OutcomeSide;
  amount: number;
}) => Promise<void>;

function stamp(st: AgentState): { text: string; cls: string } | null {
  if (st.status === "completed")
    return { text: `FINISHED T${st.finishedTurn}`, cls: "bg-[#1F7A4D] text-[#F7F2E6]" };
  if (st.status === "failed_battery")
    return { text: "OUT OF POWER", cls: "bg-[#C22A1C] text-[#F7F2E6]" };
  if (st.status === "failed_timeout")
    return { text: "OUT OF TIME", cls: "bg-[#C22A1C] text-[#F7F2E6]" };
  if (st.status === "charging") return { text: "CHARGING", cls: "bg-[#1A1915] text-[#F7F2E6]" };
  return null;
}

export function RacerBoard({
  arena,
  agents,
  selected,
  onSelect,
  focus,
  onFocus,
}: {
  arena: ArenaState;
  agents: Record<AgentId, AgentState>;
  selected: AgentId;
  onSelect: (id: AgentId) => void;
  focus: AgentId | "all";
  onFocus: (id: AgentId | "all") => void;
}) {
  return (
    <div className="divide-y-2 divide-[#1A1915] border-b-2 border-[#1A1915]">
      {AGENT_IDS.map((id) => {
        const p = AGENT_PROFILES[id];
        const st = agents[id];
        const mkt = arena.markets[id];
        const active = selected === id;
        const s = stamp(st);
        const low = st.battery <= 4;
        const total = arena.mission.deliveries.length;
        return (
          <div
            key={id}
            role="button"
            tabIndex={0}
            data-film={`racer-${id}`}
            onClick={() => onSelect(id)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelect(id);
              }
            }}
            className={`flex cursor-pointer outline-none ${active ? "bg-[#E6DDC8]" : "bg-[#F7F2E6]"}`}
          >
            <button
              type="button"
              aria-label={`Follow ${p.name}`}
              aria-pressed={focus === id}
              onClick={(e) => {
                e.stopPropagation();
                onFocus(focus === id ? "all" : id);
              }}
              className="w-16 shrink-0 flex flex-col items-center justify-center font-display font-extrabold text-5xl leading-none"
              style={{ backgroundColor: p.color, color: AGENT_INK[id] }}
            >
              {AGENT_NUM[id]}
              <span
                className="mt-1 h-1.5 w-6"
                style={{ backgroundColor: focus === id ? AGENT_INK[id] : "transparent" }}
              />
            </button>

            <div className="flex-1 min-w-0 px-3 py-2.5">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-display text-2xl font-bold leading-none uppercase truncate">
                    {p.name}
                  </div>
                  <div className="mt-1 text-[11px] font-semibold uppercase tracking-wide text-[#5E584B] truncate">
                    {p.strategyTitle}
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <div
                    key={mkt.yesPrice.toFixed(1)}
                    className="anim-flip font-display text-3xl font-extrabold leading-none tnum"
                  >
                    <span className="text-xl align-top">x</span>
                    {odds(mkt.yesPrice)}
                  </div>
                </div>
              </div>

              <div className="mt-2 flex items-center gap-2">
                <div className="flex gap-1">
                  {Array.from({ length: total }).map((_, i) => (
                    <span
                      key={i}
                      className="h-3.5 w-3.5 border-2 border-[#1A1915]"
                      style={{
                        backgroundColor: i < st.deliveredIds.length ? p.color : "transparent",
                      }}
                    />
                  ))}
                </div>
                <div className="flex-1 flex gap-px h-3.5" aria-label={`Battery ${st.battery} of ${st.maxBattery}`}>
                  {Array.from({ length: st.maxBattery }).map((_, i) => (
                    <span
                      key={i}
                      className="flex-1"
                      style={{
                        backgroundColor:
                          i < st.battery ? (low ? "#C22A1C" : "#1A1915") : "#CDC3AC",
                      }}
                    />
                  ))}
                </div>
                <span
                  className={`font-display text-lg font-bold leading-none tnum w-6 text-right ${
                    low ? "text-[#C22A1C]" : ""
                  }`}
                >
                  {st.battery}
                </span>
              </div>

              {s && (
                <div
                  className={`mt-2 inline-block px-1.5 py-0.5 font-display text-sm font-bold tracking-wide ${s.cls}`}
                >
                  {s.text}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function BetSlip({
  arena,
  selected,
  onTrade,
  busy,
  error,
  forced,
}: {
  arena: ArenaState;
  selected: AgentId;
  onTrade: TradeFn;
  busy: boolean;
  error: string | null;
  /** Trailer only: overrides the slip's own selection. */
  forced?: { side: OutcomeSide; stake: number };
}) {
  const [ownSide, setSide] = useState<OutcomeSide>("YES");
  const [ownStake, setStake] = useState(50);
  const side = forced?.side ?? ownSide;
  const stake = forced?.stake ?? ownStake;

  const market = arena.markets[selected];
  const profile = AGENT_PROFILES[selected];
  const open = arena.tradingStatus === "OPEN";
  const settled = arena.tradingStatus === "SETTLED";
  const spend = Math.min(stake, Math.floor(arena.userCredits));
  const quote = quoteBuyByCredits(market, side, spend);
  const nextCp =
    arena.turn < arena.mission.checkpoints[0]
      ? arena.mission.checkpoints[0]
      : arena.mission.checkpoints[1];

  const held = AGENT_IDS.flatMap((id) => {
    const pos = arena.positions[id];
    const rows: { id: AgentId; side: OutcomeSide; shares: number; exit: number }[] = [];
    if (pos.yesShares > 0.001)
      rows.push({
        id,
        side: "YES",
        shares: pos.yesShares,
        exit: settled ? 0 : quoteSellShares(arena.markets[id], "YES", pos.yesShares).proceedsCredits,
      });
    if (pos.noShares > 0.001)
      rows.push({
        id,
        side: "NO",
        shares: pos.noShares,
        exit: settled ? 0 : quoteSellShares(arena.markets[id], "NO", pos.noShares).proceedsCredits,
      });
    return rows;
  });

  return (
    <div className="p-3 space-y-3">
      <div className="grid grid-cols-2 gap-2">
        {(["YES", "NO"] as const).map((s) => {
          const on = side === s;
          const price = s === "YES" ? market.yesPrice : market.noPrice;
          return (
            <button
              key={s}
              type="button"
              aria-pressed={on}
              data-film={`side-${s}`}
              onClick={() => setSide(s)}
              className={`border-2 border-[#1A1915] px-3 py-2 text-left ${
                on
                  ? s === "YES"
                    ? "bg-[#1F7A4D] text-[#F7F2E6]"
                    : "bg-[#C22A1C] text-[#F7F2E6]"
                  : "bg-[#F7F2E6] text-[#1A1915]"
              }`}
            >
              <div className="font-display text-xl font-bold leading-none">
                {s === "YES" ? "FINISHES" : "FAILS"}
              </div>
              <div className="mt-1 font-display text-3xl font-extrabold leading-none tnum">
                <span className="text-lg align-top">x</span>
                {odds(price)}
              </div>
            </button>
          );
        })}
      </div>

      <div className="grid grid-cols-5 border-2 border-[#1A1915] divide-x-2 divide-[#1A1915]">
        {[25, 50, 100, 250, 0].map((v) => {
          const val = v === 0 ? Math.floor(arena.userCredits) : v;
          const on = stake === val;
          return (
            <button
              key={v}
              type="button"
              disabled={!open || val > arena.userCredits || val <= 0}
              data-film={`chip-${v}`}
              onClick={() => setStake(val)}
              className={`py-2 font-display text-xl font-bold leading-none tnum disabled:text-[#B5AB93] ${
                on ? "bg-[#1A1915] text-[#F7F2E6]" : "bg-[#F7F2E6] text-[#1A1915]"
              }`}
            >
              {v === 0 ? "ALL" : v}
            </button>
          );
        })}
      </div>

      <button
        type="button"
        disabled={!open || busy || spend <= 0}
        data-film="bet"
        onClick={() => onTrade({ agentId: selected, action: "BUY", side, amount: spend })}
        className="w-full border-2 border-[#1A1915] px-3 py-3 flex items-center justify-between disabled:bg-[#E6DDC8] disabled:text-[#8A8372] disabled:border-[#B5AB93]"
        style={open && spend > 0 ? { backgroundColor: profile.color, color: AGENT_INK[selected] } : undefined}
      >
        {open ? (
          <>
            <span className="font-display text-2xl font-extrabold leading-none">
              BET {spend} ON {AGENT_NUM[selected]}
            </span>
            <span className="font-display text-2xl font-extrabold leading-none tnum">
              WIN {money(quote.potentialPayout)}
            </span>
          </>
        ) : (
          <span className="font-display text-2xl font-extrabold leading-none mx-auto">
            {settled ? "ROUND SETTLED" : `BETS REOPEN AT T${nextCp}`}
          </span>
        )}
      </button>

      {error && (
        <div className="bg-[#C22A1C] px-3 py-2 text-sm font-semibold text-[#F7F2E6]">{error}</div>
      )}

      {held.length > 0 && (
        <div className="border-2 border-[#1A1915] divide-y divide-[#CDC3AC]">
          {held.map((row) => {
            const p = AGENT_PROFILES[row.id];
            const pays = row.shares * PAYOUT_PER_SHARE;
            return (
              <div key={row.id + row.side} className="flex items-stretch">
                <span
                  className="w-9 shrink-0 flex items-center justify-center font-display text-2xl font-extrabold"
                  style={{ backgroundColor: p.color, color: AGENT_INK[row.id] }}
                >
                  {AGENT_NUM[row.id]}
                </span>
                <div className="flex-1 px-2.5 py-1.5 flex items-center justify-between gap-2">
                  <span
                    className={`font-display text-lg font-bold leading-none ${
                      row.side === "YES" ? "text-[#1F7A4D]" : "text-[#C22A1C]"
                    }`}
                  >
                    {row.side === "YES" ? "FINISHES" : "FAILS"}
                  </span>
                  <span className="font-display text-lg font-bold leading-none tnum">
                    PAYS {money(pays)}
                  </span>
                </div>
                {!settled && (
                  <button
                    type="button"
                    disabled={!open || busy}
                    data-film={`cashout-${row.id}`}
                    onClick={() =>
                      onTrade({ agentId: row.id, action: "SELL", side: row.side, amount: row.shares })
                    }
                    className="shrink-0 border-l-2 border-[#1A1915] bg-[#1A1915] px-2.5 font-display text-base font-bold leading-none text-[#F7F2E6] tnum disabled:bg-[#E6DDC8] disabled:text-[#8A8372]"
                  >
                    CASH OUT {money(row.exit)}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function PuntersBoard({ arena }: { arena: ArenaState }) {
  if (arena.punters.length === 0) return null;
  return (
    <div className="mx-3 mb-3 border-2 border-[#1A1915]">
      <div className="bg-[#1A1915] px-2.5 py-1 font-display text-base font-bold leading-none text-[#F7F2E6]">
        PUNTERS
      </div>
      <div className="divide-y divide-[#CDC3AC]">
        {arena.punters.map((p) => (
          <div key={p.id} className="flex items-center justify-between gap-2 px-2.5 py-1.5">
            <div className="min-w-0">
              <span className="font-display text-lg font-bold leading-none uppercase">{p.name}</span>
              <span className="ml-2 text-[11px] font-semibold uppercase text-[#5E584B]">
                {p.out ? "SITTING OUT" : p.lastBet ?? p.style}
              </span>
            </div>
            <span
              key={p.bankroll}
              className="anim-flip font-display text-lg font-bold leading-none tnum shrink-0"
            >
              {money(p.bankroll)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
