/**
 * The trailer, as data. One source of truth for the picture (src/components/FilmApp.tsx),
 * the sound (video/audio.ts) and the voiceover cues (video/vo.json is generated from VO).
 *
 * Everything on screen is the real game: the same engine, market maker, stage and
 * bet slip, driven by a fixed script instead of a player.
 */
import { AGENT_IDS, createInitialArenaState, executeMarketTrade, stepSimulationTurn } from "../lib/sim/engine";
import { AGENT_PROFILES, MISSIONS } from "../lib/sim/missions";
import { buildRoundMission } from "../lib/sim/variation";
import { AgentId, ArenaState, OutcomeSide, PunterView } from "../lib/types";

export const FPS = 30;
export const DURATION = 90;

/** Voiceover lines. `t` is when the line starts. */
export const VO: { id: string; t: number; text: string }[] = [
  { id: "01", t: 1.6, text: "This is a simple delivery job." },
  { id: "02", t: 6.3, text: "Three AI couriers. Three packages. One small city." },
  { id: "03", t: 12.5, text: "It never goes simply." },
  { id: "04", t: 16.3, text: "Roads close." },
  { id: "05", t: 19.2, text: "Batteries die." },
  { id: "06", t: 22.1, text: "And the clock runs out." },
  { id: "07", t: 24.6, text: "So the only real question is: who makes it, and who falls apart?" },
  { id: "08", t: 30.9, text: "This is Fiasco." },
  { id: "09", t: 32.9, text: "A betting game about things going wrong." },
  { id: "10", t: 36.6, text: "Pick a courier. Call it: finishes, or fails. Then put your chips down." },
  {
    id: "11",
    t: 44.4,
    text: "You're not betting alone. Mako, Dottie and Rook are punters with their own bankrolls. And every bet moves the odds.",
  },
  { id: "12", t: 54.4, text: "Then watch the run. Twice, the betting window reopens. Double down, or cash out." },
  { id: "13", t: 62.3, text: "Every round is built from a fresh NEAR block. No two runs are the same." },
  { id: "14", t: 68.3, text: "And every chip, every bet, every payout settles on NEAR. You'll never notice." },
  { id: "15", t: 82.0, text: "Fiasco. Bet on the breakdown." },
];

export type SfxKind =
  | "whoosh"
  | "impact"
  | "tick"
  | "click"
  | "cash"
  | "pop"
  | "fail"
  | "riser"
  | "hit"
  | "flip"
  | "count";

export type Sfx = { t: number; kind: SfxKind; gain?: number; len?: number };

export type Beat = { t: number; arena: ArenaState };

export type CursorEvent = { t: number; target: string };

export type FilmData = {
  beats: Beat[];
  sfx: Sfx[];
  /** Round B, the one shown with the full game screen. */
  roundB: { failTurnTime: number; finishTime: number; settleTime: number; pnl: number };
  blocks: { t: number; height: number; hash: string }[];
};

export type SeedBlock = { height: number; hash: string };

const FALLBACK_BLOCKS: SeedBlock[] = [
  { height: 277528190, hash: "8igBF7C3ZiSobhWiiktGYezFDnS9XCQJQMyWkJ6z2u96" },
  { height: 277528189, hash: "4DCYvZdL1QVL5Vqd9ozk4NQa94diDwxrhorqfkAyysYg" },
  { height: 277528188, hash: "GCExyhGPrh3HSuar8rGcJ19nBAfBWFPYAwUUGfiynq8X" },
  { height: 277528187, hash: "H58eWHazWMkMkAtFzdeGg5jWAzW9K1LmTCaphsJUD3gY" },
];

const PUNTERS: { id: string; name: string; style: string }[] = [
  { id: "npc:mako", name: "Mako", style: "Backs the favourite" },
  { id: "npc:dottie", name: "Dottie", style: "Small and safe" },
  { id: "npc:rook", name: "Rook", style: "Fades the crowd" },
];

const NUM: Record<AgentId, string> = { vanguard: "1", gridwise: "2", pivot: "3" };

function makeRound(
  baseIndex: number,
  seed: string,
  roundId: string,
  block: SeedBlock | null,
  punters: PunterView[]
): ArenaState {
  const base = MISSIONS[baseIndex];
  const arena = createInitialArenaState(
    base.id,
    "local-policy",
    "Fiasco Deterministic Policy v2",
    "fiasco.sr-mfz6qx.testnet",
    "https://test.rpc.fastnear.com",
    buildRoundMission(base, seed)
  );
  arena.roundId = roundId;
  arena.seed = block
    ? { source: "near-block", blockHeight: block.height, blockHash: block.hash }
    : { source: "local", blockHeight: null, blockHash: seed };
  arena.punters = punters;
  arena.chain = { ...arena.chain, enabled: true, playerId: "p:trailer" };
  return arena;
}

