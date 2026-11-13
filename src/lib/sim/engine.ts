import {
  createAgentMarket,
  applyBuyTrade,
  applySellTrade,
  PAYOUT_PER_SHARE,
} from "../market/lmsr";
import {
  AgentId,
  AgentMarket,
  AgentState,
  ArenaState,
  Coord,
  MissionConfig,
  MissionEventPin,
  OutcomeSide,
  RoundPhase,
  TradeRecord,
  TradingStatus,
  TurnSnapshot,
  UserPosition,
} from "../types";
import { AGENT_PROFILES, getMissionById } from "./missions";

export const AGENT_IDS: AgentId[] = ["vanguard", "gridwise", "pivot"];
export const INITIAL_USER_CREDITS = 1000;

export function sameCoord(a: Coord, b: Coord): boolean {
  return a.x === b.x && a.y === b.y;
}

export function manhattan(a: Coord, b: Coord): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

function coordKey(c: Coord): string {
  return `${c.x},${c.y}`;
}

export function isBlocked(
  c: Coord,
  mission: MissionConfig,
  activeHazards: Coord[]
): boolean {
  if (c.x < 0 || c.y < 0 || c.x >= mission.width || c.y >= mission.height) {
    return true;
  }
  if (mission.buildings.some((b) => sameCoord(b, c))) return true;
  if (activeHazards.some((h) => sameCoord(h, c))) return true;
  return false;
}

/**
 * Shortest valid path from `from` to `to` using BFS on 4-connected grid.
 * Returns array of coordinates EXCLUDING `from` and INCLUDING `to`, or null if unreachable.
 */
export function findShortestPath(
  from: Coord,
  to: Coord,
  mission: MissionConfig,
  activeHazards: Coord[],
  avoidCoords: Coord[] = []
): Coord[] | null {
  if (sameCoord(from, to)) return [];
  const avoidSet = new Set(avoidCoords.map(coordKey));
  const queue: Coord[] = [from];
  const visited = new Set<string>([coordKey(from)]);
  const parent = new Map<string, Coord>();

  const dirs: Coord[] = [
    { x: 1, y: 0 },
    { x: 0, y: 1 },
    { x: -1, y: 0 },
    { x: 0, y: -1 },
  ];

  while (queue.length > 0) {
    const curr = queue.shift()!;
    if (sameCoord(curr, to)) {
      const path: Coord[] = [];
      let step: Coord | undefined = to;
      while (step && !sameCoord(step, from)) {
        path.unshift(step);
        step = parent.get(coordKey(step));
      }
      return path;
    }

    for (const d of dirs) {
      const next = { x: curr.x + d.x, y: curr.y + d.y };
      const key = coordKey(next);
      if (visited.has(key)) continue;
      if (isBlocked(next, mission, activeHazards)) continue;
      if (!sameCoord(next, to) && avoidSet.has(key)) continue;
      visited.add(key);
      parent.set(key, curr);
      queue.push(next);
    }
  }
  return null;
}

/**
 * Compute an agent's current lookahead path toward its immediate goal or remaining tour
 * so the 3D diorama displays projected routes that visibly reroute when hazards hit.
 */
export function computeProjectedPath(
  agent: AgentState,
  mission: MissionConfig,
  activeHazards: Coord[],
  nextTurn: number
): Coord[] {
  if (
    agent.status === "completed" ||
    agent.status === "failed_battery" ||
    agent.status === "failed_timeout"
  ) {
    return [];
  }
  const decision = decideAgentMove(agent, mission, activeHazards, nextTurn);
  const start = decision.action === "MOVE" ? decision.nextCoord : agent.coord;
  const remaining = mission.deliveries.filter(
    (d) => !agent.deliveredIds.includes(d.id)
  );
  if (remaining.length === 0) return [];

  const sorted = [...remaining]
    .map((d) => ({
      d,
      p: findShortestPath(start, d.coord, mission, activeHazards),
    }))
    .filter((x): x is { d: (typeof remaining)[number]; p: Coord[] } => x.p !== null)
    .sort((a, b) => a.p.length - b.p.length);

  if (sorted.length === 0) return [];
  return [agent.coord, ...(decision.action === "MOVE" ? [start] : []), ...sorted[0].p];
}

