// Lean courier simulator for training. The real game resolves moves with applyAgentDecision in src/lib/sim/engine.ts. Training
// uses this lean copy of the same rules (no events, paths or projections) because it runs
// a few hundred thousand rounds; tests check that both agree.
import { listCandidates, perceive, pick } from "../src/lib/sim/brain";
import { AgentId, AgentState, Coord, MissionConfig } from "../src/lib/types";

export type Episode = { status: AgentState["status"]; finished: number | null; battery: number; delivered: number; charges: number; maxTurns: number; maxBattery: number };

export function play(id: AgentId, mission: MissionConfig, params: ArrayLike<number>): Episode {
  const agent = {
    coord: { ...mission.startCoord },
    battery: mission.startBattery,
    maxBattery: mission.maxBattery,
    deliveredIds: [] as string[],
    path: [{ ...mission.startCoord }],
  };
  let status: AgentState["status"] = "active";
  let finished: number | null = null;
  let charges = 0;
  const closed: Coord[] = [];
  let cache = new Map<number, Int16Array>();
  for (let turn = 1; turn <= mission.maxTurns; turn++) {
    for (const h of mission.scheduledHazards) {
      if (h.triggerTurn === turn && !closed.some((c) => c.x === h.coord.x && c.y === h.coord.y)) {
        closed.push(h.coord);
        cache = new Map();
      }
    }
    const { best } = pick(params, perceive(id, listCandidates(agent, mission, closed, turn, cache)));
    if (best.action === "CHARGE") {
      const ch = mission.chargers.find((c) => c.coord.x === agent.coord.x && c.coord.y === agent.coord.y);
      if (ch) {
        agent.battery = Math.min(agent.maxBattery, agent.battery + ch.chargeAmount);
        charges++;
      }
    } else if (best.action === "MOVE") {
      if (agent.battery < mission.moveCost) {
        agent.battery = 0;
        status = "failed_battery";
      } else {
        agent.coord = { ...best.to };
        agent.battery = Math.max(0, agent.battery - mission.moveCost);
        agent.path.push(agent.coord);
        const hit = mission.deliveries.find(
          (d) => d.coord.x === agent.coord.x && d.coord.y === agent.coord.y && !agent.deliveredIds.includes(d.id)
        );
        if (hit) agent.deliveredIds.push(hit.id);
      }
    }
    if (agent.deliveredIds.length === mission.deliveries.length) {
      status = "completed";
      finished = turn;
    } else if (agent.battery <= 0) status = "failed_battery";
    else if (turn >= mission.maxTurns) status = "failed_timeout";
    if (status !== "active") break;
  }
  return {
    status,
    finished,
    battery: agent.battery,
    delivered: agent.deliveredIds.length,
    charges,
    maxTurns: mission.maxTurns,
    maxBattery: mission.maxBattery,
  };
}
