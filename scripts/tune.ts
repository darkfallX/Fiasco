import { createInitialArenaState, stepSimulationTurn, AGENT_IDS } from "../src/lib/sim/engine";
import { MISSIONS } from "../src/lib/sim/missions";
import { buildRoundMission } from "../src/lib/sim/variation";

const N = 400;
for (const base of MISSIONS) {
  const wins: Record<string, number> = { vanguard: 0, gridwise: 0, pivot: 0 };
  const combos: Record<string, number> = {};
  for (let i = 0; i < N; i++) {
    const m = buildRoundMission(base, `seed-${i}-xyz`);
    let s = createInitialArenaState(base.id, "local-policy", "x", "c", "r", m);
    let guard = 0;
    while (s.phase !== "SETTLED" && guard++ < 80) s = stepSimulationTurn(s);
    if (s.phase !== "SETTLED") throw new Error("did not settle " + i);
    let combo = "";
    for (const id of AGENT_IDS) {
      const w = s.agents[id].status === "completed";
      if (w) wins[id]++;
      combo += w ? "W" : "L";
    }
    combos[combo] = (combos[combo] || 0) + 1;
  }
  console.log(base.seed, AGENT_IDS.map((id) => `${id} ${Math.round((wins[id] / N) * 100)}%`).join("  "), JSON.stringify(combos));
}