export function getTradingStatusForPhase(phase: RoundPhase): TradingStatus {
  if (
    phase === "PRE_MARKET" ||
    phase === "CHECKPOINT_1" ||
    phase === "CHECKPOINT_2"
  ) {
    return "OPEN";
  }
  if (phase === "SETTLED") return "SETTLED";
  return "LOCKED";
}

function createInitialAgentState(
  id: AgentId,
  mission: MissionConfig,
  inferenceSource: "local-policy" | "near-ai-cloud" = "local-policy"
): AgentState {
  const base: AgentState = {
    id,
    coord: { ...mission.startCoord },
    battery: mission.startBattery,
    maxBattery: mission.maxBattery,
    deliveredIds: [],
    status: "ready",
    finishedTurn: null,
    path: [{ ...mission.startCoord }],
    plannedPath: [],
    lastAction: "STANDBY",
    lastRationale: AGENT_PROFILES[id].strategySummary,
    distanceTraveled: 0,
    chargesUsed: 0,
    invalidMoves: 0,
    inferenceSource,
  };
  base.plannedPath = computeProjectedPath(base, mission, [], 1);
  return base;
}

function createSnapshot(
  turn: number,
  phase: RoundPhase,
  activeHazards: Coord[],
  agents: Record<AgentId, AgentState>,
  markets: Record<AgentId, AgentMarket>
): TurnSnapshot {
  return {
    turn,
    phase,
    activeHazards: activeHazards.map((h) => ({ ...h })),
    agents: {
      vanguard: {
        ...agents.vanguard,
        coord: { ...agents.vanguard.coord },
        deliveredIds: [...agents.vanguard.deliveredIds],
        path: agents.vanguard.path.map((p) => ({ ...p })),
        plannedPath: agents.vanguard.plannedPath.map((p) => ({ ...p })),
      },
      gridwise: {
        ...agents.gridwise,
        coord: { ...agents.gridwise.coord },
        deliveredIds: [...agents.gridwise.deliveredIds],
        path: agents.gridwise.path.map((p) => ({ ...p })),
        plannedPath: agents.gridwise.plannedPath.map((p) => ({ ...p })),
      },
      pivot: {
        ...agents.pivot,
        coord: { ...agents.pivot.coord },
        deliveredIds: [...agents.pivot.deliveredIds],
        path: agents.pivot.path.map((p) => ({ ...p })),
        plannedPath: agents.pivot.plannedPath.map((p) => ({ ...p })),
      },
    },
    prices: {
      vanguard: { yes: markets.vanguard.yesPrice, no: markets.vanguard.noPrice },
      gridwise: { yes: markets.gridwise.yesPrice, no: markets.gridwise.noPrice },
      pivot: { yes: markets.pivot.yesPrice, no: markets.pivot.noPrice },
    },
  };
}

