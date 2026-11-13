"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AGENT_PROFILES, MISSIONS } from "@/lib/sim/missions";
import { AGENT_IDS } from "@/lib/sim/engine";
import { SettledRoundArchive } from "@/lib/server/store";
import { soundEngine } from "@/lib/audio/synth";
import { AgentId, ArenaState, OutcomeSide } from "@/lib/types";
import { CityStage } from "./CityStage";
import { EventProbabilityChart } from "./EventProbabilityChart";
import { LowerTabs } from "./LowerTabs";
import { AgentsView, DiscoverView, PortfolioView } from "./SecondaryViews";
import { AGENT_INK, AGENT_NUM, BetSlip, PuntersBoard, RacerBoard, money } from "./Tote";
import { ChainLedger } from "./ChainLedger";
import {
  GlyphAudio,
  GlyphClose,
  GlyphExternal,
  GlyphFastForward,
  GlyphPause,
  GlyphPlay,
  GlyphReset,
  GlyphStep,
} from "./Glyphs";

type ViewTab = "arena" | "discover" | "ledger" | "agents";

type Props = {
  initialArena: ArenaState;
  initialArchive: SettledRoundArchive[];
};

type Banner = { id: string; text: string; sub: string; tone: "warn" | "ink" | "yes" };

const NAV: { id: ViewTab; label: string }[] = [
  { id: "arena", label: "PLAY" },
  { id: "discover", label: "MISSIONS" },
  { id: "ledger", label: "LEDGER" },
  { id: "agents", label: "COURIERS" },
];

