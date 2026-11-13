"use client";

import React from "react";
import { AGENT_PROFILES } from "@/lib/sim/missions";
import { AGENT_IDS } from "@/lib/sim/engine";
import { AgentId, MissionConfig, MissionEventPin, TurnSnapshot } from "@/lib/types";

type Props = {
  mission: MissionConfig;
  history: TurnSnapshot[];
  events: MissionEventPin[];
  inspectedTurn: number | null;
  onSelectTurn: (turn: number) => void;
};

export function EventProbabilityChart({
  mission,
  history,
  events,
  inspectedTurn,
  onSelectTurn,
}: Props) {
  const width = 760;
  const height = 196;
  const padL = 42;
  const padR = 20;
  const padT = 18;
  const padB = 34;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const maxX = Math.max(mission.maxTurns, history.length - 1);
  const xForTurn = (t: number) => padL + (t / maxX) * plotW;
  const yForPrice = (p: number) => padT + ((100 - p) / 100) * plotH;

  const activeTurn =
    inspectedTurn !== null ? inspectedTurn : history[history.length - 1]?.turn ?? 0;

  const activeSnap =
    history.find((h) => h.turn === activeTurn) ?? history[history.length - 1];

  const turnEvents = events.filter((e) => e.turn > 0);
  const selectedEvents = events.filter((e) => e.turn === activeTurn);

  return (
    <div className="border border-[#CDC3AC] bg-[#F7F2E6] p-4">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <span className="font-mono-num text-[11px] font-semibold uppercase tracking-wider text-[#5E584B]">
          IMPLIED PROBABILITY / EVENT PINS
        </span>

        <div className="flex flex-wrap items-center gap-4 text-xs">
          {AGENT_IDS.map((id) => {
            const p = AGENT_PROFILES[id];
            const price = activeSnap?.prices[id].yes ?? 50;
            return (
              <span key={id} className="inline-flex items-center gap-1.5 font-mono-num">
                <span
                  className="h-2 w-2 inline-block"
                  style={{ backgroundColor: p.color }}
                />
                <span className="text-[#5E584B]">{p.callsign}</span>
                <span className="font-bold" style={{ color: p.color }}>
                  {price.toFixed(1)}c
                </span>
              </span>
            );
          })}
        </div>
      </div>

      <div className="relative bg-[#EFE8D8] border border-[#CDC3AC]/60 p-1">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="w-full h-auto block select-none"
          role="img"
          aria-label="Probability timeline with clickable mission events"
        >
          {[0, 25, 50, 75, 100].map((val) => {
            const y = yForPrice(val);
            return (
              <g key={`yg-${val}`}>
                <line
                  x1={padL}
                  y1={y}
                  x2={width - padR}
                  y2={y}
                  stroke={val === 50 ? "#B5AB93" : "#EDE5D3"}
                  strokeDasharray={val === 50 ? "4 3" : undefined}
                  strokeWidth={1}
                />
                <text
                  x={padL - 8}
                  y={y + 3}
                  textAnchor="end"
                  fontSize="9.5"
                  fontFamily="var(--font-mono), monospace"
                  fill="#8A8372"
                >
                  {val}c
                </text>
              </g>
            );
          })}

          {mission.checkpoints.map((cp, idx) => {
            const x = xForTurn(cp);
            return (
              <g key={`cp-${cp}`}>
                <line
                  x1={x}
                  y1={padT}
                  x2={x}
                  y2={height - padB}
                  stroke="#A8690A"
                  strokeOpacity={0.45}
                  strokeDasharray="3 3"
                  strokeWidth={1.1}
                />
                <text
                  x={x}
                  y={padT - 5}
                  textAnchor="middle"
                  fontSize="8.5"
                  fontWeight={600}
                  fontFamily="var(--font-mono), monospace"
                  fill="#A8690A"
                >
                  CP{idx + 1} T{cp}
                </text>
              </g>
            );
          })}

          <line
            x1={xForTurn(activeTurn)}
            y1={padT}
            x2={xForTurn(activeTurn)}
            y2={height - padB}
            stroke="#1A1915"
            strokeOpacity={0.65}
            strokeWidth={1.1}
          />

          {AGENT_IDS.map((id: AgentId) => {
            const p = AGENT_PROFILES[id];
            if (history.length === 0) return null;
            const pts = history
              .map((snap) => `${xForTurn(snap.turn)},${yForPrice(snap.prices[id].yes)}`)
              .join(" ");
            const last = history[history.length - 1];
            return (
              <g key={`line-${id}`}>
                <polyline
                  points={pts}
                  fill="none"
                  stroke={p.color}
                  strokeWidth={2}
                  strokeLinejoin="miter"
                  strokeLinecap="square"
                />
                <rect
                  x={xForTurn(last.turn) - 3}
                  y={yForPrice(last.prices[id].yes) - 3}
                  width={6}
                  height={6}
                  fill={p.color}
                  stroke="#EFE8D8"
                  strokeWidth={1}
                />
              </g>
            );
          })}

          {history.map((snap) => {
            const x = xForTurn(snap.turn);
            const sliceW = Math.max(10, plotW / maxX);
            return (
              <rect
                key={`hit-${snap.turn}`}
                x={x - sliceW / 2}
                y={padT}
                width={sliceW}
                height={plotH}
                fill="transparent"
                className="cursor-pointer"
                onClick={() => onSelectTurn(snap.turn)}
              />
            );
          })}

          {turnEvents.map((evt) => {
            const x = xForTurn(evt.turn);
            const y = height - padB + 12;
            const fill =
              evt.type === "hazard" || evt.type === "failure"
                ? "#C22A1C"
                : evt.type === "checkpoint"
                ? "#A8690A"
                : evt.type === "finish" || evt.type === "delivery"
                ? "#1F7A4D"
                : "#2350C9";
            const isSelected = evt.turn === activeTurn;
            const sz = isSelected ? 8 : 6;
            return (
              <g
                key={evt.id}
                className="cursor-pointer"
                onClick={() => onSelectTurn(evt.turn)}
              >
                <rect
                  x={x - sz / 2}
                  y={y - sz / 2}
                  width={sz}
                  height={sz}
                  fill={fill}
                  stroke="#EFE8D8"
                  strokeWidth={1}
                />
                <title>{`T${evt.turn}: ${evt.title} / ${evt.detail}`}</title>
              </g>
            );
          })}

          {[0, 5, 10, 15, 20, 25, mission.maxTurns]
            .filter((v, i, arr) => v <= maxX && arr.indexOf(v) === i)
            .map((t) => (
              <text
                key={`xt-${t}`}
                x={xForTurn(t)}
                y={height - 4}
                textAnchor="middle"
                fontSize="9"
                fontFamily="var(--font-mono), monospace"
                fill="#8A8372"
              >
                T{t}
              </text>
            ))}
        </svg>
      </div>

      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border border-[#CDC3AC] bg-[#E6DDC8] px-3 py-1.5 font-mono-num text-[11px]">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-bold text-[#1A1915] shrink-0">
            T{activeTurn}/{mission.maxTurns}
          </span>
          <span className="text-[#8A8372]">/</span>
          {selectedEvents.length > 0 ? (
            <span className="text-[#1A1915] truncate">
              {selectedEvents[0].title}:{" "}
              <span className="text-[#5E584B]">{selectedEvents[0].detail}</span>
            </span>
          ) : (
            <span className="text-[#8A8372]">NO MILESTONE EVENT AT T{activeTurn}</span>
          )}
        </div>
        <span className="text-[#5E584B] shrink-0">
          {activeSnap?.phase.replace("_", " ") ?? "PRE MARKET"}
        </span>
      </div>
    </div>
  );
}