export function createInitialArenaState(
  missionId?: string,
  inferenceMode: "local-policy" | "near-ai-cloud" = "local-policy",
  modelLabel: string = "Fiasco Deterministic Policy v2",
  contractId: string = "fiasco-market.testnet",
  rpcUrl: string = "https://test.rpc.fastnear.com",
  missionOverride?: MissionConfig
): ArenaState {
  const mission = missionOverride ?? getMissionById(missionId);
  const agents: Record<AgentId, AgentState> = {
    vanguard: createInitialAgentState("vanguard", mission, inferenceMode),
    gridwise: createInitialAgentState("gridwise", mission, inferenceMode),
    pivot: createInitialAgentState("pivot", mission, inferenceMode),
  };

  const markets: Record<AgentId, AgentMarket> = {
    vanguard: createAgentMarket(
      "vanguard",
      `Will Vanguard-01 finish ${mission.deliveries.length}/${mission.deliveries.length} deliveries?`
    ),
    gridwise: createAgentMarket(
      "gridwise",
      `Will Gridwise-02 finish ${mission.deliveries.length}/${mission.deliveries.length} deliveries?`
    ),
    pivot: createAgentMarket(
      "pivot",
      `Will Pivot-03 finish ${mission.deliveries.length}/${mission.deliveries.length} deliveries?`
    ),
  };

  const positions: Record<AgentId, UserPosition> = {
    vanguard: {
      agentId: "vanguard",
      yesShares: 0,
      noShares: 0,
      netCostCredits: 0,
      settledPayoutCredits: 0,
    },
    gridwise: {
      agentId: "gridwise",
      yesShares: 0,
      noShares: 0,
      netCostCredits: 0,
      settledPayoutCredits: 0,
    },
    pivot: {
      agentId: "pivot",
      yesShares: 0,
      noShares: 0,
      netCostCredits: 0,
      settledPayoutCredits: 0,
    },
  };

  const phase: RoundPhase = "PRE_MARKET";
  const roundId = `${mission.seed}-${Date.now().toString(36).toUpperCase()}`;

  return {
    roundId,
    seed: { source: "local", blockHeight: null, blockHash: "" },
    punters: [],
    chain: {
      enabled: false,
      playerId: "",
      contractId,
      pendingOps: 0,
      confirmedOps: 0,
      rejectedOps: 0,
    },
    mission,
    turn: 0,
    phase,
    tradingStatus: getTradingStatusForPhase(phase),
    activeHazards: [],
    agents,
    markets,
    userCredits: INITIAL_USER_CREDITS,
    initialUserCredits: INITIAL_USER_CREDITS,
    positions,
    trades: [],
    events: [
      {
        id: "evt-open",
        turn: 0,
        type: "checkpoint",
        title: "Pre-Mission Market Open",
        detail: `${mission.title} (${mission.seed}) published at 50.0 CR opening liquidity.`,
      },
    ],
    history: [createSnapshot(0, phase, [], agents, markets)],
    evidence: {
      missionHash: "",
      actionLogHash: "",
      settlementHash: "",
      verifierVersion: "fiasco-verifier/2.0.0",
      settledAt: null,
      nearAiAttestation: {
        mode: inferenceMode,
        model: modelLabel,
        nonce: null,
        signature: null,
        teeProvider: null,
        note:
          inferenceMode === "near-ai-cloud"
            ? "Connected to NEAR AI Cloud confidential inference."
            : "Local deterministic policy active. Configure NEAR_AI_API_KEY for live TEE inference.",
      },
      nearContractSpec: {
        contractId,
        network: "testnet",
        rpcUrl,
        deployed: false,
        wasmCompiled: false,
        receipts: [],
      },
    },
  };
}

export type PlannedDecision = {
  action: "MOVE" | "CHARGE" | "HOLD";
  nextCoord: Coord;
  rationale: string;
};

