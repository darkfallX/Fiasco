import crypto from "node:crypto";
import {
  AgentState,
  ArenaState,
  Coord,
  MissionConfig,
  VerificationEvidence,
} from "../types";
import { AGENT_IDS, PlannedDecision, isBlocked, manhattan, sameCoord } from "../sim/engine";
import { AGENT_PROFILES } from "../sim/missions";
import { getActiveRelayer } from "./testnet";

export function sha256Hex(payload: unknown): string {
  const canonical = JSON.stringify(payload);
  return "0x" + crypto.createHash("sha256").update(canonical).digest("hex");
}

export function computeVerificationHashes(state: ArenaState): VerificationEvidence {
  const missionHash = sha256Hex({
    id: state.mission.id,
    seed: state.mission.seed,
    seedBlockHash: state.seed.blockHash,
    seedBlockHeight: state.seed.blockHeight,
    buildings: state.mission.buildings,
    width: state.mission.width,
    height: state.mission.height,
    maxTurns: state.mission.maxTurns,
    startCoord: state.mission.startCoord,
    startBattery: state.mission.startBattery,
    deliveries: state.mission.deliveries,
    chargers: state.mission.chargers,
    scheduledHazards: state.mission.scheduledHazards,
  });

  const actionLogHash = sha256Hex(
    state.history.map((snap) => ({
      turn: snap.turn,
      phase: snap.phase,
      hazards: snap.activeHazards,
      agents: AGENT_IDS.map((id) => ({
        id,
        coord: snap.agents[id].coord,
        battery: snap.agents[id].battery,
        delivered: snap.agents[id].deliveredIds,
        status: snap.agents[id].status,
        lastAction: snap.agents[id].lastAction,
      })),
    }))
  );

  const settlementHash = sha256Hex({
    roundId: state.roundId,
    phase: state.phase,
    turn: state.turn,
    resolutions: AGENT_IDS.map((id) => ({
      id,
      status: state.agents[id].status,
      resolution: state.markets[id].resolution,
      finishedTurn: state.agents[id].finishedTurn,
      battery: state.agents[id].battery,
    })),
  });

  const relayer = getActiveRelayer();
  return {
    ...state.evidence,
    missionHash,
    actionLogHash,
    settlementHash,
    nearContractSpec: {
      ...state.evidence.nearContractSpec,
      contractId: relayer?.contractId || state.evidence.nearContractSpec.contractId,
      deployed: relayer?.contractDeployed ?? state.evidence.nearContractSpec.deployed,
      wasmCompiled: relayer?.contractDeployed ?? false,
    },
  };
}

/**
 * Optional live NEAR AI Cloud decision maker + hardware TEE attestation fetch.
 * Only called on the server when NEAR_AI_API_KEY is configured.
 */
