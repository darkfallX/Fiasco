export type Coord = {
  x: number;
  y: number;
};

export type AgentId = "vanguard" | "gridwise" | "pivot";

export type OutcomeSide = "YES" | "NO";

export type RoundPhase =
  | "PRE_MARKET"
  | "RUNNING_P1"
  | "CHECKPOINT_1"
  | "RUNNING_P2"
  | "CHECKPOINT_2"
  | "RUNNING_P3"
  | "SETTLED";

export type TradingStatus = "OPEN" | "LOCKED" | "SETTLED";

export type AgentStatus =
  | "ready"
  | "active"
  | "charging"
  | "completed"
  | "failed_battery"
  | "failed_timeout";

export type DeliveryPoint = {
  id: string;
  label: string;
  coord: Coord;
};

export type ChargerStation = {
  id: string;
  label: string;
  coord: Coord;
  chargeAmount: number;
};

export type ScheduledHazard = {
  id: string;
  triggerTurn: number;
  coord: Coord;
  label: string;
  reason: string;
};

export type MissionConfig = {
  id: string;
  seed: string;
  title: string;
  subtitle: string;
  question: string;
  difficulty: "Standard" | "Hazard" | "Extreme";
  width: number;
  height: number;
  maxTurns: number;
  startCoord: Coord;
  startBattery: number;
  maxBattery: number;
  moveCost: number;
  buildings: Coord[];
  deliveries: DeliveryPoint[];
  chargers: ChargerStation[];
  scheduledHazards: ScheduledHazard[];
  checkpoints: [number, number];
};

export type AgentProfile = {
  id: AgentId;
  name: string;
  callsign: string;
  color: string;
  softBg: string;
  strategyTitle: string;
  strategySummary: string;
  disclosedPromptHint: string;
  record: {
    standardWins: number;
    standardTotal: number;
    hazardWins: number;
    hazardTotal: number;
    avgBatteryLeft: number;
  };
};

export type AgentState = {
  id: AgentId;
  coord: Coord;
  battery: number;
  maxBattery: number;
  deliveredIds: string[];
  status: AgentStatus;
  finishedTurn: number | null;
  path: Coord[];
  plannedPath: Coord[];
  lastAction: string;
  lastRationale: string;
  distanceTraveled: number;
  chargesUsed: number;
  invalidMoves: number;
  inferenceSource: "local-policy" | "near-ai-cloud";
};

export type AgentMarket = {
  agentId: AgentId;
  question: string;
  b: number;
  qYes: number;
  qNo: number;
  yesPrice: number;
  noPrice: number;
  totalVolumeCredits: number;
  tradeCount: number;
  initialSubsidyMax: number;
  resolution: OutcomeSide | null;
};

export type TradeRecord = {
  id: string;
  timestamp: string;
  turn: number;
  trader: string;
  traderType: "user" | "crowd";
  agentId: AgentId;
  action: "BUY" | "SELL";
  side: OutcomeSide;
  shares: number;
  creditsDelta: number;
  avgPricePerShare: number;
  yesPriceBefore: number;
  yesPriceAfter: number;
};

export type UserPosition = {
  agentId: AgentId;
  yesShares: number;
  noShares: number;
  netCostCredits: number;
  settledPayoutCredits: number;
};

export type MissionEventPin = {
  id: string;
  turn: number;
  type: "hazard" | "checkpoint" | "delivery" | "charge" | "failure" | "finish";
  agentId?: AgentId;
  title: string;
  detail: string;
};

export type TurnSnapshot = {
  turn: number;
  phase: RoundPhase;
  activeHazards: Coord[];
  agents: Record<AgentId, AgentState>;
  prices: Record<AgentId, { yes: number; no: number }>;
};

export type OnChainReceipt = {
  id: string;
  note?: string;
  method: string;
  txHash: string;
  signerId: string;
  contractId: string;
  timestamp: string;
  explorerUrl: string;
};

export type VerificationEvidence = {
  missionHash: string;
  actionLogHash: string;
  settlementHash: string;
  verifierVersion: string;
  settledAt: string | null;
  nearAiAttestation: {
    mode: "local-policy" | "near-ai-cloud";
    model: string;
    nonce: string | null;
    signature: string | null;
    teeProvider: string | null;
    note: string;
  };
  nearContractSpec: {
    contractId: string;
    network: "testnet";
    rpcUrl: string;
    deployed: boolean;
    wasmCompiled: boolean;
    receipts: OnChainReceipt[];
  };
};

export type RoundSeed = {
  source: "near-block" | "local";
  blockHeight: number | null;
  blockHash: string;
};

export type PunterView = {
  id: string;
  name: string;
  style: string;
  bankroll: number;
  lastBet: string | null;
  out: boolean;
};

export type ChainStatus = {
  enabled: boolean;
  playerId: string;
  contractId: string;
  pendingOps: number;
  confirmedOps: number;
  rejectedOps: number;
};

export type ArenaState = {
  roundId: string;
  seed: RoundSeed;
  punters: PunterView[];
  chain: ChainStatus;
  mission: MissionConfig;
  turn: number;
  phase: RoundPhase;
  tradingStatus: TradingStatus;
  activeHazards: Coord[];
  agents: Record<AgentId, AgentState>;
  markets: Record<AgentId, AgentMarket>;
  userCredits: number;
  initialUserCredits: number;
  positions: Record<AgentId, UserPosition>;
  trades: TradeRecord[];
  events: MissionEventPin[];
  history: TurnSnapshot[];
  evidence: VerificationEvidence;
};