export function decideAgentMove(
  agent: AgentState,
  mission: MissionConfig,
  activeHazards: Coord[],
  nextTurn: number
): PlannedDecision {
  if (
    agent.status === "completed" ||
    agent.status === "failed_battery" ||
    agent.status === "failed_timeout"
  ) {
    return {
      action: "HOLD",
      nextCoord: agent.coord,
      rationale: `Terminal state (${agent.status}).`,
    };
  }

  const remainingDeliveries = mission.deliveries.filter(
    (d) => !agent.deliveredIds.includes(d.id)
  );
  if (remainingDeliveries.length === 0) {
    return {
      action: "HOLD",
      nextCoord: agent.coord,
      rationale: "All deliveries complete.",
    };
  }

  const onCharger = mission.chargers.find((c) => sameCoord(c.coord, agent.coord));
  const turnsLeft = mission.maxTurns - nextTurn + 1;

  const deliveryPaths = remainingDeliveries
    .map((d) => ({
      delivery: d,
      path: findShortestPath(agent.coord, d.coord, mission, activeHazards),
    }))
    .filter((item): item is { delivery: (typeof remainingDeliveries)[number]; path: Coord[] } =>
      item.path !== null
    )
    .sort((a, b) => a.path.length - b.path.length);

  const chargerPaths = mission.chargers
    .map((c) => ({
      charger: c,
      path: findShortestPath(agent.coord, c.coord, mission, activeHazards),
    }))
    .filter((item): item is { charger: (typeof mission.chargers)[number]; path: Coord[] } =>
      item.path !== null
    )
    .sort((a, b) => a.path.length - b.path.length);

  const nearestDelivery = deliveryPaths[0];
  const nearestCharger = chargerPaths[0];

  if (agent.id === "vanguard") {
    if (onCharger && agent.battery <= 5) {
      return {
        action: "CHARGE",
        nextCoord: agent.coord,
        rationale: `Emergency reserve (${agent.battery} BAT) at ${onCharger.label}; recharging +${onCharger.chargeAmount}.`,
      };
    }

    if (
      agent.battery <= 4 &&
      nearestCharger &&
      nearestCharger.path.length > 0 &&
      nearestCharger.path.length <= agent.battery &&
      (!nearestDelivery || nearestDelivery.path.length > agent.battery)
    ) {
      return {
        action: "MOVE",
        nextCoord: nearestCharger.path[0],
        rationale: `Battery critical (${agent.battery} BAT); detouring to ${nearestCharger.charger.label}.`,
      };
    }

    if (nearestDelivery && nearestDelivery.path.length > 0) {
      return {
        action: "MOVE",
        nextCoord: nearestDelivery.path[0],
        rationale: `Direct sprint to ${nearestDelivery.delivery.label} (${nearestDelivery.path.length} hops, ${agent.battery} BAT).`,
      };
    }
  }

  if (agent.id === "gridwise") {
    const lowBuffer = agent.battery < Math.ceil(agent.maxBattery * 0.45);
    const cannotSafelyReach =
      nearestDelivery && agent.battery < nearestDelivery.path.length + 5;

    if (onCharger && agent.battery < agent.maxBattery - 5) {
      return {
        action: "CHARGE",
        nextCoord: agent.coord,
        rationale: `Charging at ${onCharger.label} (${agent.battery}/${agent.maxBattery} BAT) to maintain reserve.`,
      };
    }

    if (
      (lowBuffer || cannotSafelyReach) &&
      nearestCharger &&
      nearestCharger.path.length > 0 &&
      nearestCharger.path.length <= agent.battery &&
      turnsLeft > nearestCharger.path.length + 4
    ) {
      return {
        action: "MOVE",
        nextCoord: nearestCharger.path[0],
        rationale: `Margin below 45% (${agent.battery} BAT); routing via ${nearestCharger.charger.label} (${nearestCharger.path.length} hops).`,
      };
    }

    if (nearestDelivery && nearestDelivery.path.length > 0) {
      return {
        action: "MOVE",
        nextCoord: nearestDelivery.path[0],
        rationale: `Advancing to ${nearestDelivery.delivery.label} (${nearestDelivery.path.length} hops, ${agent.battery} BAT).`,
      };
    }
  }

  if (agent.id === "pivot") {
    let estTotalDist = nearestDelivery ? nearestDelivery.path.length : 0;
    if (nearestDelivery && remainingDeliveries.length > 1) {
      const others = remainingDeliveries.filter(
        (d) => d.id !== nearestDelivery.delivery.id
      );
      let cursor = nearestDelivery.delivery.coord;
      for (const o of others) {
        const leg = findShortestPath(cursor, o.coord, mission, activeHazards);
        estTotalDist += leg ? leg.length : manhattan(cursor, o.coord);
        cursor = o.coord;
      }
    }

    const needsChargeForTour = agent.battery < estTotalDist + 2;
    const turnSlack = turnsLeft - estTotalDist;

    if (onCharger && needsChargeForTour && agent.battery < agent.maxBattery - 4) {
      return {
        action: "CHARGE",
        nextCoord: agent.coord,
        rationale: `Tour needs ${estTotalDist} BAT vs ${agent.battery}; charging +${onCharger.chargeAmount} (slack ${turnSlack}t).`,
      };
    }

    if (
      needsChargeForTour &&
      nearestCharger &&
      nearestCharger.path.length > 0 &&
      nearestCharger.path.length <= agent.battery &&
      turnSlack >= nearestCharger.path.length + 1
    ) {
      return {
        action: "MOVE",
        nextCoord: nearestCharger.path[0],
        rationale: `Tour ${estTotalDist} hops > ${agent.battery} BAT; midpoint stop at ${nearestCharger.charger.label}.`,
      };
    }

    if (nearestDelivery && nearestDelivery.path.length > 0) {
      return {
        action: "MOVE",
        nextCoord: nearestDelivery.path[0],
        rationale: `Routing to ${nearestDelivery.delivery.label} (est. tour ${estTotalDist} hops, ${turnsLeft}t left).`,
      };
    }
  }

  return {
    action: "HOLD",
    nextCoord: agent.coord,
    rationale: "No reachable target path; holding position.",
  };
}

