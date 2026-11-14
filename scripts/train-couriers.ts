// Trains the three courier brains by evolution strategies.
//
//   npm run train            all three couriers
//   npm run train -- pivot   just one
//
// Each courier's network is scored on the same batch of seeded rounds (random maps from
// all three missions, built exactly like real rounds) against its own reward. Writes the
// best weights to src/lib/sim/brains.json. Deterministic: the same command gives the
// same brains.
import fs from "node:fs";
import { MISSIONS } from "../src/lib/sim/missions";
import { buildRoundMission } from "../src/lib/sim/variation";
import { N_PARAMS } from "../src/lib/sim/brain";
import { Episode, play } from "./courier-sim";
import { AgentId, MissionConfig } from "../src/lib/types";


const OUT = process.env.OUT || "src/lib/sim/brains.json";
const GENERATIONS = Number(process.env.GENS || 50);
const POP = 40; // mirrored pairs, so 80 evaluations per generation
const SIGMA = 0.12;
const LR = 0.06;
const BATCH = Number(process.env.BATCH || 48);

let seed = 20261114;
const rnd = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 4294967296;
};
const gauss = () => {
  const u = Math.max(1e-12, rnd());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
};



// Every reward pays a little per delivery, so a network that has not finished a round
// yet can still tell a better attempt from a worse one.
const speed = (e: Episode) => (e.maxTurns - (e.finished ?? e.maxTurns)) / e.maxTurns;
const REWARD: Record<AgentId, (e: Episode) => number> = {
  // Speed is everything; every stop at a charger costs.
  vanguard: (e) =>
    0.4 * e.delivered + (e.status === "completed" ? 1.5 + 5 * speed(e) : 0) - 0.6 * e.charges,
  // Never run dry; finish with something left in the tank.
  gridwise: (e) =>
    0.4 * e.delivered +
    (e.status === "completed" ? 2 + 1.5 * (e.battery / e.maxBattery) + 0.2 * speed(e) : 0) -
    (e.status === "failed_battery" ? 2.5 : 0),
  // Just get it done.
  pivot: (e) => 0.4 * e.delivered + (e.status === "completed" ? 3 + speed(e) : -0.5),
};

function batch(gen: number): MissionConfig[] {
  return Array.from({ length: BATCH }, (_, i) => buildRoundMission(MISSIONS[i % MISSIONS.length], `train-${gen}-${i}`));
}

function fitness(id: AgentId, params: Float64Array, maps: MissionConfig[]): number {
  let total = 0;
  for (const m of maps) total += REWARD[id](play(id, m, params));
  return total / maps.length;
}

function finishRate(id: AgentId, params: Float64Array, maps: MissionConfig[]): number {
  return maps.filter((m) => play(id, m, params).status === "completed").length / maps.length;
}

function train(id: AgentId, init?: number[]): number[] {
  const theta = new Float64Array(N_PARAMS);
  if (init && init.length === N_PARAMS) theta.set(init);
  else for (let i = 0; i < N_PARAMS; i++) theta[i] = gauss() * 0.3;
  const m = new Float64Array(N_PARAMS);
  const v = new Float64Array(N_PARAMS);
  const holdout = Array.from({ length: 150 }, (_, i) => buildRoundMission(MISSIONS[i % 3], `holdout-${i}`));
  let best = Float64Array.from(theta);
  let bestScore = -Infinity;
  const started = Date.now();

  for (let g = 0; g < GENERATIONS; g++) {
    const maps = batch(g);
    const noises: Float64Array[] = [];
    const scores: number[] = [];
    for (let k = 0; k < POP; k++) {
      const eps = new Float64Array(N_PARAMS);
      for (let i = 0; i < N_PARAMS; i++) eps[i] = gauss();
      const plus = theta.map((t, i) => t + SIGMA * eps[i]);
      const minus = theta.map((t, i) => t - SIGMA * eps[i]);
      noises.push(eps);
      scores.push(fitness(id, plus, maps), fitness(id, minus, maps));
    }
    // rank-shaped utilities
    const order = scores.map((s, i) => [s, i] as const).sort((a, b) => a[0] - b[0]);
    const util = new Float64Array(scores.length);
    order.forEach(([, i], rank) => (util[i] = rank / (scores.length - 1) - 0.5));
    const grad = new Float64Array(N_PARAMS);
    for (let k = 0; k < POP; k++) {
      const w = util[2 * k] - util[2 * k + 1];
      for (let i = 0; i < N_PARAMS; i++) grad[i] += (w * noises[k][i]) / (POP * SIGMA);
    }
    // Adam step
    for (let i = 0; i < N_PARAMS; i++) {
      m[i] = 0.9 * m[i] + 0.1 * grad[i];
      v[i] = 0.999 * v[i] + 0.001 * grad[i] * grad[i];
      const mh = m[i] / (1 - Math.pow(0.9, g + 1));
      const vh = v[i] / (1 - Math.pow(0.999, g + 1));
      theta[i] += (LR * mh) / (Math.sqrt(vh) + 1e-8) - 0.0005 * theta[i];
    }
    if (g % 5 === 4 || g === GENERATIONS - 1) {
      const s = fitness(id, theta, holdout);
      if (s > bestScore) {
        bestScore = s;
        best = Float64Array.from(theta);
      }
      console.log(
        `${id} gen ${g + 1}/${GENERATIONS}  holdout reward ${s.toFixed(3)}  finish ${(finishRate(id, theta, holdout) * 100).toFixed(0)}%  ${((Date.now() - started) / 1000).toFixed(0)}s`
      );
    }
  }
  return Array.from(best, (x) => Number(x.toFixed(5)));
}

const only = process.argv[2] as AgentId | undefined;
const existing = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : {};
const ids: AgentId[] = only ? [only] : ["vanguard", "gridwise", "pivot"];
for (const id of ids) {
  const init = process.env.INIT ? JSON.parse(fs.readFileSync(process.env.INIT, "utf8")).pivot : existing[id];
  existing[id] = train(id, process.env.FRESH ? undefined : init);
  existing.meta = {
    method: "evolution strategies (mirrored sampling, rank shaping, Adam)",
    generations: GENERATIONS,
    evaluationsPerGeneration: POP * 2,
    roundsPerEvaluation: BATCH,
    trainedAt: new Date().toISOString().slice(0, 10),
  };
  fs.writeFileSync(OUT, JSON.stringify(existing));
}
console.log("wrote", OUT);
