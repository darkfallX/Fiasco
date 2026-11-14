import {
  AGENT_IDS,
  createInitialArenaState,
  executeMarketTrade,
  findShortestPath,
  PlannedDecision,
  stepSimulationTurn,
} from "../sim/engine";
import { getMissionById } from "../sim/missions";
import { buildRoundMission } from "../sim/variation";
import { computeVerificationHashes, queryNearAiCloudDecision } from "../near/verifier";
import {
  chainEnabled,
  DEFAULT_RPC_URL,
  fetchRoundSeed,
  getActiveRelayer,
  LedgerOp,
  ledgerOp,
  sendLedgerBatch,
  viewLedger,
} from "../near/testnet";
import { AgentId, ArenaState, OnChainReceipt, OutcomeSide, PunterView } from "../types";
import { sendMetaTransaction, viewAccessKey } from "../near/testnet";
import { DelegatePayload, verifyLinkProof, verifyPayload } from "../near/delegate";

export type SettledRoundArchive = {
  roundId: string;
  missionId: string;
  missionTitle: string;
  seed: string;
  difficulty: string;
  settledAt: string;
  turnsTaken: number;
  winners: AgentId[];
  userPnlCredits: number;
  settlementHash: string;
};

type StreamPayload = { arena: ArenaState; archive: SettledRoundArchive[] };
type StreamListener = (payload: StreamPayload) => void;

/** NPC punters. They bet in every player's game from one persistent bankroll each. */
const NPCS = [
  { id: "npc:mako", name: "Mako", style: "Backs the favourite", weight: 1.3, contrarian: false },
  { id: "npc:dottie", name: "Dottie", style: "Small and safe", weight: 0.6, contrarian: false },
  { id: "npc:rook", name: "Rook", style: "Fades the crowd", weight: 1.0, contrarian: true },
] as const;
type Npc = (typeof NPCS)[number];

const STARTING_CREDITS = 1000;
const REBUY_BELOW = 25;
const NPC_MIN_BANK = 30;
const AGENT_NUM: Record<AgentId, string> = { vanguard: "1", gridwise: "2", pivot: "3" };

/** Finish rates the punters start from; real results are folded in as rounds settle. */
const PRIOR_WEIGHT = 12;
const PRIOR_RATE: Record<string, Record<AgentId, number>> = {
  "sector-4-relay": { vanguard: 0.83, gridwise: 0.69, pivot: 0.84 },
  "crosswind-chokepoint": { vanguard: 0.55, gridwise: 0.77, pivot: 0.71 },
  "low-charge-sprint": { vanguard: 0.60, gridwise: 0.60, pivot: 0.71 },
};

type NpcState = { bank: number; lastBet: string | null; out: boolean };

type Session = {
  sid: string;
  playerId: string;
  arena: ArenaState;
  archive: SettledRoundArchive[];
  listeners: Set<StreamListener>;
  lastSeen: number;
  published: boolean;
  /** False until the player bets or starts the run. Idle visits move no chips. */
  activated: boolean;
  openingStakes: Record<string, number>;
  /** What each punter did in this player's round, for the punters panel. */
  npcNotes: Record<string, string>;
  heldOps: LedgerOp[];
  queuedOps: number;
  confirmedOps: number;
  rejectedOps: number;
  /** The player's own NEAR account, when they have connected one. */
  wallet: { accountId: string; publicKey: string } | null;
  walletChips: number | null;
};

type QueueItem = {
  sid: string;
  op?: LedgerOp;
  meta?: DelegatePayload;
  onFail?: () => void;
};

type Root = {
  sessions: Map<string, Session>;
  creating: Map<string, Promise<Session>>;
  npc: Record<string, NpcState>;
  book: Record<string, Record<AgentId, { wins: number; total: number }>>;
  npcLoaded: Promise<void> | null;
  /** True once any round has moved punter chips; after that the server copy leads. */
  npcTouched: boolean;
  queue: QueueItem[];
  flushing: boolean;
};

const globalForStore = globalThis as unknown as { __fiascoRoot?: Root };

function root(): Root {
  if (!globalForStore.__fiascoRoot) {
    globalForStore.__fiascoRoot = {
      sessions: new Map(),
      creating: new Map(),
      npc: Object.fromEntries(
        NPCS.map((n) => [n.id, { bank: STARTING_CREDITS, lastBet: null, out: false }])
      ),
      book: {},
      npcLoaded: null,
      npcTouched: false,
      queue: [],
      flushing: false,
    };
  }
  return globalForStore.__fiascoRoot;
}