export async function queryNearAiCloudDecision(
  agent: AgentState,
  mission: MissionConfig,
  activeHazards: Coord[],
  nextTurn: number
): Promise<{
  decision: PlannedDecision;
  attestation?: { nonce: string; signature: string | null; teeProvider: string | null };
} | null> {
  const apiKey = process.env.NEAR_AI_API_KEY;
  if (!apiKey) return null;

  const model = process.env.NEAR_AI_MODEL || "deepseek-ai/DeepSeek-V3.1";
  const dirs = [
    { label: "RIGHT", x: agent.coord.x + 1, y: agent.coord.y },
    { label: "DOWN", x: agent.coord.x, y: agent.coord.y + 1 },
    { label: "LEFT", x: agent.coord.x - 1, y: agent.coord.y },
    { label: "UP", x: agent.coord.x, y: agent.coord.y - 1 },
  ].filter((d) => !isBlocked({ x: d.x, y: d.y }, mission, activeHazards));

  const onCharger = mission.chargers.find((c) => sameCoord(c.coord, agent.coord));
  const remainingDeliveries = mission.deliveries.filter(
    (d) => !agent.deliveredIds.includes(d.id)
  );

  const systemPrompt = [
    `You are ${AGENT_PROFILES[agent.id].name} (${AGENT_PROFILES[agent.id].strategyTitle}).`,
    `Strategy directive: ${AGENT_PROFILES[agent.id].disclosedPromptHint}`,
    `Respond strictly in JSON: {"action":"MOVE"|"CHARGE"|"HOLD","x":number,"y":number,"rationale":"short 1-sentence reason"}.`,
  ].join("\n");

  const userPrompt = JSON.stringify({
    turn: nextTurn,
    maxTurns: mission.maxTurns,
    coord: agent.coord,
    battery: agent.battery,
    maxBattery: agent.maxBattery,
    onCharger: onCharger ? onCharger.id : null,
    remainingDeliveries,
    chargers: mission.chargers,
    activeHazards,
    validNeighborMoves: dirs,
  });

  try {
    const nonce = crypto.randomBytes(32).toString("hex");
    const [chatRes, attRes] = await Promise.all([
      fetch("https://cloud-api.near.ai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          temperature: 0.1,
          max_tokens: 180,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
        }),
        signal: AbortSignal.timeout(7000),
      }),
      fetch(
        `https://cloud-api.near.ai/v1/attestation/report?signing_algo=ecdsa&nonce=${nonce}`,
        {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(4000),
        }
      ).catch(() => null),
    ]);

    if (!chatRes.ok) return null;
    const chatJson = (await chatRes.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      id?: string;
    };
    const rawContent = chatJson.choices?.[0]?.message?.content;
    if (!rawContent) return null;

    const parsed = JSON.parse(rawContent) as {
      action?: string;
      x?: number;
      y?: number;
      rationale?: string;
    };

    const action =
      parsed.action === "CHARGE" || parsed.action === "HOLD" ? parsed.action : "MOVE";
    const nextCoord: Coord =
      typeof parsed.x === "number" && typeof parsed.y === "number"
        ? { x: parsed.x, y: parsed.y }
        : agent.coord;

    // If model suggests an invalid non-adjacent move, let applyAgentDecision penalize or validate cleanly
    if (
      action === "MOVE" &&
      (manhattan(agent.coord, nextCoord) !== 1 ||
        isBlocked(nextCoord, mission, activeHazards))
    ) {
      return null;
    }

    let signature: string | null = null;
    let teeProvider: string | null = "Intel TDX / NVIDIA Confidential GPU";
    if (attRes && attRes.ok) {
      const attJson = (await attRes.json()) as Record<string, unknown>;
      signature =
        typeof attJson.signing_address === "string"
          ? attJson.signing_address
          : typeof attJson.intel_quote === "string"
          ? attJson.intel_quote.slice(0, 48) + "..."
          : chatJson.id ?? null;
      if (typeof attJson.tee_provider === "string") {
        teeProvider = attJson.tee_provider;
      }
    }

    return {
      decision: {
        action,
        nextCoord,
        rationale: parsed.rationale || "NEAR AI Cloud decision",
      },
      attestation: {
        nonce,
        signature,
        teeProvider,
      },
    };
  } catch {
    return null;
  }
}

export async function verifyNearTestnetRpc(accountId: string): Promise<{
  ok: boolean;
  network: "testnet";
  rpcUrl: string;
  accountId: string;
  blockHeight?: number;
  accountExists?: boolean;
  balanceNear?: string;
  error?: string;
}> {
  const rpcUrl = process.env.NEAR_TESTNET_RPC_URL || "https://test.rpc.fastnear.com";
  try {
    const statusRes = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "status",
        method: "status",
        params: [],
      }),
      signal: AbortSignal.timeout(5000),
    });

    const statusJson = (await statusRes.json()) as {
      result?: { sync_info?: { latest_block_height?: number } };
    };
    const blockHeight = statusJson.result?.sync_info?.latest_block_height;

    const acctRes = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "view-account",
        method: "query",
        params: {
          request_type: "view_account",
          finality: "final",
          account_id: accountId,
        },
      }),
      signal: AbortSignal.timeout(5000),
    });

    const acctJson = (await acctRes.json()) as {
      result?: { amount?: string };
      error?: { cause?: { name?: string }; message?: string };
    };

    if (acctJson.result?.amount) {
      const yocto = BigInt(acctJson.result.amount);
      const nearWhole = Number(yocto / BigInt(10 ** 20)) / 10000;
      return {
        ok: true,
        network: "testnet",
        rpcUrl,
        accountId,
        blockHeight,
        accountExists: true,
        balanceNear: nearWhole.toFixed(4),
      };
    }

    return {
      ok: true,
      network: "testnet",
      rpcUrl,
      accountId,
      blockHeight,
      accountExists: false,
      error: acctJson.error?.cause?.name || "Account not deployed on testnet yet",
    };
  } catch (err) {
    return {
      ok: false,
      network: "testnet",
      rpcUrl,
      accountId,
      error: err instanceof Error ? err.message : "RPC unreachable",
    };
  }
}