export function applyAgentDecision(
  agent: AgentState,
  decision: PlannedDecision,
  mission: MissionConfig,
  activeHazards: Coord[],
  nextTurn: number
): { updated: AgentState; newEvents: MissionEventPin[] } {
  const events: MissionEventPin[] = [];
  if (
    agent.status === "completed" ||
    agent.status === "failed_battery" ||
    agent.status === "failed_timeout"
  ) {
    return { updated: { ...agent, plannedPath: [] }, newEvents: events };
  }

  let nextCoord = { ...agent.coord };
  let battery = agent.battery;
  let distanceTraveled = agent.distanceTraveled;
  let chargesUsed = agent.chargesUsed;
  let invalidMoves = agent.invalidMoves;
  let actionLabel: string = decision.action;
  let rationale = decision.rationale;
  const deliveredIds = [...agent.deliveredIds];
  const path = [...agent.path];
  let status: AgentState["status"] = "active";
  let finishedTurn = agent.finishedTurn;

  if (decision.action === "CHARGE") {
    const charger = mission.chargers.find((c) => sameCoord(c.coord, agent.coord));
    if (charger) {
      battery = Math.min(agent.maxBattery, battery + charger.chargeAmount);
      chargesUsed += 1;
      status = "charging";
      actionLabel = `CHARGED +${charger.chargeAmount}`;
      events.push({
        id: `evt-chg-${agent.id}-${nextTurn}`,
        turn: nextTurn,
        type: "charge",
        agentId: agent.id,
        title: `${AGENT_PROFILES[agent.id].name} charged at ${charger.id}`,
        detail: `${charger.label} restored battery to ${battery}/${agent.maxBattery}.`,
      });
    } else {
      invalidMoves += 1;
      actionLabel = "INVALID CHARGE";
      rationale = "Charge requested off-depot; turn forfeited.";
    }
  } else if (decision.action === "MOVE") {
    const stepDist = manhattan(agent.coord, decision.nextCoord);
    const blocked = isBlocked(decision.nextCoord, mission, activeHazards);
    if (stepDist !== 1 || blocked) {
      invalidMoves += 1;
      actionLabel = "INVALID MOVE";
      rationale = `Rejected move to (${decision.nextCoord.x},${decision.nextCoord.y}); -1 penalty.`;
      battery = Math.max(0, battery - 1);
    } else if (battery < mission.moveCost) {
      battery = 0;
      status = "failed_battery";
      actionLabel = "BATTERY DEPLETED";
      rationale = "Zero battery remaining.";
    } else {
      nextCoord = { ...decision.nextCoord };
      battery = Math.max(0, battery - mission.moveCost);
      distanceTraveled += 1;
      path.push(nextCoord);
      actionLabel = `STEP (${nextCoord.x},${nextCoord.y})`;

      const hitDelivery = mission.deliveries.find(
        (d) => sameCoord(d.coord, nextCoord) && !deliveredIds.includes(d.id)
      );
      if (hitDelivery) {
        deliveredIds.push(hitDelivery.id);
        actionLabel = `DROP ${hitDelivery.id}`;
        events.push({
          id: `evt-del-${agent.id}-${hitDelivery.id}-${nextTurn}`,
          turn: nextTurn,
          type: "delivery",
          agentId: agent.id,
          title: `${AGENT_PROFILES[agent.id].name} reached ${hitDelivery.id}`,
          detail: `${hitDelivery.label} (${deliveredIds.length}/${mission.deliveries.length}) at ${battery} BAT.`,
        });
      }
    }
  }

  if (deliveredIds.length === mission.deliveries.length) {
    status = "completed";
    finishedTurn = nextTurn;
    events.push({
      id: `evt-fin-${agent.id}-${nextTurn}`,
      turn: nextTurn,
      type: "finish",
      agentId: agent.id,
      title: `${AGENT_PROFILES[agent.id].name} completed`,
      detail: `3/3 deliveries finished on Turn ${nextTurn} (${battery} BAT left).`,
    });
  } else if (battery <= 0) {
    status = "failed_battery";
    events.push({
      id: `evt-fail-bat-${agent.id}-${nextTurn}`,
      turn: nextTurn,
      type: "failure",
      agentId: agent.id,
      title: `${AGENT_PROFILES[agent.id].name} stalled`,
      detail: `0 BAT at (${nextCoord.x},${nextCoord.y}) on Turn ${nextTurn} (${deliveredIds.length}/3).`,
    });
  } else if (nextTurn >= mission.maxTurns) {
    status = "failed_timeout";
    events.push({
      id: `evt-fail-time-${agent.id}-${nextTurn}`,
      turn: nextTurn,
      type: "failure",
      agentId: agent.id,
      title: `${AGENT_PROFILES[agent.id].name} timed out`,
      detail: `Turn ${mission.maxTurns} limit reached at ${deliveredIds.length}/3.`,
    });
  }

  const updatedBase: AgentState = {
    ...agent,
    coord: nextCoord,
    battery,
    deliveredIds,
    status,
    finishedTurn,
    path,
    plannedPath: [],
    lastAction: actionLabel,
    lastRationale: rationale,
    distanceTraveled,
    chargesUsed,
    invalidMoves,
  };
  updatedBase.plannedPath = computeProjectedPath(
    updatedBase,
    mission,
    activeHazards,
    nextTurn + 1
  );

  return {
    updated: updatedBase,
    newEvents: events,
  };
}

