"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { CityStage, FilmCam, FilmControl, cellToWorld } from "./CityStage";
import { AGENT_INK, AGENT_NUM, BetSlip, PuntersBoard, RacerBoard, money } from "./Tote";
import { GlyphAudio, GlyphFastForward, GlyphPause, GlyphPlay, GlyphReset, GlyphStep } from "./Glyphs";
import {
  buildFilm,
  COURIER_CARDS,
  courierLine,
  CURSOR,
  DURATION,
  FPS,
  SeedBlock,
} from "@/film/timeline";
import { AGENT_IDS } from "@/lib/sim/engine";
import { AGENT_PROFILES } from "@/lib/sim/missions";
import { AgentId, ArenaState, Coord } from "@/lib/types";

type Props = {
  blocks: SeedBlock[];
  punterBanks?: number[];
  ledger?: { contractId: string; rounds: number; bets: number; stakedCents: number } | null;
  playUrl?: string;
};

type V3 = [number, number, number];

const INK = "#1A1915";
const PAPER = "#EFE8D8";
const CARD = "#F7F2E6";
const GOLD = "#E2A400";
const GREEN = "#1F7A4D";
const RED = "#C22A1C";

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const ease = (x: number) => {
  const u = clamp01(x);
  return u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
};
const easeOut = (x: number) => 1 - Math.pow(1 - clamp01(x), 3);
const lerp = (a: number, b: number, u: number) => a + (b - a) * u;
const lerp3 = (a: V3, b: V3, u: number): V3 => [lerp(a[0], b[0], u), lerp(a[1], b[1], u), lerp(a[2], b[2], u)];
/** 0 before `a`, 1 after `b`. */
const span = (t: number, a: number, b: number) => clamp01((t - a) / (b - a));
/** Visible between a and b, with eased entry and exit. */
const window01 = (t: number, a: number, b: number, inDur = 0.28, outDur = 0.22) =>
  Math.min(easeOut(span(t, a, a + inDur)), 1 - easeOut(span(t, b - outDur, b)));

type Mode = "cine" | "title" | "hud" | "end";
const modeAt = (t: number): Mode =>
  t < 30 ? "cine" : t < 35.75 ? "title" : t < 62 ? "hud" : t < 81 ? "cine" : "end";

const ZOOM_KEYS: { t: number; s: number; x: number; y: number }[] = [
  { t: 36.0, s: 1, x: 960, y: 540 },
  { t: 37.5, s: 1, x: 960, y: 540 },
  { t: 38.5, s: 1.6, x: 1640, y: 330 },
  { t: 43.3, s: 1.6, x: 1640, y: 330 },
  { t: 44.4, s: 1.9, x: 1700, y: 540 },
  { t: 50.4, s: 1.9, x: 1700, y: 540 },
  { t: 51.6, s: 1, x: 960, y: 540 },
  { t: 58.8, s: 1, x: 960, y: 540 },
  { t: 59.7, s: 1.55, x: 1650, y: 520 },
  { t: 61.3, s: 1.55, x: 1650, y: 520 },
  { t: 62.0, s: 1, x: 960, y: 540 },
];

function zoomAt(t: number): string {
  let a = ZOOM_KEYS[0];
  let b = ZOOM_KEYS[ZOOM_KEYS.length - 1];
  for (let i = 0; i < ZOOM_KEYS.length - 1; i++) {
    if (t >= ZOOM_KEYS[i].t && t <= ZOOM_KEYS[i + 1].t) {
      a = ZOOM_KEYS[i];
      b = ZOOM_KEYS[i + 1];
      break;
    }
  }
  if (t <= ZOOM_KEYS[0].t) b = a;
  if (t >= b.t) a = b;
  const u = a === b ? 0 : ease((t - a.t) / (b.t - a.t));
  const s = lerp(a.s, b.s, u);
  const fx = lerp(a.x, b.x, u);
  const fy = lerp(a.y, b.y, u);
  const tx = Math.max(1920 - 1920 * s, Math.min(0, 960 - fx * s));
  const ty = Math.max(1080 - 1080 * s, Math.min(0, 540 - fy * s));
  return `translate(${tx.toFixed(2)}px, ${ty.toFixed(2)}px) scale(${s.toFixed(4)})`;
}

const CAPTIONS: { from: number; to: number; text: string }[] = [
  { from: 37.0, to: 38.8, text: "PICK A COURIER" },
  { from: 38.9, to: 39.85, text: "CALL IT" },
  { from: 39.9, to: 43.2, text: "PUT YOUR CHIPS DOWN" },
  { from: 44.7, to: 51.4, text: "EVERY BET MOVES THE ODDS" },
  { from: 54.4, to: 58.5, text: "WATCH THE RUN" },
  { from: 59.6, to: 61.9, text: "DOUBLE DOWN" },
];