const round2 = (n: number) => Number(n.toFixed(2));

function hashText(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// ---------------------------------------------------------------- ledger queue

/**
 * The game answers instantly from the server engine. Every bet, cash-out, lock and
 * settlement is then written to the contract in order, batched into one transaction
 * at a time so a single relayer key never races its own nonce.
 */
function enqueue(session: Session, ops: LedgerOp[]): void {
  if (!chainEnabled() || ops.length === 0) return;
  const r = root();
  for (const op of ops) r.queue.push({ sid: session.sid, op });
  session.queuedOps += ops.length;
  void flushQueue();
}

/** A player-signed action, relayed in order with everything else. */
function enqueueMeta(session: Session, meta: DelegatePayload, onFail?: () => void): void {
  if (!chainEnabled()) return;
  root().queue.push({ sid: session.sid, meta, onFail });
  session.queuedOps += 1;
  void flushQueue();
}

function addReceipt(session: Session, receipt: OnChainReceipt): void {
  const spec = session.arena.evidence.nearContractSpec;
  session.arena = {
    ...session.arena,
    evidence: {
      ...session.arena.evidence,
      nearContractSpec: { ...spec, deployed: true, receipts: [receipt, ...spec.receipts].slice(0, 24) },
    },
  };
}

async function refreshWalletChips(session: Session): Promise<void> {
  if (!session.wallet) return;
  const raw = await viewLedger<string>("ft_balance_of", { account_id: session.wallet.accountId });
  if (raw !== null) session.walletChips = round2(Number(raw) / 100);
}

async function flushQueue(): Promise<void> {
  const r = root();
  if (r.flushing) return;
  r.flushing = true;
  try {
    while (r.queue.length > 0) {
      if (r.queue[0].meta) {
        const item = r.queue.shift() as QueueItem;
        const res = await sendMetaTransaction(item.meta as DelegatePayload);
        const session = r.sessions.get(item.sid);
        if (!session) continue;
        session.queuedOps = Math.max(0, session.queuedOps - 1);
        if (res.ok) session.confirmedOps += 1;
        else {
          session.rejectedOps += 1;
          item.onFail?.();
        }
        if (res.receipt) addReceipt(session, res.receipt);
        if (item.meta && (item.meta.methodName === "cash_out" || item.meta.methodName === "buy_in")) {
          await refreshWalletChips(session);
        }
        broadcast(session);
        continue;
      }
      const end = r.queue.findIndex((q, i) => i >= 16 || Boolean(q.meta));
      const batch = r.queue.splice(0, end === -1 ? 16 : end) as (QueueItem & { op: LedgerOp })[];
      let results: string[] = [];
      let receipt: OnChainReceipt | null = null;
      try {
        const sent = await sendLedgerBatch(batch.map((b) => b.op));
        results = sent.results;
        receipt = sent.receipt;
      } catch (err) {
        results = batch.map(
          () => `rejected: ${err instanceof Error ? err.message.slice(0, 80) : "transaction failed"}`
        );
      }

      const bySession = new Map<string, number[]>();
      batch.forEach((b, i) => {
        const list = bySession.get(b.sid) ?? [];
        list.push(i);
        bySession.set(b.sid, list);
      });

      for (const [sid, idxs] of bySession) {
        const session = r.sessions.get(sid);
        if (!session) continue;
        const mine = idxs.map((i) => ({ op: batch[i].op, result: results[i] ?? "ok" }));
        const bad = mine.filter((m) => m.result !== "ok");
        session.queuedOps = Math.max(0, session.queuedOps - mine.length);
        session.confirmedOps += mine.length - bad.length;
        session.rejectedOps += bad.length;

        if (receipt && mine.some((m) => m.op.round_id === session.arena.roundId || m.op.round_id === "")) {
          const kinds = mine.map((m) => m.op.kind);
          const method = [...new Set(kinds)]
            .map((k) => `${kinds.filter((x) => x === k).length} ${k}`)
            .join(", ");
          const spec = session.arena.evidence.nearContractSpec;
          session.arena = {
            ...session.arena,
            evidence: {
              ...session.arena.evidence,
              nearContractSpec: {
                ...spec,
                deployed: true,
                receipts: [
                  {
                    ...receipt,
                    id: `${receipt.id}-${sid.slice(0, 4)}`,
                    method,
                    note: bad.length ? bad.map((b) => b.result).join("; ") : undefined,
                  },
                  ...spec.receipts,
                ].slice(0, 24),
              },
            },
          };
        }
        broadcast(session);
      }
    }
  } finally {
    r.flushing = false;
  }
}

/**
 * First real action in a round. Until now the punters' opening bets only shaped the
 * odds; this is where their chips actually leave their bankrolls and the round goes
 * on-chain. Health checks and visitors who never play cost the punters nothing.
 */
function activateRound(session: Session): void {
  if (!session.activated) {
    session.activated = true;
    const r = root();
    r.npcTouched = true;
    for (const [id, stake] of Object.entries(session.openingStakes)) {
      r.npc[id].bank = round2(Math.max(0, r.npc[id].bank - stake));
    }
    session.openingStakes = {};
  }
  publishIfNeeded(session);
}

function publishIfNeeded(session: Session): void {
  if (session.published || !chainEnabled()) return;
  session.published = true;
  const a = session.arena;
  enqueue(session, [
    ledgerOp({
      kind: "publish",
      round_id: a.roundId,
      player: session.playerId,
      a: a.evidence.missionHash,
      b: a.seed.blockHash,
      n: a.seed.blockHeight ?? 0,
    }),
    ...session.heldOps,
  ]);
  session.heldOps = [];
}

/** Ops for a round nobody has acted in yet wait here, so idle visits cost nothing. */
function queueRoundOps(session: Session, ops: LedgerOp[]): void {
  if (!chainEnabled()) return;
  if (session.published) enqueue(session, ops);
  else session.heldOps.push(...ops);
}

// ---------------------------------------------------------------- views

function punterViews(session: Session): PunterView[] {
  const r = root();
  return NPCS.map((n) => ({
    id: n.id,
    name: n.name,
    style: n.style,
    bankroll: round2(Math.max(0, r.npc[n.id].bank - (session.openingStakes[n.id] ?? 0))),
    lastBet: session.npcNotes[n.id] ?? r.npc[n.id].lastBet,
    out: r.npc[n.id].out,
  }));
}

function stamp(session: Session): ArenaState {
  const relayer = getActiveRelayer();
  session.arena = {
    ...session.arena,
    punters: punterViews(session),
    chain: {
      enabled: chainEnabled(),
      playerId: session.playerId,
      wallet: session.wallet ? { accountId: session.wallet.accountId, chips: session.walletChips } : null,
      contractId: relayer?.contractId ?? session.arena.evidence.nearContractSpec.contractId,
      pendingOps: session.queuedOps + session.heldOps.length,
      confirmedOps: session.confirmedOps,
      rejectedOps: session.rejectedOps,
    },
  };
  return session.arena;
}

function broadcast(session: Session): void {
  const payload = { arena: stamp(session), archive: session.archive };
  for (const fn of session.listeners) {
    try {
      fn(payload);
    } catch {
      session.listeners.delete(fn);
    }
  }
}

export function subscribeArenaStream(session: Session, listener: StreamListener): () => void {
  session.listeners.add(listener);
  return () => {
    session.listeners.delete(listener);
  };
}

export function sessionPayload(session: Session): StreamPayload {
  return { arena: stamp(session), archive: session.archive };
}

// ---------------------------------------------------------------- punters

function npcForAgent(roundId: string, agentIndex: number): Npc {
  return NPCS[(agentIndex + (hashText(roundId) % NPCS.length)) % NPCS.length];
}

function finishRate(missionId: string, agent: AgentId): number {
  const prior = PRIOR_RATE[missionId]?.[agent] ?? 0.5;
  const seen = root().book[missionId]?.[agent] ?? { wins: 0, total: 0 };
  return (prior * PRIOR_WEIGHT + seen.wins) / (PRIOR_WEIGHT + seen.total);
}

function npcBet(
  session: Session,
  npc: Npc,
  agentId: AgentId,
  side: OutcomeSide,
  wanted: number
): LedgerOp | null {
  const state = root().npc[npc.id];
  if (state.out || state.bank < NPC_MIN_BANK) return null;
  const spend = Math.min(Math.round(wanted), Math.floor(state.bank * 0.3));
  if (spend < 10) return null;

  const res = executeMarketTrade(session.arena, {
    agentId,
    action: "BUY",
    side,
    amount: spend,
    trader: npc.name,
    traderType: "crowd",
  });
  if (res.error) return null;
  session.arena = res.state;
  if (session.activated) {
    state.bank = round2(state.bank - spend);
  } else {
    session.openingStakes[npc.id] = (session.openingStakes[npc.id] ?? 0) + spend;
  }
  session.npcNotes[npc.id] = `${AGENT_NUM[agentId]} ${side === "YES" ? "FINISHES" : "FAILS"} / ${spend}`;
  const trade = res.state.trades[0];
  return ledgerOp({
    kind: "bet",
    round_id: session.arena.roundId,
    player: npc.id,
    agent: agentId,
    yes: side === "YES",
    shares_e4: Math.round(trade.shares * 10000),
    cents: spend * 100,
  });
}

/** Opening prices: each punter reads the form book and this round's battery and clock. */
function runOpeningBets(session: Session): LedgerOp[] {
  const ops: LedgerOp[] = [];
  const m = session.arena.mission;
  const base = getMissionById(m.id);
  AGENT_IDS.forEach((agentId, i) => {
    const npc = npcForAgent(session.arena.roundId, i);
    let p = finishRate(m.id, agentId);
    p += (m.startBattery - base.startBattery) * 0.025 + (m.maxTurns - base.maxTurns) * 0.02;
    p = Math.max(0.05, Math.min(0.95, p));
    const edge = Math.abs(p - 0.5);
    let side: OutcomeSide = p >= 0.5 ? "YES" : "NO";
    let spend = (25 + edge * 300) * npc.weight;
    if (npc.contrarian && edge < 0.22) {
      side = side === "YES" ? "NO" : "YES";
      spend = 30;
    }
    const op = npcBet(session, npc, agentId, side, spend);
    if (op) ops.push(op);
  });
  return ops;
}

/** Checkpoint flow: punters react to what the couriers have actually done so far. */
function runCheckpointBets(session: Session): LedgerOp[] {
  const ops: LedgerOp[] = [];
  if (session.arena.tradingStatus !== "OPEN") return ops;

  AGENT_IDS.forEach((id, i) => {
    const working = session.arena;
    const agent = working.agents[id];
    const remaining = working.mission.deliveries.filter((d) => !agent.deliveredIds.includes(d.id));
    const estHops =
      remaining.length === 0
        ? 0
        : Math.min(
            ...remaining.map((d) => {
              const p = findShortestPath(agent.coord, d.coord, working.mission, working.activeHazards);
              return p ? p.length : 99;
            })
          ) +
          (remaining.length - 1) * 5;
    const turnsLeft = working.mission.maxTurns - working.turn;

    let side: OutcomeSide = "YES";
    let spend = 45;
    if (agent.status === "completed") {
      side = "YES";
      spend = 120;
    } else if (agent.status === "failed_battery" || agent.status === "failed_timeout") {
      side = "NO";
      spend = 140;
    } else if (estHops > turnsLeft) {
      side = "NO";
      spend = 110;
    } else if (agent.battery < estHops && agent.battery <= 6) {
      side = "NO";
      spend = 75;
    } else if (agent.deliveredIds.length >= 2 && agent.battery >= estHops) {
      side = "YES";
      spend = 85;
    } else {
      side = agent.deliveredIds.length >= 1 ? "YES" : "NO";
      spend = 35;
    }

    const npc = npcForAgent(working.roundId, i);
    const op = npcBet(session, npc, id, side, spend * npc.weight);
    if (op) ops.push(op);
  });
  return ops;
}

function npcRoundTotals(arena: ArenaState): Record<string, { cost: number; payout: number }> {
  const totals: Record<string, { cost: number; payout: number }> = {};
  for (const t of arena.trades) {
    if (t.traderType !== "crowd" || t.action !== "BUY") continue;
    const npc = NPCS.find((n) => n.name === t.trader);
    if (!npc) continue;
    const entry = (totals[npc.id] ??= { cost: 0, payout: 0 });
    entry.cost += -t.creditsDelta;
    if (arena.markets[t.agentId].resolution === t.side) {
      entry.payout += Math.round(t.shares * 10000) / 100;
    }
  }
  return totals;
}

function settleNpcs(session: Session): void {
  const arena = session.arena;
  const r = root();
  const totals = npcRoundTotals(arena);
  for (const [id, t] of Object.entries(totals)) {
    const net = round2(t.payout - t.cost);
    r.npc[id].bank = round2(r.npc[id].bank + t.payout);
    session.npcNotes[id] = net >= 0 ? `WON ${net.toFixed(0)}` : `LOST ${Math.abs(net).toFixed(0)}`;
  }
  const book = (r.book[arena.mission.id] ??= {
    vanguard: { wins: 0, total: 0 },
    gridwise: { wins: 0, total: 0 },
    pivot: { wins: 0, total: 0 },
  });
  for (const id of AGENT_IDS) {
    book[id].total += 1;
    if (arena.agents[id].status === "completed") book[id].wins += 1;
  }
}

/** A round dropped before settlement: stakes go back, on the server and on-chain. */
function abandonRound(session: Session): void {
  const arena = session.arena;
  if (arena.phase === "SETTLED") return;
  if (!session.activated) {
    session.openingStakes = {};
    session.heldOps = [];
    return;
  }
  const r = root();
  for (const [id, t] of Object.entries(npcRoundTotals(arena))) {
    r.npc[id].bank = round2(r.npc[id].bank + t.cost);
  }
  if (session.published) {
    enqueue(session, [ledgerOp({ kind: "void", round_id: arena.roundId })]);
  }
  session.heldOps = [];
}

async function loadNpcBanks(): Promise<void> {
  const r = root();
  if (!r.npcLoaded) {
    r.npcLoaded = (async () => {
      const rows = await viewLedger<({ balance_cents: number } | null)[]>("get_players", {
        players: NPCS.map((n) => n.id),
      });
      if (!rows) {
        // RPC did not answer in time: try again with the next visitor.
        r.npcLoaded = null;
        return;
      }
      if (r.npcTouched) return;
      rows.forEach((row, i) => {
        if (row) r.npc[NPCS[i].id].bank = round2(row.balance_cents / 100);
      });
    })();
  }
  await r.npcLoaded;
}

// ---------------------------------------------------------------- rounds

async function startRound(session: Session, missionId: string, bankroll: number): Promise<void> {
  const r = root();
  const hasNearAi = Boolean(process.env.NEAR_AI_API_KEY);
  const relayer = getActiveRelayer();
  const seed = await fetchRoundSeed();
  const base = getMissionById(missionId);
  const mission = buildRoundMission(base, seed.blockHash);

  const arena = createInitialArenaState(
    base.id,
    hasNearAi ? "near-ai-cloud" : "local-policy",
    hasNearAi
      ? process.env.NEAR_AI_MODEL || "deepseek-ai/DeepSeek-V3.1"
      : "Fiasco Deterministic Policy v2",
    relayer?.contractId || process.env.NEAR_CONTRACT_ID || "not-configured",
    process.env.NEAR_TESTNET_RPC_URL || DEFAULT_RPC_URL,
    mission
  );
  arena.roundId = `${base.seed}-${Date.now().toString(36).toUpperCase()}-${session.sid
    .slice(0, 4)
    .toUpperCase()}`;
  arena.seed = seed;
  arena.userCredits = bankroll;
  arena.initialUserCredits = bankroll;

  session.arena = arena;
  session.published = false;
  session.activated = false;
  session.openingStakes = {};
  session.npcNotes = {};
  session.heldOps = [];

  // A punter who went broke sits one round out, then rebuys.
  for (const n of NPCS) {
    const state = r.npc[n.id];
    if (state.out) {
      state.out = false;
      state.bank = STARTING_CREDITS;
      state.lastBet = "REBUY";
      enqueue(session, [ledgerOp({ kind: "rebuy", player: n.id })]);
    } else if (state.bank < NPC_MIN_BANK) {
      state.out = true;
      state.lastBet = "BUST";
    }
  }

  session.arena.evidence = computeVerificationHashes(session.arena);
  const opening = runOpeningBets(session);
  session.arena.evidence = computeVerificationHashes(session.arena);
  queueRoundOps(session, opening);
}

function evictIdleSessions(): void {
  const r = root();
  if (r.sessions.size < 200) return;
  const cutoff = Date.now() - 20 * 60 * 1000;
  const idleCutoff = Date.now() - 2 * 60 * 1000;
  for (const [sid, s] of r.sessions) {
    if (!s.activated && s.archive.length === 0 && s.lastSeen < idleCutoff && s.listeners.size === 0) {
      r.sessions.delete(sid);
    }
  }
  for (const [sid, s] of r.sessions) {
    if (s.lastSeen < cutoff && s.listeners.size === 0) {
      abandonRound(s);
      r.sessions.delete(sid);
    }
  }
}

/** Every visitor gets their own game, keyed by the session cookie. */
export async function getSession(sid: string): Promise<Session> {
  const r = root();
  const existing = r.sessions.get(sid);
  if (existing) {
    existing.lastSeen = Date.now();
    return existing;
  }
  const pending = r.creating.get(sid);
  if (pending) return pending;

  const creation = (async () => {
    evictIdleSessions();
    await loadNpcBanks();
    const playerId = `p:${sid.slice(0, 24)}`;
    const session: Session = {
      sid,
      playerId,
      arena: undefined as unknown as ArenaState,
      archive: [],
      listeners: new Set(),
      lastSeen: Date.now(),
      published: false,
      activated: false,
      openingStakes: {},
      npcNotes: {},
      heldOps: [],
      queuedOps: 0,
      confirmedOps: 0,
      rejectedOps: 0,
      wallet: null,
      walletChips: null,
    };

    // Returning players pick their chips back up from the contract.
    let bankroll = STARTING_CREDITS;
    const onChain = await viewLedger<{ balance_cents: number } | null>("get_player", {
      player: playerId,
    });
    if (onChain) {
      bankroll = round2(onChain.balance_cents / 100);
      if (bankroll < REBUY_BELOW) {
        bankroll = STARTING_CREDITS;
        enqueue(session, [ledgerOp({ kind: "rebuy", player: playerId })]);
      }
    }

    await startRound(session, "sector-4-relay", bankroll);
    r.sessions.set(sid, session);
    r.creating.delete(sid);
    return session;
  })();
  r.creating.set(sid, creation);
  return creation;
}

export async function resetArenaRound(sid: string, missionId?: string): Promise<Session> {
  const session = await getSession(sid);
  const prev = session.arena;
  abandonRound(session);

  const carried = prev.phase === "SETTLED" ? prev.userCredits : prev.initialUserCredits;
  let bankroll = round2(carried);
  if (bankroll < REBUY_BELOW) {
    bankroll = STARTING_CREDITS;
    enqueue(session, [ledgerOp({ kind: "rebuy", player: session.playerId })]);
  }

  await startRound(session, missionId || prev.mission.id, bankroll);
  broadcast(session);
  return session;
}

/** Checks a player-signed action before relaying it. Returns an error message or null. */
function checkMeta(session: Session, meta: DelegatePayload | undefined, method: DelegatePayload["methodName"]): string | null {
  const relayer = getActiveRelayer();
  if (!session.wallet) return "No wallet connected";
  if (!meta) return "This bet needs your wallet signature";
  if (meta.senderId !== session.wallet.accountId || meta.publicKey !== session.wallet.publicKey) {
    return "Signed by a different account";
  }
  if (!relayer || meta.receiverId !== relayer.contractId) return "Signed for a different contract";
  if (meta.methodName !== method) return "Signed for a different action";
  if (!verifyPayload(meta)) return "Signature does not match";
  return null;
}

const near = (a: unknown, b: number) => typeof a === "number" && Math.abs(a - b) <= 2;

export async function tradeForSession(
  sid: string,
  params: { agentId: AgentId; action: "BUY" | "SELL"; side: OutcomeSide; amount: number },
  meta?: DelegatePayload
): Promise<{ session: Session; error?: string }> {
  const session = await getSession(sid);
  const res = executeMarketTrade(session.arena, {
    ...params,
    trader: "You",
    traderType: "user",
  });
  if (res.error) return { session, error: res.error };
  const trade = res.state.trades[0];
  const sharesE4 = Math.round(trade.shares * 10000);
  const cents = Math.round(Math.abs(trade.creditsDelta) * 100);

  if (session.wallet) {
    const bad = checkMeta(session, meta, params.action === "BUY" ? "place_bet" : "place_sell");
    if (bad) return { session, error: bad };
    const a = (meta as DelegatePayload).args;
    if (
      a.round_id !== session.arena.roundId ||
      a.agent !== params.agentId ||
      a.yes !== (params.side === "YES") ||
      !near(a.shares_e4, sharesE4) ||
      !near(a.cents, cents)
    ) {
      return { session, error: "The price moved. Try again." };
    }
  }

  if (session.arena.tradingStatus === "OPEN") activateRound(session);
  session.arena = { ...res.state, punters: session.arena.punters, chain: session.arena.chain };
  session.arena.evidence = computeVerificationHashes(session.arena);
  if (session.wallet && meta) {
    enqueueMeta(session, meta);
  } else {
    enqueue(session, [
      ledgerOp({
        kind: params.action === "BUY" ? "bet" : "sell",
        round_id: session.arena.roundId,
        player: session.playerId,
        agent: params.agentId,
        yes: params.side === "YES",
        shares_e4: sharesE4,
        cents,
      }),
    ]);
  }
  broadcast(session);
  return { session };
}

// ---------------------------------------------------------------- wallets

async function bankrollFor(session: Session, playerId: string): Promise<number> {
  const onChain = await viewLedger<{ balance_cents: number } | null>("get_player", { player: playerId });
  let bankroll = onChain ? round2(onChain.balance_cents / 100) : STARTING_CREDITS;
  if (bankroll < REBUY_BELOW) {
    bankroll = STARTING_CREDITS;
    enqueue(session, [ledgerOp({ kind: "rebuy", player: playerId })]);
  }
  return bankroll;
}

/**
 * Connects a NEAR account to this game. The browser proves it holds a key that the
 * account has authorised for this contract; from then on that account owns the rounds
 * and signs its own bets. The current round is called off and its stakes returned.
 */
export async function linkWallet(
  sid: string,
  proof: { accountId: string; publicKey: string; issuedAt: number; signature: string }
): Promise<{ session: Session; error?: string }> {
  const session = await getSession(sid);
  const relayer = getActiveRelayer();
  if (!chainEnabled() || !relayer) return { session, error: "This server is not connected to NEAR" };
  if (!/^[a-z0-9._-]{2,64}$/.test(proof.accountId)) return { session, error: "That is not a NEAR account id" };
  if (Math.abs(Date.now() - proof.issuedAt) > 10 * 60 * 1000) return { session, error: "Login expired, connect again" };
  if (!verifyLinkProof(proof.publicKey, proof.accountId, proof.issuedAt, proof.signature)) {
    return { session, error: "Key check failed" };
  }
  const key = await viewAccessKey(proof.accountId, proof.publicKey);
  if (!key) return { session, error: "That key is not on the account yet. Try again in a few seconds." };
  if (!key.fullAccess && key.receiverId !== relayer.contractId) {
    return { session, error: "That key is for a different contract" };
  }
  if (session.wallet?.accountId === proof.accountId && session.wallet.publicKey === proof.publicKey) {
    return { session };
  }

  const missionId = session.arena.mission.id;
  abandonRound(session);
  session.wallet = { accountId: proof.accountId, publicKey: proof.publicKey };
  session.playerId = proof.accountId;
  session.archive = [];
  const bankroll = await bankrollFor(session, proof.accountId);
  await refreshWalletChips(session);
  await startRound(session, missionId, bankroll);
  broadcast(session);
  return { session };
}

export async function unlinkWallet(sid: string): Promise<Session> {
  const session = await getSession(sid);
  if (!session.wallet) return session;
  const missionId = session.arena.mission.id;
  abandonRound(session);
  session.wallet = null;
  session.walletChips = null;
  session.playerId = `p:${sid.slice(0, 24)}`;
  session.archive = [];
  const bankroll = await bankrollFor(session, session.playerId);
  await startRound(session, missionId, bankroll);
  broadcast(session);
  return session;
}

export async function walletKey(sid: string) {
  const session = await getSession(sid);
  if (!session.wallet) return null;
  return viewAccessKey(session.wallet.accountId, session.wallet.publicKey);
}

/** Moves chips between the table and the player's wallet (as CHIP tokens). */
export async function moveChips(
  sid: string,
  direction: "out" | "in",
  meta: DelegatePayload
): Promise<{ session: Session; error?: string }> {
  const session = await getSession(sid);
  const bad = checkMeta(session, meta, direction === "out" ? "cash_out" : "buy_in");
  if (bad) return { session, error: bad };
  const cents = Number(meta.args.cents);
  if (!Number.isInteger(cents) || cents <= 0) return { session, error: "Nothing to move" };
  const amount = cents / 100;
  if (direction === "out" && amount > session.arena.userCredits + 1e-6) {
    return { session, error: "Not that many chips on the table" };
  }
  if (direction === "in" && session.walletChips !== null && amount > session.walletChips + 1e-6) {
    return { session, error: "Not that many chips in your wallet" };
  }
  const delta = direction === "out" ? -amount : amount;
  const apply = (d: number) => {
    session.arena = {
      ...session.arena,
      userCredits: round2(session.arena.userCredits + d),
      initialUserCredits: round2(session.arena.initialUserCredits + d),
    };
  };
  apply(delta);
  if (session.walletChips !== null) session.walletChips = round2(session.walletChips - delta);
  activateRound(session);
  enqueueMeta(session, meta, () => {
    apply(-delta);
  });
  broadcast(session);
  return { session };
}

export async function advanceArena(
  sid: string,
  options: { mode: "step" | "phase" }
): Promise<Session> {
  const session = await getSession(sid);
  if (session.arena.phase === "SETTLED") return session;

  activateRound(session);
  const ops: LedgerOp[] = [];
  let current = session.arena;
  const maxSteps = options.mode === "phase" ? 15 : 1;

  for (let i = 0; i < maxSteps; i++) {
    if (current.phase === "SETTLED") break;

    let overrides: Partial<Record<AgentId, PlannedDecision>> | undefined;
    let latestAttestation = current.evidence.nearAiAttestation;

    if (process.env.NEAR_AI_API_KEY && options.mode === "step") {
      overrides = {};
      for (const id of AGENT_IDS) {
        const res = await queryNearAiCloudDecision(
          current.agents[id],
          current.mission,
          current.activeHazards,
          current.turn + 1
        );
        if (res) {
          overrides[id] = res.decision;
          if (res.attestation) {
            latestAttestation = {
              mode: "near-ai-cloud",
              model: process.env.NEAR_AI_MODEL || "deepseek-ai/DeepSeek-V3.1",
              nonce: res.attestation.nonce,
              signature: res.attestation.signature,
              teeProvider: res.attestation.teeProvider,
              note: "Live TEE-signed response verified via cloud-api.near.ai.",
            };
          }
        }
      }
    }

    const before = current;
    current = stepSimulationTurn(current, overrides);
    current.evidence = { ...current.evidence, nearAiAttestation: latestAttestation };

    if (before.tradingStatus === "OPEN" && current.tradingStatus === "LOCKED") {
      ops.push(ledgerOp({ kind: "lock", round_id: current.roundId, yes: true }));
    } else if (before.tradingStatus === "LOCKED" && current.tradingStatus === "OPEN") {
      ops.push(ledgerOp({ kind: "lock", round_id: current.roundId, yes: false }));
    } else if (
      before.tradingStatus === "OPEN" &&
      current.tradingStatus === "SETTLED"
    ) {
      // settled straight out of a betting window; nothing to lock
    }

    if (
      before.phase !== current.phase &&
      (current.phase === "CHECKPOINT_1" ||
        current.phase === "CHECKPOINT_2" ||
        current.phase === "SETTLED")
    ) {
      break;
    }
  }

  session.arena = current;

  if (current.phase === "CHECKPOINT_1" || current.phase === "CHECKPOINT_2") {
    ops.push(...runCheckpointBets(session));
  }

  session.arena.evidence = computeVerificationHashes(session.arena);

  if (session.arena.phase === "SETTLED") {
    const settled = session.arena;
    const winners = AGENT_IDS.filter((id) => settled.agents[id].status === "completed");
    settleNpcs(session);
    ops.push(
      ledgerOp({
        kind: "settle",
        round_id: settled.roundId,
        a: settled.evidence.actionLogHash,
        b: settled.evidence.settlementHash,
        winners,
      })
    );

    if (!session.archive.some((a) => a.roundId === settled.roundId)) {
      session.archive.unshift({
        roundId: settled.roundId,
        missionId: settled.mission.id,
        missionTitle: settled.mission.title,
        seed: settled.mission.seed,
        difficulty: settled.mission.difficulty,
        settledAt: settled.evidence.settledAt || new Date().toISOString(),
        turnsTaken: settled.turn,
        winners,
        userPnlCredits: round2(settled.userCredits - settled.initialUserCredits),
        settlementHash: settled.evidence.settlementHash,
      });
    }
  }

  enqueue(session, ops);
  broadcast(session);
  return session;
}

/** On-chain view of this player, the punters and the whole ledger. */
export async function readLedger(sid: string) {
  const session = await getSession(sid);
  const relayer = getActiveRelayer();
  if (!chainEnabled() || !relayer) {
    return { enabled: false as const };
  }
  const [players, stats, round] = await Promise.all([
    viewLedger<({ balance_cents: number; bets: number; rounds_settled: number; rebuys: number } | null)[]>(
      "get_players",
      { players: [session.playerId, ...NPCS.map((n) => n.id)] }
    ),
    viewLedger<{ rounds: number; settled: number; players: number; bets: number; volume_cents: number }>(
      "get_stats",
      {}
    ),
    viewLedger<{ status: number; winners: string[]; seed_height: number; bettors: string[] } | null>(
      "get_round",
      { round_id: session.arena.roundId }
    ),
  ]);
  return {
    enabled: true as const,
    contractId: relayer.contractId,
    verifierId: relayer.accountId,
    explorerUrl: `https://testnet.nearblocks.io/address/${relayer.contractId}`,
    playerId: session.playerId,
    player: players?.[0] ?? null,
    punters: NPCS.map((n, i) => ({ id: n.id, name: n.name, onChain: players?.[i + 1] ?? null })),
    stats,
    round,
    pendingOps: session.queuedOps + session.heldOps.length,
    confirmedOps: session.confirmedOps,
    rejectedOps: session.rejectedOps,
  };
}