export function beginNextExecutionPhase(state: ArenaState): ArenaState {
  if (state.phase === "PRE_MARKET") {
    return { ...state, phase: "RUNNING_P1", tradingStatus: "LOCKED" };
  }
  if (state.phase === "CHECKPOINT_1") {
    return { ...state, phase: "RUNNING_P2", tradingStatus: "LOCKED" };
  }
  if (state.phase === "CHECKPOINT_2") {
    return { ...state, phase: "RUNNING_P3", tradingStatus: "LOCKED" };
  }
  return state;
}

export function stepSimulationTurn(
  state: ArenaState,
  overrideDecisions?: Partial<Record<AgentId, PlannedDecision>>
): ArenaState {
  if (state.phase === "SETTLED") return state;

  let working = state;
  if (
    working.phase === "PRE_MARKET" ||
    working.phase === "CHECKPOINT_1" ||
    working.phase === "CHECKPOINT_2"
  ) {
    working = beginNextExecutionPhase(working);
  }

  const nextTurn = working.turn + 1;
  const mission = working.mission;
  const newEvents: MissionEventPin[] = [...working.events];
  const activeHazards = [...working.activeHazards];

  for (const h of mission.scheduledHazards) {
    if (
      h.triggerTurn === nextTurn &&
      !activeHazards.some((existing) => sameCoord(existing, h.coord))
    ) {
      activeHazards.push({ ...h.coord });
      newEvents.push({
        id: `evt-haz-${h.id}-${nextTurn}`,
        turn: nextTurn,
        type: "hazard",
        title: `Closure: ${h.label}`,
        detail: `Tile (${h.coord.x},${h.coord.y}) sealed on Turn ${nextTurn}. ${h.reason}.`,
      });
    }
  }

  const nextAgents: Record<AgentId, AgentState> = { ...working.agents };
  for (const id of AGENT_IDS) {
    const decision =
      overrideDecisions?.[id] ??
      decideAgentMove(working.agents[id], mission, activeHazards, nextTurn);
    const res = applyAgentDecision(
      working.agents[id],
      decision,
      mission,
      activeHazards,
      nextTurn
    );
    nextAgents[id] = res.updated;
    newEvents.push(...res.newEvents);
  }

  const allTerminal = AGENT_IDS.every((id) => {
    const s = nextAgents[id].status;
    return s === "completed" || s === "failed_battery" || s === "failed_timeout";
  });

  const [cp1, cp2] = mission.checkpoints;
  let nextPhase: RoundPhase = working.phase;
  if (allTerminal || nextTurn >= mission.maxTurns) {
    nextPhase = "SETTLED";
  } else if (nextTurn === cp1 && working.phase === "RUNNING_P1") {
    nextPhase = "CHECKPOINT_1";
    newEvents.push({
      id: `evt-cp1-${nextTurn}`,
      turn: nextTurn,
      type: "checkpoint",
      title: "Checkpoint 1 / Trading Open",
      detail: `Turn ${nextTurn}/${mission.maxTurns}. Positions unlocked prior to Phase 2.`,
    });
  } else if (nextTurn === cp2 && working.phase === "RUNNING_P2") {
    nextPhase = "CHECKPOINT_2";
    newEvents.push({
      id: `evt-cp2-${nextTurn}`,
      turn: nextTurn,
      type: "checkpoint",
      title: "Checkpoint 2 / Final Window",
      detail: `Turn ${nextTurn}/${mission.maxTurns}. Final trading window before sprint.`,
    });
  }

  let nextMarkets = working.markets;
  let nextUserCredits = working.userCredits;
  let nextPositions = working.positions;
  let nextEvidence = working.evidence;

  if (nextPhase === "SETTLED") {
    const settledMarkets: Record<AgentId, AgentMarket> = { ...working.markets };
    const settledPositions: Record<AgentId, UserPosition> = { ...working.positions };
    let payoutSum = 0;

    for (const id of AGENT_IDS) {
      const won = nextAgents[id].status === "completed";
      const resolution: OutcomeSide = won ? "YES" : "NO";
      settledMarkets[id] = {
        ...settledMarkets[id],
        resolution,
      };
      const pos = settledPositions[id];
      const winningShares = resolution === "YES" ? pos.yesShares : pos.noShares;
      const payout = Number((winningShares * PAYOUT_PER_SHARE).toFixed(2));
      payoutSum += payout;
      settledPositions[id] = {
        ...pos,
        settledPayoutCredits: payout,
      };
    }

    nextMarkets = settledMarkets;
    nextPositions = settledPositions;
    nextUserCredits = Number((working.userCredits + payoutSum).toFixed(2));
    nextEvidence = {
      ...working.evidence,
      settledAt: new Date().toISOString(),
    };
    newEvents.push({
      id: `evt-settled-${nextTurn}`,
      turn: nextTurn,
      type: "checkpoint",
      title: "Round Settled",
      detail: `Winning shares settled at ${PAYOUT_PER_SHARE} CR each.`,
    });
  }

  const snapshot = createSnapshot(
    nextTurn,
    nextPhase,
    activeHazards,
    nextAgents,
    nextMarkets
  );

  return {
    ...working,
    turn: nextTurn,
    phase: nextPhase,
    tradingStatus: getTradingStatusForPhase(nextPhase),
    activeHazards,
    agents: nextAgents,
    markets: nextMarkets,
    userCredits: nextUserCredits,
    positions: nextPositions,
    events: newEvents,
    history: [...working.history, snapshot],
    evidence: nextEvidence,
  };
}