type Step =
  | { t: number; kind: "turn" }
  | { t: number; kind: "bet"; who: "You" | "Mako" | "Dottie" | "Rook"; agent: AgentId; side: OutcomeSide; amount: number };

/** Plays a scripted round and returns one beat per step, plus the sounds it causes. */
function play(start: ArenaState, steps: Step[], sfx: Sfx[], quietTicks = false): Beat[] {
  const beats: Beat[] = [];
  let arena = start;
  let writes = 0;
  for (const step of steps) {
    if (step.kind === "turn") {
      const before = arena;
      if (before.phase === "SETTLED") continue;
      arena = stepSimulationTurn(arena);
      writes += arena.tradingStatus !== before.tradingStatus ? 1 : 0;
      sfx.push({ t: step.t, kind: "tick", gain: quietTicks ? 0.35 : 0.7 });
      for (const e of arena.events.slice(before.events.length)) {
        if (e.type === "hazard") sfx.push({ t: step.t + 0.63, kind: "impact" });
        if (e.type === "delivery") sfx.push({ t: step.t + 0.42, kind: "pop" });
        if (e.type === "finish") sfx.push({ t: step.t + 0.46, kind: "pop", gain: 1.3 });
        if (e.type === "failure") sfx.push({ t: step.t + 0.4, kind: "fail" });
      }
      if (arena.phase === "SETTLED") {
        arena = { ...arena, punters: settlePunters(arena) };
      }
    } else {
      const isPlayer = step.who === "You";
      const res = executeMarketTrade(arena, {
        agentId: step.agent,
        action: "BUY",
        side: step.side,
        amount: step.amount,
        trader: step.who,
        traderType: isPlayer ? "user" : "crowd",
      });
      if (res.error) throw new Error(`Trailer bet rejected: ${res.error}`);
      arena = res.state;
      writes += 1;
      if (!isPlayer) {
        arena = {
          ...arena,
          punters: arena.punters.map((p) =>
            p.name === step.who
              ? {
                  ...p,
                  bankroll: Number((p.bankroll - step.amount).toFixed(2)),
                  lastBet: `${NUM[step.agent]} ${step.side === "YES" ? "FINISHES" : "FAILS"} / ${step.amount}`,
                }
              : p
          ),
        };
        sfx.push({ t: step.t, kind: "flip" });
      } else {
        sfx.push({ t: step.t, kind: "cash" });
      }
    }
    arena = { ...arena, chain: { ...arena.chain, confirmedOps: writes } };
    beats.push({ t: step.t, arena });
  }
  return beats;
}

function settlePunters(arena: ArenaState): PunterView[] {
  return arena.punters.map((p) => {
    let cost = 0;
    let payout = 0;
    for (const tr of arena.trades) {
      if (tr.trader !== p.name || tr.action !== "BUY") continue;
      cost += -tr.creditsDelta;
      const won =
        (arena.agents[tr.agentId].status === "completed" ? "YES" : "NO") === tr.side;
      if (won) payout += Math.round(tr.shares * 10000) / 100;
    }
    if (cost === 0) return p;
    const net = payout - cost;
    return {
      ...p,
      bankroll: Number((p.bankroll + payout).toFixed(2)),
      lastBet: net >= 0 ? `WON ${net.toFixed(0)}` : `LOST ${Math.abs(net).toFixed(0)}`,
    };
  });
}

const turns = (from: number, gap: number, count: number): Step[] =>
  Array.from({ length: count }, (_, i) => ({ t: Number((from + gap * i).toFixed(3)), kind: "turn" as const }));

