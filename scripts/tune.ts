// Finish rates, battery left and charging per courier over 400 seeded rounds per map,
// measured with the real game engine. MAP=sector-4-relay limits it to one map.
//
//   npm run tune
import { createInitialArenaState, stepSimulationTurn, AGENT_IDS } from "../src/lib/sim/engine";
import { MISSIONS } from "../src/lib/sim/missions";
import { buildRoundMission } from "../src/lib/sim/variation";
const N = 400;
const out: Record<string, Record<string, { wins: number; total: number; battery: number; charges: number; finishTurn: number }>> = {};
for (const base of MISSIONS.filter((m) => !process.env.MAP || m.id === process.env.MAP)) {
  out[base.id] = {};
  for (const id of AGENT_IDS) out[base.id][id] = { wins: 0, total: 0, battery: 0, charges: 0, finishTurn: 0 };
  const combos: Record<string, number> = {};
  for (let i = 0; i < N; i++) {
    let s = createInitialArenaState(base.id, "local-policy", "x", "c", "r", buildRoundMission(base, `seed-${i}-xyz`));
    let g = 0;
    while (s.phase !== "SETTLED" && g++ < 80) s = stepSimulationTurn(s);
    let combo = "";
    for (const id of AGENT_IDS) {
      const a = s.agents[id];
      const r = out[base.id][id];
      r.total++;
      r.charges += a.chargesUsed;
      if (a.status === "completed") { r.wins++; r.battery += a.battery; r.finishTurn += a.finishedTurn ?? 0; combo += "W"; } else combo += "L";
    }
    combos[combo] = (combos[combo] || 0) + 1;
  }
  console.log(base.seed, AGENT_IDS.map((id) => { const r = out[base.id][id]; return `${id} ${Math.round((r.wins / N) * 100)}% bat ${(r.battery / Math.max(1, r.wins)).toFixed(1)} T${(r.finishTurn / Math.max(1, r.wins)).toFixed(1)} chg ${(r.charges / N).toFixed(2)}`; }).join(" | "), JSON.stringify(combos));
}