const LEDGER_ROWS = [
  { op: "PUBLISH", text: "ROUND + SEED" },
  { op: "BET", text: "100 ON 3 TO FINISH" },
  { op: "BET", text: "MAKO 180 ON 3" },
  { op: "LOCK", text: "RUN STARTED" },
  { op: "BET", text: "250 ON 3 TO FINISH" },
  { op: "SETTLE", text: "WINNERS PAID" },
];

function Word({
  t,
  from,
  to,
  children,
  size = 150,
  bg = INK,
  fg = CARD,
}: {
  t: number;
  from: number;
  to: number;
  children: React.ReactNode;
  size?: number;
  bg?: string;
  fg?: string;
}) {
  if (t < from || t > to) return null;
  const k = window01(t, from, to, 0.24, 0.18);
  return (
    <div style={{ overflow: "hidden", display: "inline-block" }}>
      <div
        className="font-display"
        style={{
          transform: `translateY(${((1 - k) * 110).toFixed(2)}%)`,
          background: bg,
          color: fg,
          fontSize: size,
          fontWeight: 800,
          lineHeight: 0.92,
          padding: `${size * 0.08}px ${size * 0.2}px ${size * 0.12}px`,
          letterSpacing: "0.01em",
          whiteSpace: "nowrap",
        }}
      >
        {children}
      </div>
    </div>
  );
}

