"use client";

import React, { useState } from "react";
import { AGENT_PROFILES, MISSIONS } from "@/lib/sim/missions";
import { AGENT_IDS } from "@/lib/sim/engine";
import { quoteSellShares, PAYOUT_PER_SHARE } from "@/lib/market/lmsr";
import { SettledRoundArchive } from "@/lib/server/store";
import { ArenaState } from "@/lib/types";

type DiscoverProps = {
  arena: ArenaState;
  archive: SettledRoundArchive[];
  onLoadMission: (missionId: string) => Promise<void>;
  loading: boolean;
};

export function DiscoverView({
  arena,
  archive,
  onLoadMission,
  loading,
}: DiscoverProps) {
  return (
    <div className="space-y-6">
      <div className="border-b border-[#CDC3AC] pb-3 flex items-center justify-between">
        <h2 className="font-display text-lg font-bold tracking-tight text-[#1A1915]">
          MISSION DIRECTORY
        </h2>
        <span className="font-mono-num text-[11px] text-[#5E584B]">
          {MISSIONS.length} DETERMINISTIC SCENARIOS
        </span>
      </div>

      {/* Mission Table (Architectural ledger, zero bento grids) */}
      <div className="border border-[#CDC3AC] bg-[#F7F2E6] divide-y divide-[#CDC3AC]">
        {MISSIONS.map((m) => {
          const isActive = arena.mission.id === m.id;
          return (
            <div
              key={m.id}
              className="p-4 flex flex-col md:flex-row md:items-center justify-between gap-4"
            >
              <div className="space-y-1">
                <div className="flex items-center gap-2 font-mono-num text-[11px]">
                  <span className="border border-[#CDC3AC] bg-[#EFE8D8] px-2 py-0.5 font-bold text-[#1A1915]">
                    {m.seed}
                  </span>
                  <span
                    className={`border px-2 py-0.5 font-bold ${
                      m.difficulty === "Standard"
                        ? "border-[#1F7A4D] text-[#1F7A4D]"
                        : m.difficulty === "Hazard"
                        ? "border-[#A8690A] text-[#A8690A]"
                        : "border-[#C22A1C] text-[#C22A1C]"
                    }`}
                  >
                    {m.difficulty.toUpperCase()}
                  </span>
                  <span className="text-[#8A8372]">
                    {m.maxTurns} TURNS / {m.startBattery} BAT / {m.scheduledHazards.length}{" "}
                    HAZARDS
                  </span>
                </div>
                <h3 className="font-display text-base font-bold text-[#1A1915]">
                  {m.title}
                </h3>
                <p className="text-xs text-[#5E584B]">{m.question}</p>
              </div>

              <button
                type="button"
                disabled={loading}
                onClick={() => onLoadMission(m.id)}
                className={`border px-4 py-2 font-mono-num text-xs font-bold shrink-0 cursor-pointer ${
                  isActive
                    ? "border-[#1F7A4D] bg-[#D9E8D6] text-[#1F7A4D]"
                    : "border-[#1A1915] bg-[#E6DDC8] text-[#1A1915]"
                }`}
              >
                {isActive ? "RELAUNCH ACTIVE" : "LOAD IN ARENA"}
              </button>
            </div>
          );
        })}
      </div>

      {/* Settled Archive */}
      <div className="border border-[#CDC3AC] bg-[#F7F2E6] p-4">
        <div className="font-mono-num text-[11px] font-bold text-[#5E584B] mb-3">
          SETTLED SESSION LEDGER
        </div>
        {archive.length === 0 ? (
          <div className="font-mono-num text-xs text-[#8A8372]">
            NO SETTLED ROUNDS YET
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left font-mono-num text-xs">
              <thead>
                <tr className="border-b border-[#CDC3AC] text-[10px] text-[#8A8372]">
                  <th className="py-2 pr-3">SEED</th>
                  <th className="py-2 pr-3">MISSION</th>
                  <th className="py-2 pr-3">WINNERS</th>
                  <th className="py-2 pr-3">TURNS</th>
                  <th className="py-2 pr-3">NET PNL</th>
                  <th className="py-2">SETTLEMENT HASH</th>
                </tr>
              </thead>
              <tbody>
                {archive.map((r) => (
                  <tr key={r.roundId} className="border-b border-[#CDC3AC]/60 last:border-0">
                    <td className="py-2 pr-3 font-bold text-[#1A1915]">{r.seed}</td>
                    <td className="py-2 pr-3 text-[#5E584B]">{r.missionTitle}</td>
                    <td className="py-2 pr-3 text-[#1A1915]">
                      {r.winners.length === 0
                        ? "NONE"
                        : r.winners.map((w) => AGENT_PROFILES[w].callsign).join(", ")}
                    </td>
                    <td className="py-2 pr-3">{r.turnsTaken}</td>
                    <td
                      className={`py-2 pr-3 font-bold ${
                        r.userPnlCredits >= 0 ? "text-[#1F7A4D]" : "text-[#C22A1C]"
                      }`}
                    >
                      {r.userPnlCredits >= 0 ? "+" : ""}
                      {r.userPnlCredits.toFixed(2)} CR
                    </td>
                    <td className="py-2 text-[11px] text-[#8A8372] max-w-[180px] truncate">
                      {r.settlementHash}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

export function PortfolioView({ arena }: { arena: ArenaState }) {
  const [recipient, setRecipient] = useState("fiasco-demo.near");
  const [nearAmount, setNearAmount] = useState("1");
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteRes, setQuoteRes] = useState<{
    ok: boolean;
    status?: number;
    endpoint?: string;
    response?: unknown;
    error?: string;
  } | null>(null);

  const handleFetchQuote = async () => {
    setQuoteLoading(true);
    try {
      const yocto = (
        BigInt(Math.max(1, Math.round(Number(nearAmount) * 100))) *
        BigInt("10000000000000000000000")
      ).toString();
      const res = await fetch("/api/near/intents-quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          originAsset: "nep141:wrap.near",
          amount: yocto,
          recipient,
        }),
      });
      setQuoteRes(await res.json());
    } catch {
      setQuoteRes({ ok: false, error: "Request failed" });
    } finally {
      setQuoteLoading(false);
    }
  };

  const isSettled = arena.phase === "SETTLED";
  let totalExit = 0;
  let totalSettledPayout = 0;
  for (const id of AGENT_IDS) {
    const p = arena.positions[id];
    const m = arena.markets[id];
    totalSettledPayout += p.settledPayoutCredits;
    if (!isSettled) {
      if (p.yesShares > 0) {
        totalExit += quoteSellShares(m, "YES", p.yesShares).proceedsCredits;
      }
      if (p.noShares > 0) {
        totalExit += quoteSellShares(m, "NO", p.noShares).proceedsCredits;
      }
    }
  }
  const netRoundPnl = Number((arena.userCredits - arena.initialUserCredits).toFixed(2));

  return (
    <div className="space-y-6">
      {/* Unified 3-column Account Strip */}
      <div className="border border-[#CDC3AC] bg-[#F7F2E6] grid grid-cols-1 sm:grid-cols-3 divide-y sm:divide-y-0 sm:divide-x divide-[#CDC3AC] font-mono-num">
        <div className="p-4">
          <div className="text-[10px] text-[#8A8372]">AVAILABLE DEMO BALANCE</div>
          <div className="mt-1 text-2xl font-bold text-[#1A1915]">
            {arena.userCredits.toFixed(2)} CR
          </div>
          <div className="mt-1 text-[11px] text-[#5E584B]">
            OPENING {arena.initialUserCredits.toFixed(2)} CR
          </div>
        </div>

        <div className="p-4">
          <div className="text-[10px] text-[#8A8372]">
            {isSettled ? "SETTLED PAYOUT" : "MARK-TO-MARKET EXIT"}
          </div>
          <div className="mt-1 text-2xl font-bold text-[#1F7A4D]">
            {(isSettled ? totalSettledPayout : totalExit).toFixed(2)} CR
          </div>
          <div className="mt-1 text-[11px] text-[#5E584B]">
            {isSettled
              ? `NET PNL ${netRoundPnl >= 0 ? "+" : ""}${netRoundPnl.toFixed(2)} CR`
              : "EXECUTABLE AMM LIQUIDATION"}
          </div>
        </div>

        <div className="p-4">
          <div className="text-[10px] text-[#8A8372]">MAX WINNING PAYOUT</div>
          <div className="mt-1 text-2xl font-bold text-[#1A1915]">
            {AGENT_IDS.reduce((acc, id) => {
              const p = arena.positions[id];
              return acc + Math.max(p.yesShares, p.noShares) * PAYOUT_PER_SHARE;
            }, 0).toFixed(2)}{" "}
            CR
          </div>
          <div className="mt-1 text-[11px] text-[#5E584B]">
            {arena.trades.filter((t) => t.traderType === "user").length} USER ORDERS
          </div>
        </div>
      </div>

      {/* Positions Ledger */}
      <div className="border border-[#CDC3AC] bg-[#F7F2E6] p-4">
        <div className="font-mono-num text-[11px] font-bold text-[#5E584B] mb-3">
          POSITIONS / {arena.mission.seed}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left font-mono-num text-xs">
            <thead>
              <tr className="border-b border-[#CDC3AC] text-[10px] text-[#8A8372]">
                <th className="py-2 pr-3">AGENT</th>
                <th className="py-2 pr-3">YES SH</th>
                <th className="py-2 pr-3">NO SH</th>
                <th className="py-2 pr-3">YES MARK</th>
                <th className="py-2 pr-3">NET COST</th>
                <th className="py-2">SETTLEMENT</th>
              </tr>
            </thead>
            <tbody>
              {AGENT_IDS.map((id) => {
                const pos = arena.positions[id];
                const m = arena.markets[id];
                const profile = AGENT_PROFILES[id];
                return (
                  <tr key={id} className="border-b border-[#CDC3AC]/60 last:border-0">
                    <td className="py-2.5 pr-3 font-bold text-[#1A1915]">
                      {profile.name}
                    </td>
                    <td className="py-2.5 pr-3 text-[#1F7A4D]">
                      {pos.yesShares.toFixed(3)}
                    </td>
                    <td className="py-2.5 pr-3 text-[#C22A1C]">
                      {pos.noShares.toFixed(3)}
                    </td>
                    <td className="py-2.5 pr-3">{m.yesPrice.toFixed(1)}c</td>
                    <td className="py-2.5 pr-3">{pos.netCostCredits.toFixed(2)} CR</td>
                    <td className="py-2.5 font-bold">
                      {m.resolution
                        ? `${pos.settledPayoutCredits.toFixed(2)} CR (${m.resolution})`
                        : "OPEN"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* NEAR Intents 1Click Quote Preview */}
      <div className="border border-[#CDC3AC] bg-[#F7F2E6] p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2 font-mono-num">
          <span className="text-[11px] font-bold text-[#1A1915]">
            NEAR INTENTS 1CLICK QUOTE (wNEAR -&gt; USDT)
          </span>
          <span className="border border-[#CDC3AC] bg-[#EFE8D8] px-2 py-0.5 text-[10px] text-[#5E584B]">
            DRY-RUN QUOTE
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <input
            type="text"
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            className="border border-[#CDC3AC] bg-[#F7F2E6] px-3 py-2 font-mono-num text-xs text-[#1A1915]"
          />
          <input
            type="number"
            min="0.1"
            step="0.1"
            value={nearAmount}
            onChange={(e) => setNearAmount(e.target.value)}
            className="border border-[#CDC3AC] bg-[#F7F2E6] px-3 py-2 font-mono-num text-xs text-[#1A1915]"
          />
          <button
            type="button"
            onClick={handleFetchQuote}
            disabled={quoteLoading}
            className="border border-[#1A1915] bg-[#E6DDC8] px-4 py-2 font-mono-num text-xs font-bold text-[#1A1915] cursor-pointer disabled:opacity-40"
          >
            {quoteLoading ? "FETCHING..." : "FETCH 1CLICK QUOTE"}
          </button>
        </div>

        {quoteLoading && (
          <div className="h-24 border border-[#CDC3AC] bg-[#E6DDC8]" />
        )}

        {!quoteLoading && quoteRes && (
          <pre className="max-h-48 overflow-auto border border-[#CDC3AC] bg-[#EFE8D8] p-3 font-mono-num text-[11px] text-[#1A1915]">
            {JSON.stringify(quoteRes, null, 2)}
          </pre>
        )}
      </div>
    </div>
  );
}

export function AgentsView({ arena }: { arena: ArenaState }) {
  return (
    <div className="space-y-4">
      <div className="border-b border-[#CDC3AC] pb-3 flex items-center justify-between">
        <h2 className="font-display text-lg font-bold tracking-tight text-[#1A1915]">
          AGENT SPECIFICATIONS &amp; SAMPLE RECORDS
        </h2>
        <span className="font-mono-num text-[11px] text-[#5E584B]">
          DISCLOSED DIRECTIVES
        </span>
      </div>

      <div className="border border-[#CDC3AC] bg-[#F7F2E6] grid grid-cols-1 md:grid-cols-3 divide-y md:divide-y-0 md:divide-x divide-[#CDC3AC]">
        {AGENT_IDS.map((id) => {
          const p = AGENT_PROFILES[id];
          const live = arena.agents[id];
          const stdPct = Math.round(
            (p.record.standardWins / p.record.standardTotal) * 100
          );
          const hazPct = Math.round(
            (p.record.hazardWins / p.record.hazardTotal) * 100
          );
          return (
            <div key={id} className="p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span
                    className="h-2.5 w-2.5 inline-block"
                    style={{ backgroundColor: p.color }}
                  />
                  <h3 className="font-display text-base font-bold text-[#1A1915]">
                    {p.name}
                  </h3>
                </div>
                <span className="font-mono-num text-[11px] text-[#8A8372]">
                  {p.callsign}
                </span>
              </div>

              <div
                className="border border-[#CDC3AC] px-2.5 py-1 font-mono-num text-[11px] font-bold"
                style={{ backgroundColor: p.softBg, color: p.color }}
              >
                {p.strategyTitle}
              </div>

              <p className="text-xs text-[#5E584B] leading-relaxed">
                {p.strategySummary}
              </p>

              <div className="border border-[#CDC3AC] bg-[#EFE8D8] p-2.5 font-mono-num text-[11px]">
                <div className="text-[10px] text-[#8A8372] mb-1">DIRECTIVE</div>
                <p className="text-[#1A1915]">{p.disclosedPromptHint}</p>
              </div>

              <div className="grid grid-cols-2 gap-2 font-mono-num text-[11px]">
                <div className="border border-[#CDC3AC] bg-[#EFE8D8] p-2">
                  <div className="text-[10px] text-[#8A8372]">STANDARD</div>
                  <div className="font-bold text-[#1A1915]">
                    {p.record.standardWins}/{p.record.standardTotal} ({stdPct}%)
                  </div>
                </div>
                <div className="border border-[#CDC3AC] bg-[#EFE8D8] p-2">
                  <div className="text-[10px] text-[#8A8372]">HAZARD</div>
                  <div className="font-bold text-[#1A1915]">
                    {p.record.hazardWins}/{p.record.hazardTotal} ({hazPct}%)
                  </div>
                </div>
              </div>

              <div className="border-t border-[#CDC3AC] pt-2 flex items-center justify-between font-mono-num text-[10px] text-[#5E584B]">
                <span>AVG RESERVE {p.record.avgBatteryLeft} BAT</span>
                <span className="uppercase">{live.inferenceSource}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
