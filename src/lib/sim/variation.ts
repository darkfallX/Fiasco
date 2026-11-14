import { Coord, MissionConfig, ScheduledHazard } from "../types";
import { findShortestPath } from "./engine";

const EXTRA_CLOSURES = [
  { label: "Burst Water Main", reason: "Flooded carriageway" },
  { label: "Stalled Tram", reason: "Tram stuck across the junction" },
  { label: "Street Market", reason: "Stalls spill into the road" },
  { label: "Crane Lift", reason: "Overhead lift closes the block" },
];

function hashSeed(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const key = (c: Coord) => `${c.x},${c.y}`;

/**
 * Derives this round's mission from a base map and a seed (a NEAR block hash when one
 * is available). Same base + same seed always gives the same mission, so anyone can
 * recompute it. Battery, charger output, closure timing and position, and drop points
 * all move; every drop point and charger stays reachable with all closures active.
 */
export function buildRoundMission(base: MissionConfig, seedHex: string): MissionConfig {
  const rnd = mulberry32(hashSeed(`${base.id}:${seedHex}`));
  const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));

  for (let attempt = 0; attempt < 24; attempt++) {
    const taken = new Set<string>([
      key(base.startCoord),
      ...base.buildings.map(key),
      ...base.chargers.map((c) => key(c.coord)),
    ]);
    const free = (c: Coord) =>
      c.x >= 0 && c.y >= 0 && c.x < base.width && c.y < base.height && !taken.has(key(c));
    const neighbours = (c: Coord) =>
      [
        { x: c.x + 1, y: c.y },
        { x: c.x - 1, y: c.y },
        { x: c.x, y: c.y + 1 },
        { x: c.x, y: c.y - 1 },
      ].filter(free);

    const deliveries = base.deliveries.map((d) => {
      let coord = d.coord;
      if (rnd() < 0.55) {
        const options = neighbours(d.coord);
        if (options.length) coord = options[int(0, options.length - 1)];
      }
      taken.add(key(coord));
      return { ...d, coord };
    });

    const scheduledHazards: ScheduledHazard[] = base.scheduledHazards.map((h) => {
      const options = [h.coord, ...neighbours(h.coord)].filter(free);
      const coord = options.length ? options[int(0, options.length - 1)] : h.coord;
      taken.add(key(coord));
      return {
        ...h,
        coord,
        triggerTurn: Math.max(2, Math.min(base.maxTurns - 9, h.triggerTurn + int(-3, 3))),
      };
    });

    if (rnd() < 0.5) {
      const cells: Coord[] = [];
      for (let x = 0; x < base.width; x++)
        for (let y = 0; y < base.height; y++) if (free({ x, y })) cells.push({ x, y });
      if (cells.length) {
        const pick = EXTRA_CLOSURES[int(0, EXTRA_CLOSURES.length - 1)];
        const coord = cells[int(0, cells.length - 1)];
        scheduledHazards.push({
          id: `H${scheduledHazards.length + 1}`,
          triggerTurn: int(4, base.maxTurns - 10),
          coord,
          label: pick.label,
          reason: pick.reason,
        });
      }
    }

    // The clock always leaves room after the second betting window.
    const maxTurns = Math.max(base.checkpoints[1] + 2, base.maxTurns + int(-5, 1));
    const mission: MissionConfig = {
      ...base,
      maxTurns,
      question: base.question,
      startBattery: Math.max(8, Math.min(base.maxBattery, base.startBattery + int(-3, 6))),
      chargers: base.chargers.map((c) => ({ ...c, chargeAmount: c.chargeAmount + int(-3, 2) })),
      deliveries,
      scheduledHazards,
    };

    const allClosed = scheduledHazards.map((h) => h.coord);
    const targets = [...deliveries.map((d) => d.coord), ...base.chargers.map((c) => c.coord)];
    const reachable = targets.every(
      (t) => findShortestPath(base.startCoord, t, mission, allClosed) !== null
    );
    if (reachable) return mission;
  }
  return base;
}
