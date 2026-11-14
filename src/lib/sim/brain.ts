/**
 * Courier brains: small neural networks that drive the three couriers.
 *
 * Each turn a courier lists every legal action (step to a free neighbouring cell, or charge
 * if it is standing on a charger), describes each one with the features below,
 * and its network scores them. The highest score wins. The three networks were trained
 * by evolution strategies on thousands of seeded rounds (scripts/train-couriers.ts), each
 * against its own reward, which is where the personalities come from:
 *
 * - Vanguard was paid for finishing early and charged for every stop at a charger. It is
 *   also short-sighted by design: its network never sees the whole-tour features (tour
 *   length, margins over the tour, routes via a charger), so it plans one drop at a time.
 * - Gridwise was paid for battery left at the finish and punished hard for running dry.
 * - Pivot was paid simply for finishing, with a small bonus for speed.
 *
 * Inference is plain arithmetic, so the same round always plays out the same way and
 * anyone can replay it from the seed block.
 */
import { AgentId, AgentState, Coord, MissionConfig } from "../types";
import trained from "./brains.json";

export const FEATURE_NAMES = [
  "bias",
  "distance to nearest drop",
  "tour length",
  "distance to nearest charger",
  "battery after",
  "battery margin over tour",
  "turn slack over tour",
  "delivers now",
  "is charge",
  "charge gained",
  "drops remaining",
  "can still reach a charger",
  "tour via charger",
  "battery covers tour",
  "steps back",
  "is wait",
] as const;

export const N_FEATURES = FEATURE_NAMES.length;
export const N_HIDDEN = 10;
export const N_PARAMS = N_FEATURES * N_HIDDEN + N_HIDDEN + N_HIDDEN;

export type Candidate = {
  action: "MOVE" | "CHARGE" | "HOLD";
  to: Coord;
  features: number[];
  label: string;
  near: number;
  batteryAfter: number;
};

const FAR = 99;

/** Grid distances from one cell to every cell, around buildings and closed roads. */
export function distanceMap(from: Coord, mission: MissionConfig, closed: Coord[]): Int16Array {
  const w = mission.width;
  const h = mission.height;
  const blocked = new Uint8Array(w * h);
  for (const b of mission.buildings) blocked[b.y * w + b.x] = 1;
  for (const c of closed) if (c.x >= 0 && c.y >= 0 && c.x < w && c.y < h) blocked[c.y * w + c.x] = 1;
  const dist = new Int16Array(w * h).fill(FAR);
  const start = from.y * w + from.x;
  dist[start] = 0;
  const queue = new Int16Array(w * h);
  let head = 0;
  let tail = 0;
  queue[tail++] = start;
  while (head < tail) {
    const cur = queue[head++];
    const cx = cur % w;
    const cy = (cur - cx) / w;
    const d = dist[cur] + 1;
    const next = [cx > 0 ? cur - 1 : -1, cx < w - 1 ? cur + 1 : -1, cy > 0 ? cur - w : -1, cy < h - 1 ? cur + w : -1];
    for (const n of next) {
      if (n < 0 || blocked[n] || dist[n] <= d) continue;
      dist[n] = d;
      queue[tail++] = n;
    }
  }
  return dist;
}

const at = (map: Int16Array, c: Coord, w: number) => map[c.y * w + c.x];

/** Greedy nearest-first tour length from a start distance map through the remaining drops. */
function tourLength(
  startMap: Int16Array,
  drops: Coord[],
  dropMaps: Int16Array[],
  w: number
): number {
  if (drops.length === 0) return 0;
  const left = drops.map((_, i) => i);
  let total = 0;
  let current: Int16Array = startMap;
  while (left.length) {
    let best = 0;
    for (let k = 1; k < left.length; k++) {
      if (at(current, drops[left[k]], w) < at(current, drops[left[best]], w)) best = k;
    }
    const idx = left[best];
    total += at(current, drops[idx], w);
    current = dropMaps[idx];
    left.splice(best, 1);
  }
  return total;
}

/** The parts of a courier's state the brain looks at. */
export type BrainInput = Pick<AgentState, "coord" | "battery" | "maxBattery" | "deliveredIds" | "path">;