export function executeMarketTrade(
  state: ArenaState,
  params: {
    agentId: AgentId;
    action: "BUY" | "SELL";
    side: OutcomeSide;
    amount: number;
    trader?: string;
    traderType?: "user" | "crowd";
  }
): { state: ArenaState; error?: string } {
  if (state.tradingStatus !== "OPEN") {
    return {
      state,
      error: `Window ${state.tradingStatus} in ${state.phase}. Wait for next checkpoint.`,
    };
  }

  const { agentId, action, side, amount } = params;
  const trader = params.trader ?? "you";
  const traderType = params.traderType ?? "user";
  const market = state.markets[agentId];
  const pos = state.positions[agentId];

  if (!Number.isFinite(amount) || amount <= 0) {
    return { state, error: "Amount must exceed zero." };
  }

  const yesPriceBefore = market.yesPrice;

  if (action === "BUY") {
    if (traderType === "user" && amount > state.userCredits + 1e-6) {
      return {
        state,
        error: `Insufficient balance (${state.userCredits.toFixed(2)} CR available).`,
      };
    }

    const { updatedMarket, shares, avgPricePerShare } = applyBuyTrade(
      market,
      side,
      amount
    );

    const updatedPos: UserPosition =
      traderType === "user"
        ? {
            ...pos,
            yesShares:
              side === "YES"
                ? Number((pos.yesShares + shares).toFixed(4))
                : pos.yesShares,
            noShares:
              side === "NO"
                ? Number((pos.noShares + shares).toFixed(4))
                : pos.noShares,
            netCostCredits: Number((pos.netCostCredits + amount).toFixed(2)),
          }
        : pos;

    const trade: TradeRecord = {
      id: `trd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: new Date().toISOString(),
      turn: state.turn,
      trader,
      traderType,
      agentId,
      action: "BUY",
      side,
      shares,
      creditsDelta: -Number(amount.toFixed(2)),
      avgPricePerShare,
      yesPriceBefore,
      yesPriceAfter: updatedMarket.yesPrice,
    };

    const nextMarkets = { ...state.markets, [agentId]: updatedMarket };
    const nextHistory = [...state.history];
    const lastIdx = nextHistory.length - 1;
    if (lastIdx >= 0) {
      nextHistory[lastIdx] = {
        ...nextHistory[lastIdx],
        prices: {
          ...nextHistory[lastIdx].prices,
          [agentId]: { yes: updatedMarket.yesPrice, no: updatedMarket.noPrice },
        },
      };
    }

    return {
      state: {
        ...state,
        markets: nextMarkets,
        positions: { ...state.positions, [agentId]: updatedPos },
        userCredits:
          traderType === "user"
            ? Number((state.userCredits - amount).toFixed(2))
            : state.userCredits,
        trades: [trade, ...state.trades],
        history: nextHistory,
      },
    };
  }

  if (traderType === "user") {
    const held = side === "YES" ? pos.yesShares : pos.noShares;
    if (amount > held + 1e-4) {
      return {
        state,
        error: `Held ${held.toFixed(2)} ${side} shares.`,
      };
    }
  }

  const { updatedMarket, proceedsCredits, avgPricePerShare } = applySellTrade(
    market,
    side,
    amount
  );

  const updatedPos: UserPosition =
    traderType === "user"
      ? {
          ...pos,
          yesShares:
            side === "YES"
              ? Math.max(0, Number((pos.yesShares - amount).toFixed(4)))
              : pos.yesShares,
          noShares:
            side === "NO"
              ? Math.max(0, Number((pos.noShares - amount).toFixed(4)))
              : pos.noShares,
          netCostCredits: Number((pos.netCostCredits - proceedsCredits).toFixed(2)),
        }
      : pos;

  const trade: TradeRecord = {
    id: `trd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: new Date().toISOString(),
    turn: state.turn,
    trader,
    traderType,
    agentId,
    action: "SELL",
    side,
    shares: Number(amount.toFixed(4)),
    creditsDelta: proceedsCredits,
    avgPricePerShare,
    yesPriceBefore,
    yesPriceAfter: updatedMarket.yesPrice,
  };

  const nextMarkets = { ...state.markets, [agentId]: updatedMarket };
  const nextHistory = [...state.history];
  const lastIdx = nextHistory.length - 1;
  if (lastIdx >= 0) {
    nextHistory[lastIdx] = {
      ...nextHistory[lastIdx],
      prices: {
        ...nextHistory[lastIdx].prices,
        [agentId]: { yes: updatedMarket.yesPrice, no: updatedMarket.noPrice },
      },
    };
  }

  return {
    state: {
      ...state,
      markets: nextMarkets,
      positions: { ...state.positions, [agentId]: updatedPos },
      userCredits:
        traderType === "user"
          ? Number((state.userCredits + proceedsCredits).toFixed(2))
          : state.userCredits,
      trades: [trade, ...state.trades],
      history: nextHistory,
    },
  };
}