export function FiascoApp({ initialArena, initialArchive }: Props) {
  const [arena, setArena] = useState<ArenaState>(initialArena);
  const [archive, setArchive] = useState<SettledRoundArchive[]>(initialArchive);
  const [view, setView] = useState<ViewTab>("arena");
  const [selectedAgent, setSelectedAgent] = useState<AgentId>("vanguard");
  const [focusAgent, setFocusAgent] = useState<AgentId | "all">("all");
  const [inspectedTurn, setInspectedTurn] = useState<number | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tradeError, setTradeError] = useState<string | null>(null);
  const [banner, setBanner] = useState<Banner | null>(null);
  const [resultsFor, setResultsFor] = useState<string | null>(null);
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    if (!busy) {
      setSlow(false);
      return;
    }
    const t = setTimeout(() => setSlow(true), 900);
    return () => clearTimeout(t);
  }, [busy]);

  const [walletModalOpen, setWalletModalOpen] = useState(false);

  const prevEventCountRef = useRef(initialArena.events.length);
  const prevTurnRef = useRef(initialArena.turn);
  const prevRoundRef = useRef(initialArena.roundId);
  const mutedRef = useRef(muted);
  mutedRef.current = muted;

  useEffect(() => {
    if (localStorage.getItem("fiasco_muted") === "1") setMuted(true);

    // Web Audio needs a user gesture before it may start
    const arm = () => {
      soundEngine.setEnabled(!mutedRef.current);
      window.removeEventListener("pointerdown", arm);
      window.removeEventListener("keydown", arm);
    };
    window.addEventListener("pointerdown", arm);
    window.addEventListener("keydown", arm);
    return () => {
      window.removeEventListener("pointerdown", arm);
      window.removeEventListener("keydown", arm);
    };
  }, []);

  // sound + on-stage calls for new events
  useEffect(() => {
    if (arena.roundId !== prevRoundRef.current) {
      prevRoundRef.current = arena.roundId;
      prevEventCountRef.current = arena.events.length;
      prevTurnRef.current = arena.turn;
      setBanner(null);
      return;
    }

    if (arena.events.length > prevEventCountRef.current) {
      const latest = arena.events.slice(prevEventCountRef.current);
      const hazard = latest.find((e) => e.type === "hazard");
      const finish = latest.find((e) => e.type === "finish");
      const failure = latest.find((e) => e.type === "failure");
      const settled = arena.phase === "SETTLED";
      const checkpoint =
        (arena.phase === "CHECKPOINT_1" || arena.phase === "CHECKPOINT_2") &&
        latest.some((e) => e.type === "checkpoint");

      if (hazard) {
        soundEngine.playHazardAlert();
        setBanner({
          id: hazard.id,
          text: "ROAD CLOSED",
          sub: hazard.title.replace(/^Closure:\s*/i, ""),
          tone: "warn",
        });
      } else if (settled) {
        soundEngine.playSettlement(AGENT_IDS.some((id) => arena.agents[id].status === "completed"));
      } else if (checkpoint) {
        soundEngine.playCheckpointOpen();
        setBanner({
          id: `cp-${arena.turn}`,
          text: "BETTING OPEN",
          sub: arena.phase === "CHECKPOINT_2" ? "Last window" : `Turn ${arena.turn}`,
          tone: "ink",
        });
      } else if (finish && finish.agentId) {
        soundEngine.playSettlement(true);
        setBanner({
          id: finish.id,
          text: `${AGENT_PROFILES[finish.agentId].name} FINISHED`,
          sub: `Turn ${finish.turn}`,
          tone: "yes",
        });
      } else if (failure && failure.agentId) {
        soundEngine.playSettlement(false);
        setBanner({
          id: failure.id,
          text: `${AGENT_PROFILES[failure.agentId].name} IS OUT`,
          sub: failure.title.includes("timed") ? "Out of time" : "Out of power",
          tone: "warn",
        });
      } else if (latest.some((e) => e.type === "delivery")) {
        soundEngine.playDeliveryPing();
      } else if (latest.some((e) => e.type === "charge")) {
        soundEngine.playChargeHum();
      }
    } else if (arena.turn > prevTurnRef.current) {
      soundEngine.playStepTick();
    }

    prevEventCountRef.current = arena.events.length;
    prevTurnRef.current = arena.turn;
  }, [arena]);

  const applyArena = useCallback((next: ArenaState) => {
    setArena(next);
    if (
      next.phase === "CHECKPOINT_1" ||
      next.phase === "CHECKPOINT_2" ||
      next.phase === "SETTLED"
    ) {
      setIsPlaying(false);
    }
  }, []);

  useEffect(() => {
    const es = new EventSource("/api/arena/stream");
    es.onmessage = (msg) => {
      try {
        const parsed = JSON.parse(msg.data) as {
          arena?: ArenaState;
          archive?: SettledRoundArchive[];
        };
        if (parsed.arena) applyArena(parsed.arena);
        if (parsed.archive) setArchive(parsed.archive);
      } catch {
        // keepalive
      }
    };
    return () => es.close();
  }, [applyArena]);

  const stepRound = useCallback(
    async (mode: "step" | "phase") => {
      setBusy(true);
      setTradeError(null);
      try {
        const res = await fetch("/api/arena/step", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode }),
        });
        const data = await res.json();
        if (data.arena) {
          applyArena(data.arena);
          if (data.archive) setArchive(data.archive);
          setInspectedTurn(null);
        }
      } finally {
        setBusy(false);
      }
    },
    [applyArena]
  );

  useEffect(() => {
    if (!isPlaying) return;
    if (arena.phase === "SETTLED") {
      setIsPlaying(false);
      return;
    }
    const timer = setTimeout(() => {
      if (!busy) void stepRound("step");
    }, 560);
    return () => clearTimeout(timer);
  }, [isPlaying, busy, arena.phase, arena.turn, stepRound]);

  const handleTrade = async (params: {
    agentId: AgentId;
    action: "BUY" | "SELL";
    side: OutcomeSide;
    amount: number;
  }) => {
    setBusy(true);
    setTradeError(null);
    try {
      const res = await fetch("/api/arena/trade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
      });
      const data = await res.json();
      if (!res.ok) {
        setTradeError(data.error || "Bet rejected");
      } else if (data.arena) {
        setArena(data.arena);
        soundEngine.playTradeFill(params.action === "BUY" ? "YES" : "NO");
      }
    } catch {
      setTradeError("Bet failed to send");
    } finally {
      setBusy(false);
    }
  };

  const handleReset = async (missionId?: string) => {
    setIsPlaying(false);
    setBusy(true);
    setTradeError(null);
    try {
      const res = await fetch("/api/arena/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ missionId }),
      });
      const data = await res.json();
      if (data.arena) {
        setArena(data.arena);
        if (data.archive) setArchive(data.archive);
        setInspectedTurn(null);
        setFocusAgent("all");
        setView("arena");
      }
    } finally {
      setBusy(false);
    }
  };

  const toggleMute = () => {
    const next = !muted;
    setMuted(next);
    localStorage.setItem("fiasco_muted", next ? "1" : "0");
    soundEngine.setEnabled(!next);
    if (!next) soundEngine.playCheckpointOpen();
  };

  const settled = arena.phase === "SETTLED";
  const isCheckpoint = arena.phase === "CHECKPOINT_1" || arena.phase === "CHECKPOINT_2";
  const inspecting = inspectedTurn !== null && inspectedTurn < arena.turn;

  const togglePlay = useCallback(() => {
    if (settled) return;
    setInspectedTurn(null);
    setIsPlaying((p) => !p);
  }, [settled]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && /INPUT|TEXTAREA|SELECT|BUTTON/.test(el.tagName)) return;
      if (e.code === "Space" && view === "arena") {
        e.preventDefault();
        togglePlay();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePlay, view]);

  const activeSnapshot = inspecting
    ? arena.history.find((h) => h.turn === inspectedTurn) ?? arena.history[arena.history.length - 1]
    : arena.history[arena.history.length - 1];
  const displayedAgents = activeSnapshot ? activeSnapshot.agents : arena.agents;
  const displayedHazards = activeSnapshot ? activeSnapshot.activeHazards : arena.activeHazards;
  const shownTurn = inspecting ? (inspectedTurn as number) : arena.turn;

  const pnl = arena.userCredits - arena.initialUserCredits;
  const showResults = settled && resultsFor !== arena.roundId && view === "arena";
  const receipt = arena.evidence.nearContractSpec.receipts.find((r) => r.method.includes("settle"));
  const missionIdx = MISSIONS.findIndex((m) => m.id === arena.mission.id);
  const nextMission = MISSIONS[(missionIdx + 1) % MISSIONS.length];
  const lastEvent = [...arena.events].reverse().find((e) => e.turn > 0 && e.type !== "checkpoint");

  const hazardTurns = new Set(arena.mission.scheduledHazards.map((h) => h.triggerTurn));
  const cpTurns = new Set<number>(arena.mission.checkpoints);

  return (
    <div className="min-h-screen lg:h-screen flex flex-col bg-[#EFE8D8] text-[#1A1915]">
      <header className="shrink-0 bg-[#1A1915] text-[#F7F2E6]">
        <div className="h-12 px-3 sm:px-4 flex items-center justify-between gap-3">
          <div className="flex items-center gap-4 min-w-0">
            <button
              type="button"
              onClick={() => setView("arena")}
              className="font-display text-2xl font-extrabold leading-none tracking-wide"
            >
              FIAS<span className="text-[#E2A400]">CO</span>
            </button>
            <nav className="hidden sm:flex items-stretch h-12">
              {NAV.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setView(item.id)}
                  className={`px-3 font-display text-lg font-bold leading-none ${
                    view === item.id ? "bg-[#F7F2E6] text-[#1A1915]" : "text-[#B5AB93]"
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </nav>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setWalletModalOpen(true)}
              className="hidden md:flex items-center gap-2 border border-[#5E584B] px-2 py-1 font-mono-num text-[11px] text-[#E2A400]"
            >
              {arena.chain.enabled ? (
                <>
                  {arena.chain.pendingOps > 0 && <span className="skeleton h-2 w-4" />}
                  NEAR / {arena.chain.confirmedOps} WRITES
                </>
              ) : (
                "LOCAL LEDGER"
              )}
            </button>
            <button
              type="button"
              onClick={toggleMute}
              aria-label={muted ? "Turn sound on" : "Turn sound off"}
              className="border border-[#5E584B] p-1.5"
            >
              <GlyphAudio muted={muted} className="h-4 w-4" />
            </button>
            <div className="bg-[#E2A400] text-[#1A1915] px-2.5 py-1 font-display text-2xl font-extrabold leading-none tnum">
              {money(arena.userCredits)}
            </div>
          </div>
        </div>
        <nav className="sm:hidden flex border-t border-[#5E584B]">
          {NAV.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setView(item.id)}
              className={`flex-1 py-2 font-display text-base font-bold leading-none ${
                view === item.id ? "bg-[#F7F2E6] text-[#1A1915]" : "text-[#B5AB93]"
              }`}
            >
              {item.label}
            </button>
          ))}
        </nav>
      </header>

      {view === "arena" && (
        <main className="flex-1 min-h-0 flex flex-col lg:flex-row">
          <section className="relative flex-1 min-h-0 flex flex-col">
            <div className="relative flex-1 min-h-[52vh] lg:min-h-0">
              <CityStage
                mission={arena.mission}
                roundId={arena.roundId}
                agents={displayedAgents}
                activeHazards={displayedHazards}
                focusAgent={focusAgent}
                live={!inspecting}
              />

              <div className="pointer-events-none absolute left-3 top-3 sm:left-5 sm:top-4 max-w-[70%]">
                <div className="font-mono-num text-[11px] font-semibold text-[#5E584B]">
                  {arena.mission.seed} / {arena.mission.difficulty.toUpperCase()}
                  {arena.seed.source === "near-block" && ` / BLOCK ${arena.seed.blockHeight}`}
                </div>
                <h1 className="font-display text-3xl sm:text-5xl font-extrabold leading-[0.9] uppercase">
                  {arena.mission.title}
                </h1>
                {lastEvent && (
                  <div
                    key={lastEvent.id}
                    className="anim-rise mt-2 inline-block bg-[#1A1915] px-2 py-1 font-display text-base font-bold leading-none text-[#F7F2E6] uppercase"
                  >
                    T{lastEvent.turn} {lastEvent.title}
                  </div>
                )}
              </div>

              <div className="pointer-events-none absolute inset-x-0 top-0 flex justify-center overflow-hidden h-28">
                {banner && (
                  <div
                    key={banner.id}
                    className={`anim-slam mt-16 sm:mt-4 h-fit px-5 py-2 text-center ${
                      banner.tone === "warn"
                        ? "bg-[#E2A400] text-[#1A1915]"
                        : banner.tone === "yes"
                        ? "bg-[#1F7A4D] text-[#F7F2E6]"
                        : "bg-[#1A1915] text-[#F7F2E6]"
                    }`}
                  >
                    <div className="font-display text-4xl sm:text-5xl font-extrabold leading-none uppercase">
                      {banner.text}
                    </div>
                    <div className="font-display text-lg font-bold leading-none uppercase mt-1">
                      {banner.sub}
                    </div>
                  </div>
                )}
              </div>

              {slow && (
                <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center">
                  <div className="bg-[#1A1915] px-4 py-2 flex items-center gap-3 font-display text-xl font-bold leading-none text-[#F7F2E6]">
                    <span className="skeleton h-3 w-16" />
                    SYNCING
                  </div>
                </div>
              )}

              {inspecting && (
                <button
                  type="button"
                  onClick={() => setInspectedTurn(null)}
                  className="absolute right-3 top-3 bg-[#E2A400] px-3 py-1.5 font-display text-lg font-bold leading-none"
                >
                  REPLAY T{inspectedTurn} / BACK TO LIVE
                </button>
              )}

              {showResults && (
                <div className="absolute inset-0 flex items-center justify-center p-4 bg-[#EFE8D8]/85">
                  <div className="anim-rise w-full max-w-md border-2 border-[#1A1915] bg-[#F7F2E6]">
                    <div className="flex items-center justify-between bg-[#1A1915] px-4 py-2 text-[#F7F2E6]">
                      <span className="font-display text-2xl font-extrabold leading-none">
                        ROUND SETTLED
                      </span>
                      <button
                        type="button"
                        aria-label="Close results"
                        onClick={() => setResultsFor(arena.roundId)}
                      >
                        <GlyphClose className="h-5 w-5" />
                      </button>
                    </div>
                    <div
                      className={`px-4 pt-4 pb-3 font-display font-extrabold leading-none tnum text-7xl ${
                        pnl > 0.005 ? "text-[#1F7A4D]" : pnl < -0.005 ? "text-[#C22A1C]" : ""
                      }`}
                    >
                      {pnl >= 0 ? "+" : "-"}
                      {money(Math.abs(pnl))}
                    </div>
                    <div className="border-y-2 border-[#1A1915] divide-y divide-[#CDC3AC]">
                      {AGENT_IDS.map((id) => {
                        const st = arena.agents[id];
                        const won = st.status === "completed";
                        const pos = arena.positions[id];
                        return (
                          <div key={id} className="flex items-stretch">
                            <span
                              className="w-10 flex items-center justify-center font-display text-2xl font-extrabold"
                              style={{
                                backgroundColor: AGENT_PROFILES[id].color,
                                color: AGENT_INK[id],
                              }}
                            >
                              {AGENT_NUM[id]}
                            </span>
                            <div className="flex-1 px-3 py-2 flex items-center justify-between font-display text-xl font-bold leading-none">
                              <span className={won ? "text-[#1F7A4D]" : "text-[#C22A1C]"}>
                                {won
                                  ? `FINISHED T${st.finishedTurn}`
                                  : st.status === "failed_timeout"
                                  ? "OUT OF TIME"
                                  : "OUT OF POWER"}
                              </span>
                              <span className="tnum">
                                {pos.netCostCredits > 0 || pos.settledPayoutCredits > 0
                                  ? money(pos.settledPayoutCredits)
                                  : ""}
                              </span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    <div className="p-3 space-y-2">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => handleReset(nextMission.id)}
                        className="w-full bg-[#1A1915] px-3 py-3 font-display text-2xl font-extrabold leading-none text-[#F7F2E6] uppercase"
                      >
                        NEXT: {nextMission.title}
                      </button>
                      <div className="flex items-center justify-between font-mono-num text-[11px]">
                        {receipt ? (
                          <a
                            href={receipt.explorerUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 underline"
                          >
                            {receipt.method} {receipt.txHash.slice(0, 10)}
                            <GlyphExternal className="h-3 w-3" />
                          </a>
                        ) : (
                          <span className="inline-flex items-center gap-2 text-[#5E584B]">
                            <span className="skeleton h-2.5 w-12" />
                            {arena.evidence.settlementHash.slice(0, 14)}
                          </span>
                        )}
                        <button type="button" className="underline" onClick={() => setView("ledger")}>
                          PROOF
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* control deck */}
            <div className="shrink-0 border-t-2 border-[#1A1915] bg-[#F7F2E6] flex items-stretch">
              <div className="shrink-0 px-3 flex items-baseline gap-1 self-center font-display font-extrabold leading-none tnum">
                <span className="text-5xl">{String(shownTurn).padStart(2, "0")}</span>
                <span className="text-xl text-[#8A8372]">/{arena.mission.maxTurns}</span>
              </div>

              <div className="flex-1 min-w-0 flex items-stretch gap-px py-2.5 pr-3">
                {Array.from({ length: arena.mission.maxTurns }).map((_, i) => {
                  const t = i + 1;
                  const done = t <= arena.turn;
                  const isCp = cpTurns.has(t);
                  const isHz = hazardTurns.has(t);
                  return (
                    <button
                      key={t}
                      type="button"
                      aria-label={`Turn ${t}`}
                      disabled={!done}
                      onClick={() => setInspectedTurn(t === arena.turn ? null : t)}
                      className="relative flex-1 min-w-0"
                      style={{
                        backgroundColor: done
                          ? t === shownTurn
                            ? "#E2A400"
                            : "#1A1915"
                          : isHz
                          ? "#E2A400"
                          : "#CDC3AC",
                        opacity: !done && isHz ? 0.55 : 1,
                      }}
                    >
                      {isCp && (
                        <span className="absolute -top-2.5 -bottom-2.5 right-0 w-0.5 bg-[#1A1915]" />
                      )}
                    </button>
                  );
                })}
              </div>

              <div className="shrink-0 flex items-stretch border-l-2 border-[#1A1915]">
                <button
                  type="button"
                  aria-label="Advance one turn"
                  disabled={busy || isPlaying || settled}
                  onClick={() => stepRound("step")}
                  className="hidden sm:flex px-3 items-center border-r-2 border-[#1A1915] disabled:text-[#B5AB93]"
                >
                  <GlyphStep className="h-5 w-5" />
                </button>
                <button
                  type="button"
                  aria-label="Skip to next betting window"
                  disabled={busy || isPlaying || settled}
                  onClick={() => stepRound("phase")}
                  className="hidden sm:flex px-3 items-center border-r-2 border-[#1A1915] disabled:text-[#B5AB93]"
                >
                  <GlyphFastForward className="h-5 w-5" />
                </button>
                <button
                  type="button"
                  aria-label="Restart round"
                  disabled={busy}
                  onClick={() => handleReset(arena.mission.id)}
                  className="px-3 flex items-center border-r-2 border-[#1A1915] disabled:text-[#B5AB93]"
                >
                  <GlyphReset className="h-5 w-5" />
                </button>
                {settled ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => handleReset(nextMission.id)}
                    className="w-40 sm:w-48 bg-[#1A1915] text-[#F7F2E6] font-display text-2xl font-extrabold leading-none"
                  >
                    NEXT RUN
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={togglePlay}
                    className={`w-40 sm:w-48 flex items-center justify-center gap-2 font-display text-2xl font-extrabold leading-none ${
                      isPlaying ? "bg-[#E2A400] text-[#1A1915]" : "bg-[#1A1915] text-[#F7F2E6]"
                    }`}
                  >
                    {isPlaying ? (
                      <>
                        <GlyphPause className="h-5 w-5" />
                        PAUSE
                      </>
                    ) : (
                      <>
                        <GlyphPlay className="h-5 w-5" />
                        {arena.turn === 0 ? "START RUN" : isCheckpoint ? "RESUME" : "RUN"}
                      </>
                    )}
                  </button>
                )}
              </div>
            </div>
          </section>

          <aside className="lg:w-[400px] shrink-0 border-t-2 lg:border-t-0 lg:border-l-2 border-[#1A1915] bg-[#F7F2E6] flex flex-col lg:overflow-y-auto">
            <RacerBoard
              arena={arena}
              agents={displayedAgents}
              selected={selectedAgent}
              onSelect={setSelectedAgent}
              focus={focusAgent}
              onFocus={setFocusAgent}
            />
            <BetSlip
              arena={arena}
              selected={selectedAgent}
              onTrade={handleTrade}
              busy={busy}
              error={tradeError}
            />
            <PuntersBoard arena={arena} />
            <div className="mt-auto px-3 py-2 flex items-center justify-between font-mono-num text-[10px] text-[#8A8372]">
              <Link href="/terms" className="underline">
                TERMS
              </Link>
              <span>TEST CHIPS / NEAR TESTNET</span>
              <Link href="/privacy" className="underline">
                PRIVACY
              </Link>
            </div>
          </aside>
        </main>
      )}

      {view !== "arena" && (
        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[1200px] px-4 sm:px-6 py-6 space-y-4">
            {view === "discover" && (
              <DiscoverView
                arena={arena}
                archive={archive}
                onLoadMission={handleReset}
                loading={busy}
              />
            )}
            {view === "ledger" && (
              <>
                <EventProbabilityChart
                  mission={arena.mission}
                  history={arena.history}
                  events={arena.events}
                  inspectedTurn={inspectedTurn}
                  onSelectTurn={(t) => setInspectedTurn(t)}
                />
                <LowerTabs
                  arena={arena}
                  inspectedTurn={inspectedTurn}
                  onSelectTurn={(t) => setInspectedTurn(t)}
                  onReturnToLive={() => setInspectedTurn(null)}
                />
                <PortfolioView arena={arena} />
              </>
            )}
            {view === "agents" && <AgentsView arena={arena} />}
            <footer className="pt-4 flex items-center justify-between font-mono-num text-[11px] text-[#8A8372]">
              <Link href="/terms" className="underline">
                TERMS OF SERVICE
              </Link>
              <Link href="/privacy" className="underline">
                PRIVACY POLICY
              </Link>
            </footer>
          </div>
        </main>
      )}

      {walletModalOpen && (
        <div className="fixed inset-0 z-50 bg-[#1A1915]/60 flex items-center justify-center p-4">
          <div className="w-full max-w-4xl max-h-[88vh] flex flex-col border-2 border-[#1A1915] bg-[#F7F2E6]">
            <div className="shrink-0 flex items-center justify-between bg-[#1A1915] px-4 py-2 text-[#F7F2E6]">
              <span className="font-display text-2xl font-extrabold leading-none">ON NEAR</span>
              <button type="button" aria-label="Close" onClick={() => setWalletModalOpen(false)}>
                <GlyphClose className="h-5 w-5" />
              </button>
            </div>
            <div className="p-4 overflow-y-auto">
              <ChainLedger arena={arena} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