export function listCandidates(
  agent: BrainInput,
  mission: MissionConfig,
  closed: Coord[],
  nextTurn: number,
  cache: Map<number, Int16Array> = new Map()
): Candidate[] {
  const w = mission.width;
  const mapOf = (c: Coord) => {
    const k = c.y * w + c.x;
    let m = cache.get(k);
    if (!m) {
      m = distanceMap(c, mission, closed);
      cache.set(k, m);
    }
    return m;
  };
  const drops = mission.deliveries.filter((d) => !agent.deliveredIds.includes(d.id)).map((d) => d.coord);
  const dropMaps = drops.map((d) => mapOf(d));
  const chargerAt = mission.chargers.find((c) => c.coord.x === agent.coord.x && c.coord.y === agent.coord.y);
  const prev = agent.path.length >= 2 ? agent.path[agent.path.length - 2] : null;
  const turnsAfter = mission.maxTurns - nextTurn;
  const maxB = agent.maxBattery;

  const options: { action: Candidate["action"]; to: Coord; battery: number; gain: number; label: string }[] = [];
  const steps: [number, number, string][] = [
    [1, 0, "east"],
    [-1, 0, "west"],
    [0, 1, "south"],
    [0, -1, "north"],
  ];
  for (const [dx, dy, name] of steps) {
    const to = { x: agent.coord.x + dx, y: agent.coord.y + dy };
    if (to.x < 0 || to.y < 0 || to.x >= w || to.y >= mission.height) continue;
    if (mission.buildings.some((b) => b.x === to.x && b.y === to.y)) continue;
    if (closed.some((c) => c.x === to.x && c.y === to.y)) continue;
    options.push({ action: "MOVE", to, battery: agent.battery - mission.moveCost, gain: 0, label: `step ${name}` });
  }
  if (chargerAt && agent.battery < maxB) {
    const gain = Math.min(maxB - agent.battery, chargerAt.chargeAmount);
    options.push({ action: "CHARGE", to: agent.coord, battery: agent.battery + gain, gain, label: `charge at ${chargerAt.id}` });
  }
  // Waiting is only offered when there is nothing else to do; otherwise a network can
  // learn that standing still forever is safer than driving.
  if (options.length === 0) {
    options.push({ action: "HOLD", to: agent.coord, battery: agent.battery, gain: 0, label: "wait" });
  }

  return options.map((o) => {
    const map = mapOf(o.to);
    const deliversNow = drops.findIndex((d) => d.x === o.to.x && d.y === o.to.y);
    const remainingDrops = deliversNow >= 0 && o.action === "MOVE" ? drops.filter((_, i) => i !== deliversNow) : drops;
    const remainingMaps = deliversNow >= 0 && o.action === "MOVE" ? dropMaps.filter((_, i) => i !== deliversNow) : dropMaps;
    const near = remainingDrops.length ? Math.min(...remainingDrops.map((d) => at(map, d, w))) : 0;
    const tour = tourLength(map, remainingDrops, remainingMaps, w);
    const chargerDists = mission.chargers.map((c) => at(map, c.coord, w));
    const chargerDist = Math.min(...chargerDists);
    let viaCharger = FAR;
    mission.chargers.forEach((c, i) => {
      if (chargerDists[i] >= FAR) return;
      const cmap = mapOf(c.coord);
      viaCharger = Math.min(viaCharger, chargerDists[i] + tourLength(cmap, remainingDrops, remainingMaps, w));
    });
    const features = [
      1,
      Math.min(near, 30) / 20,
      Math.min(tour, 60) / 30,
      Math.min(chargerDist, 30) / 20,
      o.battery / maxB,
      Math.max(-1, Math.min(1, (o.battery - tour) / maxB)),
      Math.max(-1, Math.min(1, (turnsAfter - tour) / mission.maxTurns)),
      deliversNow >= 0 && o.action === "MOVE" ? 1 : 0,
      o.action === "CHARGE" ? 1 : 0,
      o.gain / maxB,
      remainingDrops.length / 3,
      chargerDist <= o.battery ? 1 : 0,
      Math.min(viaCharger, 60) / 30,
      o.battery >= tour ? 1 : 0,
      prev && o.action === "MOVE" && prev.x === o.to.x && prev.y === o.to.y ? 1 : 0,
      o.action === "HOLD" ? 1 : 0,
    ];
    return { action: o.action, to: o.to, features, label: o.label, near, batteryAfter: o.battery };
  });
}

export function score(params: ArrayLike<number>, features: number[]): number {
  let out = params[N_FEATURES * N_HIDDEN + N_HIDDEN + N_HIDDEN - 1] * 0;
  const hiddenBias = N_FEATURES * N_HIDDEN;
  const outW = hiddenBias + N_HIDDEN;
  for (let j = 0; j < N_HIDDEN; j++) {
    let s = params[hiddenBias + j];
    for (let i = 0; i < N_FEATURES; i++) s += params[j * N_FEATURES + i] * features[i];
    out += params[outW + j] * Math.tanh(s);
  }
  return out;
}

export function pick(params: ArrayLike<number>, candidates: Candidate[]): { best: Candidate; value: number } {
  let best = candidates[0];
  let value = -Infinity;
  for (const c of candidates) {
    const v = score(params, c.features);
    if (v > value) {
      value = v;
      best = c;
    }
  }
  return { best, value };
}

/** Features a courier's network is not given (set to zero), by courier. */
export const BLIND: Record<AgentId, number[]> = {
  vanguard: [2, 5, 6, 11, 12, 13],
  gridwise: [],
  pivot: [],
};

/** Zeroes the features this courier does not perceive. */
export function perceive(id: AgentId, candidates: Candidate[]): Candidate[] {
  const blind = BLIND[id];
  if (blind.length) for (const c of candidates) for (const i of blind) c.features[i] = 0;
  return candidates;
}

const BRAINS = trained as unknown as Partial<Record<AgentId, number[]>> & { meta?: unknown };

export function hasBrain(id: AgentId): boolean {
  return Array.isArray(BRAINS[id]) && (BRAINS[id] as number[]).length === N_PARAMS;
}

export function brainMove(
  agent: AgentState,
  mission: MissionConfig,
  closed: Coord[],
  nextTurn: number
): { action: Candidate["action"]; nextCoord: Coord; rationale: string } {
  const params = BRAINS[agent.id] as number[];
  const candidates = perceive(agent.id, listCandidates(agent, mission, closed, nextTurn));
  const { best, value } = pick(params, candidates);
  const drops = mission.deliveries.length - agent.deliveredIds.length;
  const rationale =
    best.action === "CHARGE"
      ? `Network chose to ${best.label} (score ${value.toFixed(2)}): ${agent.battery} BAT now, ${best.batteryAfter} after.`
      : best.action === "HOLD"
      ? `Network chose to wait (score ${value.toFixed(2)}): ${drops} drops left, ${agent.battery} BAT.`
      : `Network chose to ${best.label} (score ${value.toFixed(2)}): next drop ${best.near} away, ${best.batteryAfter} BAT left.`;
  return { action: best.action, nextCoord: best.to, rationale };
}
