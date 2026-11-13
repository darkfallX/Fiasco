"use client";

import React, { useEffect, useState } from "react";
import { ChainLedger } from "./ChainLedger";
import { AGENT_PROFILES } from "@/lib/sim/missions";
import { PAYOUT_PER_SHARE } from "@/lib/market/lmsr";
import { ArenaState } from "@/lib/types";
import { GlyphExternal } from "./Glyphs";

type Props = {
  arena: ArenaState;
  inspectedTurn: number | null;
  onSelectTurn: (turn: number) => void;
  onReturnToLive: () => void;
};

type TabId = "activity" | "rules" | "proof" | "replay";

export function LowerTabs({
  arena,
  inspectedTurn,
  onSelectTurn,
  onReturnToLive,
  }: Props) {
  const [tab, setTab] = useState<TabId>("activity");
  const currentReplayTurn = inspectedTurn !== null ? inspectedTurn : arena.turn;

  return (
    <div className="border border-[#CDC3AC] bg-[#F7F2E6]">
      {/* Tab Header */}
      <div className="flex flex-wrap items-center border-b border-[#CDC3AC] px-2">
        {(
          [
            { id: "activity", label: `TAPE (${arena.trades.length})` },
            { id: "rules", label: "RULES" },
            { id: "proof", label: "ON-CHAIN" },
            { id: "replay", label: "REPLAY" },
          ] as const
        ).map((item) => {
          const active = tab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              className={`border-b-2 px-3.5 py-2.5 font-mono-num text-[11px] font-semibold cursor-pointer ${
                active
                  ? "border-[#1A1915] text-[#1A1915]"
                  : "border-transparent text-[#8A8372]"
              }`}
            >
              {item.label}
            </button>
          );
        })}
      </div>

      <div className="p-4">
        {tab === "activity" && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Events */}
            <div>
              <div className="font-mono-num text-[11px] font-semibold text-[#5E584B] mb-2">
                MILESTONE LOG ({arena.events.length})
              </div>
              <div className="max-h-60 overflow-y-auto space-y-1 pr-1">
                {[...arena.events].reverse().map((evt) => (
                  <button
                    key={evt.id}
                    type="button"
                    onClick={() => onSelectTurn(evt.turn)}
                    className="w-full text-left border border-[#CDC3AC] bg-[#EFE8D8] px-3 py-2 cursor-pointer"
                  >
                    <div className="flex items-center justify-between gap-2 font-mono-num text-[11px]">
                      <span className="font-semibold text-[#1A1915]">{evt.title}</span>
                      <span className="text-[#8A8372]">T{evt.turn}</span>
                    </div>
                    <p className="mt-0.5 text-[11px] text-[#5E584B]">{evt.detail}</p>
                  </button>
                ))}
              </div>
            </div>

            {/* Trade Tape */}
            <div>
              <div className="font-mono-num text-[11px] font-semibold text-[#5E584B] mb-2">
                EXECUTED TRADES ({arena.trades.length})
              </div>
              {arena.trades.length === 0 ? (
                <div className="border border-dashed border-[#CDC3AC] bg-[#EFE8D8] p-6 text-center font-mono-num text-xs text-[#8A8372]">
                  NO EXECUTED ORDERS
                </div>
              ) : (
                <div className="max-h-60 overflow-y-auto space-y-1 pr-1">
                  {arena.trades.map((tr) => {
                    const profile = AGENT_PROFILES[tr.agentId];
                    return (
                      <div
                        key={tr.id}
                        className="border border-[#CDC3AC] bg-[#EFE8D8] px-3 py-2 font-mono-num text-[11px] flex items-center justify-between gap-2"
                      >
                        <div>
                          <div className="flex items-center gap-2">
                            <span
                              className={`border px-1.5 py-0.5 text-[10px] font-bold ${
                                tr.traderType === "user"
                                  ? "border-[#1A1915] bg-[#E0D6BF] text-[#1A1915]"
                                  : "border-[#CDC3AC] bg-[#F7F2E6] text-[#5E584B]"
                              }`}
                            >
                              {tr.traderType === "user" ? "YOU" : tr.trader.toUpperCase()}
                            </span>
                            <span className="font-semibold text-[#1A1915]">
                              {tr.action} {tr.shares.toFixed(2)} {tr.side}
                            </span>
                            <span className="text-[#5E584B]">{profile.callsign}</span>
                          </div>
                          <div className="mt-0.5 text-[10px] text-[#8A8372]">
                            T{tr.turn} / AVG {tr.avgPricePerShare.toFixed(1)}c /{" "}
                            {tr.yesPriceBefore.toFixed(1)}c → {tr.yesPriceAfter.toFixed(1)}c
                          </div>
                        </div>
                        <span
                          className={`font-bold ${
                            tr.creditsDelta < 0 ? "text-[#1A1915]" : "text-[#1F7A4D]"
                          }`}
                        >
                          {tr.creditsDelta > 0 ? "+" : ""}
                          {tr.creditsDelta.toFixed(2)} CR
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}

        {tab === "rules" && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
            <div className="border border-[#CDC3AC] bg-[#EFE8D8] p-3.5 space-y-2">
              <div className="font-mono-num text-[11px] font-bold text-[#1A1915]">
                01 / SETTLEMENT SPEC
              </div>
              <ul className="space-y-1.5 text-[#5E584B] font-mono-num text-[11px]">
                <li>01. TARGET: 3/3 DROPZONES IN &lt;= {arena.mission.maxTurns} TURNS</li>
                <li>02. LOCKED TOOLS: ZERO MANUAL RESCUE DURING RUN</li>
                <li>
                  03. WINDOWS: OPEN PRE-ROUND, T{arena.mission.checkpoints[0]}, T
                  {arena.mission.checkpoints[1]}
                </li>
                <li>04. ISOLATED GRIDS: AGENTS SETTLE INDEPENDENTLY</li>
              </ul>
            </div>

            <div className="border border-[#CDC3AC] bg-[#EFE8D8] p-3.5 space-y-2">
              <div className="font-mono-num text-[11px] font-bold text-[#1A1915]">
                02 / LMSR COST FUNCTION
              </div>
              <div className="font-mono-num text-[11px] text-[#5E584B]">
                C(qY, qN) = b * ln(e^(qY/b) + e^(qN/b)) * {PAYOUT_PER_SHARE} CR
              </div>
              <div className="grid grid-cols-2 gap-2 pt-1 font-mono-num text-[11px]">
                <div className="border border-[#CDC3AC] bg-[#F7F2E6] p-2">
                  <div className="text-[10px] text-[#8A8372]">PARAMETER b</div>
                  <div className="font-bold text-[#1A1915]">
                    {arena.markets.vanguard.b}
                  </div>
                </div>
                <div className="border border-[#CDC3AC] bg-[#F7F2E6] p-2">
                  <div className="text-[10px] text-[#8A8372]">SUBSIDY CAP</div>
                  <div className="font-bold text-[#1A1915]">
                    {arena.markets.vanguard.initialSubsidyMax.toFixed(2)} CR
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {tab === "proof" && <ChainLedger arena={arena} />}

        {tab === "replay" && (
          <div className="space-y-3 font-mono-num">
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="font-bold text-[#1A1915]">
                SNAPSHOT SCRUBBER / T0..T{arena.turn}
              </span>
              {inspectedTurn !== null && inspectedTurn < arena.turn && (
                <button
                  type="button"
                  onClick={onReturnToLive}
                  className="border border-[#1A1915] bg-[#E6DDC8] px-2.5 py-1 text-[11px] font-semibold text-[#1A1915] cursor-pointer"
                >
                  LIVE T{arena.turn}
                </button>
              )}
            </div>

            <div className="flex items-center gap-3">
              <span className="text-xs font-bold text-[#1A1915] w-10">
                T{currentReplayTurn}
              </span>
              <input
                type="range"
                min={0}
                max={arena.turn}
                value={currentReplayTurn}
                onChange={(e) => onSelectTurn(Number(e.target.value))}
                disabled={arena.turn === 0}
                className="flex-1 accent-[#A8690A] cursor-pointer"
              />
              <span className="text-xs text-[#8A8372] w-10 text-right">
                T{arena.turn}
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