export function buildFilm(
  blocks: SeedBlock[] = FALLBACK_BLOCKS,
  punterBanks: number[] = [1216.12, 1101.05, 1077.46]
): FilmData {
  const sfx: Sfx[] = [];
  const punters: PunterView[] = PUNTERS.map((p, i) => ({
    ...p,
    bankroll: punterBanks[i] ?? 1000,
    lastBet: null,
    out: false,
  }));
  const seeds = blocks.length >= 4 ? blocks : FALLBACK_BLOCKS;

  // Round A: the cold open. Closure on turn 3, a second on 11, courier 1 dies on 19.
  const a0 = makeRound(0, "film-127", "FILM-A", null, punters);
  const beatsA = play(a0, [
    { t: 12.5, kind: "turn" },
    { t: 13.2, kind: "turn" },
    { t: 14.37, kind: "turn" },
    ...turns(16.15, 0.27, 7),
    { t: 18.0, kind: "turn" },
    ...turns(18.95, 0.26, 7),
    { t: 20.9, kind: "turn" },
    ...turns(22.2, 0.35, 5),
  ], sfx);

  // Round C: a different map under the question.
  const c0 = makeRound(1, "film-c", "FILM-C", null, punters);
  const beatsC = play(c0, turns(24.4, 0.5, 11), sfx, true);

  // Round B: the full game screen.
  const b0 = makeRound(0, "film-421", "FILM-B", seeds[0], punters);
  const firstHalf = play(b0, [
    { t: 41.0, kind: "bet", who: "You", agent: "pivot", side: "YES", amount: 100 },
    { t: 45.4, kind: "bet", who: "Mako", agent: "pivot", side: "YES", amount: 180 },
    { t: 47.0, kind: "bet", who: "Dottie", agent: "gridwise", side: "YES", amount: 45 },
    { t: 48.6, kind: "bet", who: "Rook", agent: "pivot", side: "NO", amount: 90 },
    ...turns(54.3, 0.48, 10),
    { t: 59.3, kind: "bet", who: "Dottie", agent: "gridwise", side: "YES", amount: 50 },
    { t: 59.7, kind: "bet", who: "Mako", agent: "vanguard", side: "NO", amount: 120 },
    { t: 60.9, kind: "bet", who: "You", agent: "pivot", side: "YES", amount: 250 },
  ], sfx);
  const midB = firstHalf[firstHalf.length - 1].arena;
  const secondHalf = play(midB, [
    ...turns(68.3, 0.5, 10),
    { t: 74.6, kind: "turn" },
    ...turns(77.0, 0.3, 4),
  ], sfx, true);
  const finalB = secondHalf[secondHalf.length - 1].arena;
  if (finalB.phase !== "SETTLED") throw new Error("Trailer round B did not settle");

  const failEvent = finalB.events.find((e) => e.type === "failure");
  const bTurnTime = (turn: number) =>
    [...firstHalf, ...secondHalf].find((b) => b.arena.turn === turn)?.t ?? 0;

  // Rounds D: four maps from four consecutive NEAR blocks.
  const blockTimes = [62.0, 63.5, 65.0, 66.5];
  const beatsD: Beat[] = blockTimes.map((t, i) => {
    let d = makeRound([2, 1, 0, 2][i], seeds[i].hash, `FILM-D${i}`, seeds[i], punters);
    for (let k = 0; k < 4; k++) d = stepSimulationTurn(d);
    return { t, arena: d };
  });

  const beats: Beat[] = [
    { t: 0, arena: a0 },
    ...beatsA,
    { t: 24.0, arena: c0 },
    ...beatsC,
    { t: 30.0, arena: b0 },
    ...firstHalf,
    ...beatsD,
    { t: 68.0, arena: midB },
    ...secondHalf,
  ].sort((x, y) => x.t - y.t);

  // Edit sounds
  for (const t of [6, 8.4, 9.6, 10.8, 12, 14.2, 16, 18.8, 22, 24, 36, 44, 54, 62, 63.5, 65, 66.5, 68, 74, 77.9, 81]) {
    sfx.push({ t: t - 0.12, kind: "whoosh" });
  }
  for (const c of CURSOR) sfx.push({ t: c.t, kind: "click" });
  sfx.push({ t: 27.4, kind: "riser", len: 2.6 });
  sfx.push({ t: 72.0, kind: "riser", len: 2.0 });
  sfx.push({ t: 30.0, kind: "hit" });
  sfx.push({ t: 81.0, kind: "hit" });
  sfx.push({ t: 78.4, kind: "count", len: 1.4 });

  return {
    beats,
    sfx: sfx.sort((x, y) => x.t - y.t),
    roundB: {
      failTurnTime: failEvent ? bTurnTime(failEvent.turn) : 0,
      finishTime: 74.6,
      settleTime: secondHalf[secondHalf.length - 1].t,
      pnl: Number((finalB.userCredits - finalB.initialUserCredits).toFixed(2)),
    },
    blocks: blockTimes.map((t, i) => ({ t, height: seeds[i].height, hash: seeds[i].hash })),
  };
}

/** Cursor clicks on the game screen. Targets are data-film attributes. */
export const CURSOR: CursorEvent[] = [
  { t: 37.8, target: "racer-pivot" },
  { t: 39.0, target: "side-YES" },
  { t: 39.9, target: "chip-100" },
  { t: 41.0, target: "bet" },
  { t: 53.5, target: "play" },
  { t: 60.2, target: "chip-250" },
  { t: 60.9, target: "bet" },
  { t: 61.6, target: "play" },
];

export const COURIER_CARDS: { id: AgentId; from: number; to: number }[] = [
  { id: "vanguard", from: 8.4, to: 9.6 },
  { id: "gridwise", from: 9.6, to: 10.8 },
  { id: "pivot", from: 10.8, to: 12.0 },
];

export function courierLine(id: AgentId): { name: string; style: string; color: string } {
  const p = AGENT_PROFILES[id];
  return { name: p.name, style: p.strategyTitle, color: p.color };
}

export { AGENT_IDS };