export function FilmApp({ blocks, punterBanks, ledger, playUrl }: Props) {
  const film = useMemo(() => buildFilm(blocks, punterBanks), [blocks, punterBanks]);
  const [t, setT] = useState(0);
  const tRef = useRef(0);
  const cursorRef = useRef<HTMLDivElement | null>(null);
  const ringRef = useRef<HTMLDivElement | null>(null);
  const cursorPos = useRef({ x: 1300, y: 640 });
  const camState = useRef<{ shot: number; pos: V3; target: V3 }>({ shot: -1, pos: [0, 0, 0], target: [0, 0, 0] });
  const credits = useRef({ shown: 1000, from: 1000, to: 1000, at: 0 });

  const ctl = useRef<FilmControl>({
    manual: true,
    cam: null,
    hideTags: true,
    timeScale: 1,
    rovers: {
      vanguard: { x: 0, z: 0, heading: 0 },
      gridwise: { x: 0, z: 0, heading: 0 },
      pivot: { x: 0, z: 0, heading: 0 },
    },
  }).current;

  const arenaAt = (time: number): ArenaState => {
    let cur = film.beats[0].arena;
    for (const b of film.beats) {
      if (b.t <= time) cur = b.arena;
      else break;
    }
    return cur;
  };

  // ------------------------------------------------------------ camera
  const direct = (time: number): FilmCam | null => {
    if (modeAt(time) === "hud") return null;
    const arena = arenaAt(time);
    const m = arena.mission;
    const W = (c: Coord): { x: number; z: number } => cellToWorld(c, m);
    const rv = (id: AgentId) => ctl.rovers[id];
    const st = camState.current;
    const smooth = (shot: number, pos: V3, target: V3, k: number): { pos: V3; target: V3 } => {
      if (st.shot !== shot) {
        st.shot = shot;
        st.pos = pos;
        st.target = target;
      } else {
        st.pos = lerp3(st.pos, pos, k);
        st.target = lerp3(st.target, target, k);
      }
      return { pos: st.pos, target: st.target };
    };
    const orbit = (angle: number, radius: number, height: number, centre: V3): V3 => [
      centre[0] + Math.cos(angle) * radius,
      height,
      centre[2] + Math.sin(angle) * radius,
    ];
    const hazards = [...m.scheduledHazards].sort((a, b) => a.triggerTurn - b.triggerTurn);

    if (time < 6) {
      const s = W(m.startCoord);
      const u = ease(span(time, 0, 6));
      return {
        pos: lerp3([s.x + 4.4, 0.75, s.z + 0.7], [s.x + 3.4, 0.95, s.z + 0.45], u),
        target: [s.x - 0.1, 0.48, s.z],
        fov: 30,
      };
    }
    if (time < 8.4) {
      const s = W(m.startCoord);
      const u = ease(span(time, 6, 8.4));
      return {
        pos: lerp3([s.x + 3.4, 0.95, s.z + 0.45], [-4, 12.5, 17.5], u),
        target: lerp3([s.x - 0.1, 0.48, s.z], [0, 0.2, 0.4], u),
        fov: lerp(30, 36, u),
      };
    }
    if (time < 12) {
      const idx = COURIER_CARDS.findIndex((c) => time >= c.from && time < c.to);
      const card = COURIER_CARDS[Math.max(0, idx)];
      const r = rv(card.id);
      const u = span(time, card.from, card.to);
      const a = 0.3 + idx * 0.28 + u * 0.2;
      const rx = Math.sin(a);
      const rz = -Math.cos(a);
      return {
        pos: [r.x + Math.cos(a) * 4.3 - rx * 0.75, 1.4, r.z + Math.sin(a) * 4.3 - rz * 0.75],
        target: [r.x - rx * 0.75, 0.45, r.z - rz * 0.75],
        fov: 26,
      };
    }
    if (time < 14.2) {
      const r = rv("vanguard");
      const dx = Math.sin(r.heading);
      const dz = Math.cos(r.heading);
      const c = smooth(
        1,
        [r.x - dx * 3.9, 1.9, r.z - dz * 3.9],
        [r.x + dx * 1.3, 0.5, r.z + dz * 1.3],
        0.11
      );
      return { ...c, fov: 38 };
    }
    if (time < 16) {
      const c = W(hazards[0].coord);
      const u = ease(span(time, 14.2, 16));
      return {
        pos: [c.x + 4.5 - u * 0.5, 1.15, c.z + 1.45],
        target: [c.x, 0.75, c.z],
        fov: 30,
      };
    }
    if (time < 18.8) {
      const c = W((hazards[1] ?? hazards[0]).coord);
      const u = ease(span(time, 16, 18.8));
      return {
        pos: lerp3([c.x - 7.5, 11.5, c.z + 10.5], [c.x - 5, 8.2, c.z + 7.6], u),
        target: [c.x - 1.2, 0.3, c.z],
        fov: 34,
      };
    }
    if (time < 22) {
      const r = rv("vanguard");
      const c = smooth(2, [r.x + 3.1, 1.75, r.z + 3.6], [r.x, 0.45, r.z], 0.3);
      return { ...c, fov: 28 };
    }
    if (time < 24) {
      const u = span(time, 22, 24);
      return { pos: orbit(0.95 + u * 0.22, 17, 6.5, [0, 0, 0]), target: [0, 0.5, 0], fov: 34 };
    }
    if (time < 30) {
      const u = span(time, 24, 30);
      return {
        pos: orbit(2.15 + u * 0.55, 19 - u * 4, 8 - u * 2.6, [0, 0, 0]),
        target: [0, 0.4, 0],
        fov: 34,
      };
    }
    if (time < 62) return null;
    if (time < 68) {
      const i = Math.min(3, Math.floor((time - 62) / 1.5));
      const u = ease(span(time, 62 + i * 1.5, 63.5 + i * 1.5));
      return { pos: [0, 24 - u * 1.8, 10.5 - u * 0.8], target: [0, 0, 0.9], fov: 34 };
    }
    if (time < 74) {
      const u = span(time, 68, 74);
      const a = 0.85 + u * 0.4;
      const right: V3 = [Math.sin(a), 0, -Math.cos(a)];
      const target: V3 = [right[0] * -4.6, 0.4, right[2] * -4.6];
      return { pos: orbit(a, 16, 6.2, target), target, fov: 34 };
    }
    if (time < 77) {
      const r = rv("pivot");
      const u = span(time, 74, 77);
      const a = 3.5 + u * 1.0;
      const c = smooth(3, [r.x + Math.cos(a) * 5.2, 2.7 + u * 0.6, r.z + Math.sin(a) * 5.2], [r.x, 0.5, r.z], 0.2);
      return { ...c, fov: 28 };
    }
    const u = span(time, 77, 82);
    return { pos: orbit(1.0 + u * 0.3, 18, 9, [0, 0, 0]), target: [0, 0.3, 0], fov: 34 };
  };

  // ------------------------------------------------------------ cursor
  const placeCursor = (time: number) => {
    const el = cursorRef.current;
    const ring = ringRef.current;
    if (!el || !ring) return;
    const visible =
      (time > 36.9 && time < 43.0) || (time > 52.3 && time < 54.3) || (time > 59.4 && time < 62);
    el.style.opacity = visible ? "1" : "0";
    const next = CURSOR.find((c) => c.t >= time - 0.05);
    const prev = [...CURSOR].reverse().find((c) => c.t < time - 0.05);
    const centre = (target: string) => {
      const node = document.querySelector(`[data-film="${target}"]`);
      if (!node) return null;
      const r = node.getBoundingClientRect();
      return { x: r.left + r.width * 0.62, y: r.top + r.height * 0.58 };
    };
    if (next) {
      const goal = centre(next.target);
      if (goal) {
        const u = ease(span(time, next.t - 0.75, next.t - 0.08));
        if (u > 0) {
          const from = (prev && centre(prev.target)) || cursorPos.current;
          cursorPos.current = { x: lerp(from.x, goal.x, u), y: lerp(from.y, goal.y, u) };
        }
      }
    }
    el.style.transform = `translate(${cursorPos.current.x.toFixed(1)}px, ${cursorPos.current.y.toFixed(1)}px)`;
    const last = [...CURSOR].reverse().find((c) => c.t <= time);
    const since = last ? time - last.t : 9;
    if (since < 0.35 && visible) {
      const k = since / 0.35;
      ring.style.opacity = String(1 - k);
      ring.style.transform = `translate(${cursorPos.current.x - 4}px, ${cursorPos.current.y - 4}px) scale(${1 + k * 2.2})`;
    } else {
      ring.style.opacity = "0";
    }
  };

  // ------------------------------------------------------------ stepping
  const stepRef = useRef<(dt: number) => void>(() => undefined);
  stepRef.current = (dt: number) => {
    tRef.current = Math.min(DURATION, tRef.current + dt);
    const time = tRef.current;
    ctl.cam = direct(time);
    ctl.hideTags = modeAt(time) !== "hud";
    ctl.timeScale = time > 75.0 && time < 76.7 ? 0.38 : 1;
    flushSync(() => setT(time));
    placeCursor(time);
    ctl.step?.(dt);
  };

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const api = {
      ready: false,
      fps: FPS,
      duration: DURATION,
      time: () => tRef.current,
      step: (dt: number) => stepRef.current(dt),
    };
    (window as unknown as { __film: typeof api }).__film = api;

    let raf = 0;
    let cancelled = false;
    const boot = async () => {
      await document.fonts.ready;
      while (!ctl.step && !cancelled) await new Promise((r) => setTimeout(r, 50));
      if (cancelled) return;
      const startAt = Number(params.get("t") || 0);
      while (tRef.current < startAt) stepRef.current(1 / FPS);
      stepRef.current(0);
      api.ready = true;
      if (params.get("preview")) {
        let last = performance.now();
        const loop = () => {
          raf = requestAnimationFrame(loop);
          const now = performance.now();
          const dt = Math.min(0.05, (now - last) / 1000);
          last = now;
          if (tRef.current < DURATION) stepRef.current(dt);
        };
        loop();
      }
    };
    void boot();
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [ctl]);

  // ------------------------------------------------------------ derived
  const arena = arenaAt(t);
  const mode = modeAt(t);
  const hud = mode === "hud";
  const m = arena.mission;

  const c = credits.current;
  if (arena.userCredits !== c.to) {
    c.from = c.shown;
    c.to = arena.userCredits;
    c.at = t;
  }
  c.shown = lerp(c.from, c.to, easeOut(span(t, c.at, c.at + 0.6)));

  const selected: AgentId = t < 37.8 ? "vanguard" : "pivot";
  const stake = t < 39.9 ? 50 : t < 60.2 ? 100 : 250;
  const running = (t >= 53.5 && t < 58.62) || t >= 61.6;
  const isCheckpoint = arena.phase === "CHECKPOINT_1" || arena.phase === "CHECKPOINT_2";
  const lastEvent = [...arena.events].reverse().find((e) => e.turn > 0 && e.type !== "checkpoint");

  const bars = mode === "cine" ? 112 * Math.min(easeOut(span(t, 0, 0.5)), 1) : 0;
  const blockIdx = t >= 62 && t < 68 ? Math.min(3, Math.floor((t - 62) / 1.5)) : -1;
  const block = blockIdx >= 0 ? film.blocks[blockIdx] : null;
  const card = COURIER_CARDS.find((cc) => t >= cc.from && t < cc.to);
  const pnl = film.roundB.pnl;
  const pnlShown = pnl * easeOut(span(t, 78.4, 79.8));
  const hudBanner =
    t >= 55.26 && t < 57.4
      ? { text: "ROAD CLOSED", sub: m.scheduledHazards.find((h) => h.triggerTurn === 3)?.label ?? "", bg: GOLD, fg: INK, k: window01(t, 55.26, 57.4) }
      : t >= 58.7 && t < 60.3
      ? { text: "BETTING OPEN", sub: "Turn 10", bg: INK, fg: CARD, k: window01(t, 58.7, 60.3) }
      : null;
  const vanguard = arena.agents.vanguard;
  const letters = "FIASCO".split("");

  return (
    <div
      style={{ position: "fixed", inset: 0, width: 1920, height: 1080, overflow: "hidden", background: PAPER, color: INK }}
    >
      {/* ---------------- the game screen ---------------- */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          transformOrigin: "0 0",
          transform: hud ? zoomAt(t) : "none",
        }}
        className="flex flex-col"
      >
        <header className="shrink-0 bg-[#1A1915] text-[#F7F2E6]" style={{ display: hud ? "block" : "none" }}>
          <div className="h-12 px-4 flex items-center justify-between gap-3">
            <div className="flex items-center gap-4">
              <span className="font-display text-2xl font-extrabold leading-none tracking-wide">
                FIAS<span className="text-[#E2A400]">CO</span>
              </span>
              <nav className="flex items-stretch h-12">
                {["PLAY", "MISSIONS", "LEDGER", "COURIERS"].map((label, i) => (
                  <span
                    key={label}
                    className={`px-3 flex items-center font-display text-lg font-bold leading-none ${
                      i === 0 ? "bg-[#F7F2E6] text-[#1A1915]" : "text-[#B5AB93]"
                    }`}
                  >
                    {label}
                  </span>
                ))}
              </nav>
            </div>
            <div className="flex items-center gap-2">
              <span className="border border-[#5E584B] px-2 py-1 font-mono-num text-[11px] text-[#E2A400]">
                NEAR / {arena.chain.confirmedOps} WRITES
              </span>
              <span className="border border-[#5E584B] p-1.5">
                <GlyphAudio muted={false} className="h-4 w-4" />
              </span>
              <div className="bg-[#E2A400] text-[#1A1915] px-2.5 py-1 font-display text-2xl font-extrabold leading-none tnum">
                {money(c.shown)}
              </div>
            </div>
          </div>
        </header>

        <main className="flex-1 min-h-0 flex flex-row">
          <section className="relative flex-1 min-h-0 flex flex-col">
            <div className="relative flex-1 min-h-0">
              <CityStage
                mission={m}
                roundId={arena.roundId}
                agents={arena.agents}
                activeHazards={arena.activeHazards}
                focusAgent="all"
                live
                film={ctl}
              />

              {hud && (
                <div className="pointer-events-none absolute left-5 top-4 max-w-[70%]">
                  <div className="font-mono-num text-[11px] font-semibold text-[#5E584B]">
                    {m.seed} / {m.difficulty.toUpperCase()} / BLOCK {arena.seed.blockHeight}
                  </div>
                  <h1 className="font-display text-5xl font-extrabold leading-[0.9] uppercase">{m.title}</h1>
                  {lastEvent && (
                    <div className="mt-2 inline-block bg-[#1A1915] px-2 py-1 font-display text-base font-bold leading-none text-[#F7F2E6] uppercase">
                      T{lastEvent.turn} {lastEvent.title}
                    </div>
                  )}
                </div>
              )}

              {hud && hudBanner && (
                <div className="pointer-events-none absolute inset-x-0 top-0 flex justify-center overflow-hidden h-28">
                  <div
                    className="mt-4 h-fit px-5 py-2 text-center"
                    style={{
                      background: hudBanner.bg,
                      color: hudBanner.fg,
                      transform: `translateY(${((1 - hudBanner.k) * -160).toFixed(1)}%)`,
                    }}
                  >
                    <div className="font-display text-5xl font-extrabold leading-none uppercase">{hudBanner.text}</div>
                    <div className="font-display text-lg font-bold leading-none uppercase mt-1">{hudBanner.sub}</div>
                  </div>
                </div>
              )}
            </div>

            <div
              className="shrink-0 border-t-2 border-[#1A1915] bg-[#F7F2E6] items-stretch"
              style={{ display: hud ? "flex" : "none" }}
            >
              <div className="shrink-0 px-3 flex items-baseline gap-1 self-center font-display font-extrabold leading-none tnum">
                <span className="text-5xl">{String(arena.turn).padStart(2, "0")}</span>
                <span className="text-xl text-[#8A8372]">/{m.maxTurns}</span>
              </div>
              <div className="flex-1 min-w-0 flex items-stretch gap-px py-2.5 pr-3">
                {Array.from({ length: m.maxTurns }).map((_, i) => {
                  const turn = i + 1;
                  const done = turn <= arena.turn;
                  const isHz = m.scheduledHazards.some((h) => h.triggerTurn === turn);
                  return (
                    <span
                      key={turn}
                      className="relative flex-1 min-w-0"
                      style={{
                        backgroundColor: done ? (turn === arena.turn ? GOLD : INK) : isHz ? GOLD : "#CDC3AC",
                        opacity: !done && isHz ? 0.55 : 1,
                      }}
                    >
                      {m.checkpoints.includes(turn) && (
                        <span className="absolute -top-2.5 -bottom-2.5 right-0 w-0.5 bg-[#1A1915]" />
                      )}
                    </span>
                  );
                })}
              </div>
              <div className="shrink-0 flex items-stretch border-l-2 border-[#1A1915]">
                <span className="flex px-3 items-center border-r-2 border-[#1A1915]">
                  <GlyphStep className="h-5 w-5" />
                </span>
                <span className="flex px-3 items-center border-r-2 border-[#1A1915]">
                  <GlyphFastForward className="h-5 w-5" />
                </span>
                <span className="flex px-3 items-center border-r-2 border-[#1A1915]">
                  <GlyphReset className="h-5 w-5" />
                </span>
                <span
                  data-film="play"
                  className={`w-48 py-4 flex items-center justify-center gap-2 font-display text-2xl font-extrabold leading-none ${
                    running ? "bg-[#E2A400] text-[#1A1915]" : "bg-[#1A1915] text-[#F7F2E6]"
                  }`}
                >
                  {running ? (
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
                </span>
              </div>
            </div>
          </section>

          <aside
            className="w-[400px] shrink-0 border-l-2 border-[#1A1915] bg-[#F7F2E6] flex-col"
            style={{ display: hud ? "flex" : "none" }}
          >
            <RacerBoard
              arena={arena}
              agents={arena.agents}
              selected={selected}
              onSelect={() => undefined}
              focus="all"
              onFocus={() => undefined}
            />
            <BetSlip
              arena={arena}
              selected={selected}
              onTrade={async () => undefined}
              busy={false}
              error={null}
              forced={{ side: "YES", stake }}
            />
            <PuntersBoard arena={arena} />
          </aside>
        </main>
      </div>

      {/* ---------------- captions over the game screen ---------------- */}
      {hud && (
        <div style={{ position: "absolute", left: 56, bottom: 132 }}>
          {CAPTIONS.map((cap) => (
            <Word key={cap.text} t={t} from={cap.from} to={cap.to} size={84}>
              {cap.text}
            </Word>
          ))}
        </div>
      )}

      {/* ---------------- cinematic overlays ---------------- */}
      {mode === "cine" && (
        <>
          <div style={{ position: "absolute", left: 0, right: 0, top: 0, height: bars, background: INK }} />
          <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: bars, background: INK }} />
        </>
      )}

      {t < 1.8 && (
        <div style={{ position: "absolute", inset: 0, background: INK, opacity: 1 - ease(span(t, 0.3, 1.8)) }} />
      )}

      {t > 2.4 && t < 5.8 && (
        <div style={{ position: "absolute", left: 96, bottom: 168 }}>
          <Word t={t} from={2.4} to={5.8} size={44}>
            SECTOR 4 / 08:00 / THREE PARCELS EACH
          </Word>
        </div>
      )}

      {card && (
        <div
          style={{
            position: "absolute",
            left: 0,
            top: bars,
            bottom: bars,
            width: 820,
            background: courierLine(card.id).color,
            color: AGENT_INK[card.id],
            transform: `translateX(${((1 - window01(t, card.from, card.to, 0.2, 0.14)) * -100).toFixed(2)}%)`,
            display: "flex",
            alignItems: "center",
            padding: "0 72px",
            gap: 48,
          }}
        >
          <div className="font-display" style={{ fontSize: 520, fontWeight: 800, lineHeight: 0.8 }}>
            {AGENT_NUM[card.id]}
          </div>
          <div>
            <div className="font-display" style={{ fontSize: 96, fontWeight: 800, lineHeight: 0.9, whiteSpace: "nowrap" }}>
              {courierLine(card.id).name.toUpperCase()}
            </div>
            <div className="font-display" style={{ fontSize: 44, fontWeight: 600, lineHeight: 1.1, marginTop: 14 }}>
              {courierLine(card.id).style.toUpperCase()}
            </div>
          </div>
        </div>
      )}

      <div style={{ position: "absolute", left: 0, right: 0, bottom: 136, display: "flex", justifyContent: "center" }}>
        <Word t={t} from={14.98} to={16} size={140} bg={GOLD} fg={INK}>
          ROAD CLOSED
        </Word>
      </div>

      <div style={{ position: "absolute", left: 96, bottom: 180 }}>
        <Word t={t} from={16.3} to={18.7} size={150}>
          ROADS CLOSE
        </Word>
        <Word t={t} from={19.2} to={21.9} size={150}>
          BATTERIES DIE
        </Word>
        <Word t={t} from={22.1} to={23.95} size={150}>
          THE CLOCK RUNS OUT
        </Word>
      </div>

      {t >= 19.2 && t < 21.9 && (
        <div style={{ position: "absolute", right: 96, bottom: 180, display: "flex", alignItems: "flex-end", gap: 20, background: INK, padding: "22px 28px 26px" }}>
          <div style={{ display: "flex", gap: 5 }}>
            {Array.from({ length: 12 }).map((_, i) => (
              <span
                key={i}
                style={{
                  width: 26,
                  height: 96,
                  background: i < vanguard.battery ? (vanguard.battery <= 4 ? RED : CARD) : "rgba(247,242,230,0.22)",
                }}
              />
            ))}
          </div>
          <div className="font-display tnum" style={{ fontSize: 150, fontWeight: 800, lineHeight: 0.8, color: vanguard.battery <= 4 ? RED : CARD }}>
            {vanguard.battery}
          </div>
        </div>
      )}

      {t >= 22.1 && t < 23.95 && (
        <div
          className="font-display tnum"
          style={{ position: "absolute", right: 96, bottom: 180, fontSize: 170, fontWeight: 800, lineHeight: 0.8, color: CARD, background: INK, padding: "22px 28px 26px" }}
        >
          {String(arena.turn).padStart(2, "0")}
          <span style={{ fontSize: 90, color: GOLD }}>/{m.maxTurns}</span>
        </div>
      )}

      <div
        style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8 }}
      >
        <Word t={t} from={25.9} to={27.5} size={230}>
          WHO MAKES IT
        </Word>
        <Word t={t} from={27.7} to={29.85} size={230} bg={RED}>
          WHO FALLS APART
        </Word>
      </div>

      {block && (
        <>
          <div style={{ position: "absolute", left: 96, top: 150, background: INK, padding: "20px 34px 26px" }}>
            <div className="font-display" style={{ fontSize: 44, fontWeight: 700, color: GOLD, lineHeight: 1 }}>
              NEAR BLOCK
            </div>
            <div className="font-display tnum" style={{ fontSize: 190, fontWeight: 800, lineHeight: 0.9, color: CARD }}>
              {block.height.toLocaleString("en-US")}
            </div>
            <div className="font-mono-num" style={{ fontSize: 24, color: "#B5AB93", marginTop: 8 }}>
              {block.hash}
            </div>
          </div>
          <div style={{ position: "absolute", right: 96, bottom: 170 }}>
            <Word t={t} from={62.5} to={67.9} size={96}>
              NEW BLOCK. NEW CITY.
            </Word>
          </div>
          <div
            style={{
              position: "absolute",
              inset: 0,
              background: CARD,
              opacity: 1 - span(t, block.t, block.t + 0.16),
            }}
          />
        </>
      )}

      {t >= 68.2 && t < 74 && (
        <div
          style={{
            position: "absolute",
            right: 96,
            top: 190,
            width: 700,
            background: CARD,
            border: `4px solid ${INK}`,
            transform: `translateX(${((1 - window01(t, 68.2, 74, 0.35, 0.25)) * 130).toFixed(2)}%)`,
          }}
        >
          <div className="font-display" style={{ background: INK, color: CARD, fontSize: 60, fontWeight: 800, lineHeight: 1, padding: "12px 24px" }}>
            ON NEAR
          </div>
          <div className="font-mono-num" style={{ fontSize: 24, padding: "14px 24px", borderBottom: `2px solid ${INK}` }}>
            {ledger?.contractId ?? "fiasco.sr-mfz6qx.testnet"}
          </div>
          {LEDGER_ROWS.map((row, i) => {
            const at = 68.9 + i * 0.62;
            if (t < at) return null;
            return (
              <div
                key={i}
                className="font-display"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 20,
                  padding: "9px 24px",
                  borderBottom: "1px solid #CDC3AC",
                  fontSize: 40,
                  fontWeight: 700,
                  lineHeight: 1,
                  opacity: easeOut(span(t, at, at + 0.2)),
                }}
              >
                <span style={{ background: INK, color: GOLD, padding: "4px 10px", width: 170, textAlign: "center" }}>{row.op}</span>
                <span style={{ flex: 1 }}>{row.text}</span>
                <span style={{ color: GREEN }}>WRITTEN</span>
              </div>
            );
          })}
          {ledger && (
            <div className="font-display tnum" style={{ fontSize: 34, fontWeight: 700, padding: "14px 24px", color: "#5E584B" }}>
              {ledger.rounds} ROUNDS / {ledger.bets} BETS / {money(ledger.stakedCents / 100)} STAKED
            </div>
          )}
        </div>
      )}

      <div style={{ position: "absolute", left: 96, bottom: 180 }}>
        <Word t={t} from={75.15} to={76.9} size={140} bg={GREEN}>
          COURIER 3 FINISHES
        </Word>
      </div>

      {t >= 77.9 && t < 81 && (
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div
            style={{
              width: 900,
              background: CARD,
              border: `4px solid ${INK}`,
              transform: `translateY(${((1 - window01(t, 77.9, 81, 0.3, 0.2)) * 60).toFixed(1)}px)`,
              opacity: window01(t, 77.9, 81, 0.2, 0.2),
            }}
          >
            <div className="font-display" style={{ background: INK, color: CARD, fontSize: 56, fontWeight: 800, lineHeight: 1, padding: "14px 28px" }}>
              ROUND SETTLED
            </div>
            <div className="font-display tnum" style={{ fontSize: 250, fontWeight: 800, lineHeight: 0.95, color: GREEN, padding: "18px 28px 8px" }}>
              +{money(pnlShown)}
            </div>
            <div style={{ borderTop: `4px solid ${INK}` }}>
              {AGENT_IDS.map((id) => {
                const won = arena.agents[id].status === "completed";
                return (
                  <div key={id} style={{ display: "flex", alignItems: "stretch", borderBottom: "1px solid #CDC3AC" }}>
                    <span
                      className="font-display"
                      style={{ width: 84, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 56, fontWeight: 800, background: AGENT_PROFILES[id].color, color: AGENT_INK[id] }}
                    >
                      {AGENT_NUM[id]}
                    </span>
                    <span className="font-display" style={{ flex: 1, padding: "12px 24px", fontSize: 50, fontWeight: 700, lineHeight: 1, color: won ? GREEN : RED }}>
                      {won ? `FINISHED T${arena.agents[id].finishedTurn}` : arena.agents[id].status === "failed_timeout" ? "OUT OF TIME" : "OUT OF POWER"}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* ---------------- title ---------------- */}
      {t >= 29.86 && t < 36.4 && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: PAPER,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            transform: `translateY(${(-100 * ease(span(t, 35.75, 36.35))).toFixed(2)}%)`,
          }}
        >
          <div style={{ display: "flex", overflow: "hidden", paddingBottom: 10 }}>
            {letters.map((ch, i) => (
              <span
                key={i}
                className="font-display"
                style={{
                  fontSize: 560,
                  fontWeight: 800,
                  lineHeight: 0.84,
                  color: i >= 4 ? GOLD : INK,
                  transform: `translateY(${((1 - easeOut(span(t, 30 + i * 0.045, 30.32 + i * 0.045))) * 105).toFixed(2)}%)`,
                  display: "inline-block",
                }}
              >
                {ch}
              </span>
            ))}
          </div>
          <div style={{ height: 96, marginTop: 6 }}>
            <Word t={t} from={32.7} to={36.4} size={72}>
              A BETTING GAME ABOUT THINGS GOING WRONG
            </Word>
          </div>
        </div>
      )}

      {/* ---------------- end card ---------------- */}
      {mode === "end" && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: INK,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            transform: `translateY(${(100 * (1 - easeOut(span(t, 81, 81.45)))).toFixed(2)}%)`,
          }}
        >
          <div className="font-display" style={{ fontSize: 470, fontWeight: 800, lineHeight: 0.84, color: CARD }}>
            FIAS<span style={{ color: GOLD }}>CO</span>
          </div>
          <div style={{ height: 110, marginTop: 10 }}>
            <Word t={t} from={82.0} to={91} size={84} bg={GOLD} fg={INK}>
              BET ON THE BREAKDOWN
            </Word>
          </div>
          <div
            className="font-display"
            style={{ marginTop: 70, fontSize: 40, fontWeight: 600, color: "#B5AB93", letterSpacing: "0.06em", opacity: ease(span(t, 83.4, 84.2)) }}
          >
            BUILT AT NEAR HACKATHON / GAMES WITH REAL ECONOMIES
          </div>
          {playUrl && (
            <div className="font-mono-num" style={{ marginTop: 18, fontSize: 34, color: CARD, opacity: ease(span(t, 84.0, 84.8)) }}>
              {playUrl}
            </div>
          )}
        </div>
      )}

      {/* ---------------- cursor ---------------- */}
      <div
        ref={ringRef}
        style={{ position: "absolute", left: 0, top: 0, width: 8, height: 8, border: `3px solid ${INK}`, opacity: 0, pointerEvents: "none" }}
      />
      <div ref={cursorRef} style={{ position: "absolute", left: 0, top: 0, opacity: 0, pointerEvents: "none" }}>
        <svg width="38" height="38" viewBox="0 0 24 24">
          <path d="M3 2 L3 19 L8 14.5 L11.5 22 L14.5 20.6 L11 13.4 L18 13.4 Z" fill={INK} stroke={CARD} strokeWidth="1.6" strokeLinejoin="miter" />
        </svg>
      </div>
    </div>
  );
}
