import { AgentId, AgentMarket, OutcomeSide } from "../types";

export const PAYOUT_PER_SHARE = 100;
export const DEFAULT_LMSR_B = 5;

/**
 * Numerically stable LMSR cost function in 100-credit payout units:
 * C(qY, qN) = b * ln(exp(qY / b) + exp(qN / b))
 */
export function lmsrCostUnits(qYes: number, qNo: number, b: number): number {
  const a = qYes / b;
  const c = qNo / b;
  const m = Math.max(a, c);
  return b * (m + Math.log(Math.exp(a - m) + Math.exp(c - m)));
}

/**
 * Current instantaneous YES and NO share prices in demo credits (0..100).
 */
export function getMarketPrices(
  qYes: number,
  qNo: number,
  b: number
): { yesPrice: number; noPrice: number } {
  const diff = (qNo - qYes) / b;
  const yesProb = 1 / (1 + Math.exp(diff));
  const yesPrice = Number((yesProb * PAYOUT_PER_SHARE).toFixed(2));
  const noPrice = Number((PAYOUT_PER_SHARE - yesPrice).toFixed(2));
  return { yesPrice, noPrice };
}

export function createAgentMarket(
  agentId: AgentId,
  question: string,
  b: number = DEFAULT_LMSR_B,
  seedQYes: number = 0,
  seedQNo: number = 0
): AgentMarket {
  const { yesPrice, noPrice } = getMarketPrices(seedQYes, seedQNo, b);
  return {
    agentId,
    question,
    b,
    qYes: seedQYes,
    qNo: seedQNo,
    yesPrice,
    noPrice,
    totalVolumeCredits: 0,
    tradeCount: 0,
    initialSubsidyMax: Number((b * Math.LN2 * PAYOUT_PER_SHARE).toFixed(2)),
    resolution: null,
  };
}

/**
 * Exact shares received when spending `spendCredits` on `side`.
 * Derived analytically from the LMSR cost difference.
 */
export function quoteBuyByCredits(
  market: AgentMarket,
  side: OutcomeSide,
  spendCredits: number
): {
  shares: number;
  costCredits: number;
  avgPricePerShare: number;
  potentialPayout: number;
  potentialProfit: number;
  newYesPrice: number;
  newNoPrice: number;
} {
  if (spendCredits <= 0) {
    return {
      shares: 0,
      costCredits: 0,
      avgPricePerShare: side === "YES" ? market.yesPrice : market.noPrice,
      potentialPayout: 0,
      potentialProfit: 0,
      newYesPrice: market.yesPrice,
      newNoPrice: market.noPrice,
    };
  }

  const budgetUnits = spendCredits / PAYOUT_PER_SHARE;
  const qTarget = side === "YES" ? market.qYes : market.qNo;
  const qOther = side === "YES" ? market.qNo : market.qYes;
  const b = market.b;

  // Solve: b * ln(exp((qTarget + d)/b) + exp(qOther/b)) - b * ln(exp(qTarget/b) + exp(qOther/b)) = budgetUnits
  // Use log-sum-exp shift m = max(qTarget, qOther) / b for numerical safety
  const m = Math.max(qTarget, qOther) / b;
  const sumExpShifted = Math.exp(qTarget / b - m) + Math.exp(qOther / b - m);
  const rhs = Math.exp(budgetUnits / b) * sumExpShifted - Math.exp(qOther / b - m);
  const shares = b * (m + Math.log(Math.max(rhs, 1e-12))) - qTarget;

  const newQYes = side === "YES" ? market.qYes + shares : market.qYes;
  const newQNo = side === "NO" ? market.qNo + shares : market.qNo;
  const { yesPrice: newYesPrice, noPrice: newNoPrice } = getMarketPrices(
    newQYes,
    newQNo,
    b
  );
  const potentialPayout = Number((shares * PAYOUT_PER_SHARE).toFixed(2));
  const potentialProfit = Number((potentialPayout - spendCredits).toFixed(2));
  const avgPricePerShare = shares > 0 ? Number((spendCredits / shares).toFixed(2)) : 0;

  return {
    shares: Number(shares.toFixed(4)),
    costCredits: Number(spendCredits.toFixed(2)),
    avgPricePerShare,
    potentialPayout,
    potentialProfit,
    newYesPrice,
    newNoPrice,
  };
}

/**
 * Exact credits returned when selling `sharesToSell` of `side` back to the AMM.
 */
export function quoteSellShares(
  market: AgentMarket,
  side: OutcomeSide,
  sharesToSell: number
): {
  shares: number;
  proceedsCredits: number;
  avgPricePerShare: number;
  newYesPrice: number;
  newNoPrice: number;
} {
  if (sharesToSell <= 0) {
    return {
      shares: 0,
      proceedsCredits: 0,
      avgPricePerShare: side === "YES" ? market.yesPrice : market.noPrice,
      newYesPrice: market.yesPrice,
      newNoPrice: market.noPrice,
    };
  }

  const b = market.b;
  const oldCost = lmsrCostUnits(market.qYes, market.qNo, b);
  const newQYes = side === "YES" ? market.qYes - sharesToSell : market.qYes;
  const newQNo = side === "NO" ? market.qNo - sharesToSell : market.qNo;
  const newCost = lmsrCostUnits(newQYes, newQNo, b);

  const proceedsCredits = Number(((oldCost - newCost) * PAYOUT_PER_SHARE).toFixed(2));
  const { yesPrice: newYesPrice, noPrice: newNoPrice } = getMarketPrices(
    newQYes,
    newQNo,
    b
  );
  const avgPricePerShare =
    sharesToSell > 0 ? Number((proceedsCredits / sharesToSell).toFixed(2)) : 0;

  return {
    shares: Number(sharesToSell.toFixed(4)),
    proceedsCredits: Math.max(0, proceedsCredits),
    avgPricePerShare,
    newYesPrice,
    newNoPrice,
  };
}

export function applyBuyTrade(
  market: AgentMarket,
  side: OutcomeSide,
  spendCredits: number
): { updatedMarket: AgentMarket; shares: number; avgPricePerShare: number } {
  const quote = quoteBuyByCredits(market, side, spendCredits);
  const qYes = side === "YES" ? market.qYes + quote.shares : market.qYes;
  const qNo = side === "NO" ? market.qNo + quote.shares : market.qNo;
  const { yesPrice, noPrice } = getMarketPrices(qYes, qNo, market.b);

  return {
    shares: quote.shares,
    avgPricePerShare: quote.avgPricePerShare,
    updatedMarket: {
      ...market,
      qYes,
      qNo,
      yesPrice,
      noPrice,
      totalVolumeCredits: Number((market.totalVolumeCredits + spendCredits).toFixed(2)),
      tradeCount: market.tradeCount + 1,
    },
  };
}

export function applySellTrade(
  market: AgentMarket,
  side: OutcomeSide,
  sharesToSell: number
): { updatedMarket: AgentMarket; proceedsCredits: number; avgPricePerShare: number } {
  const quote = quoteSellShares(market, side, sharesToSell);
  const qYes = side === "YES" ? market.qYes - sharesToSell : market.qYes;
  const qNo = side === "NO" ? market.qNo - sharesToSell : market.qNo;
  const { yesPrice, noPrice } = getMarketPrices(qYes, qNo, market.b);

  return {
    proceedsCredits: quote.proceedsCredits,
    avgPricePerShare: quote.avgPricePerShare,
    updatedMarket: {
      ...market,
      qYes,
      qNo,
      yesPrice,
      noPrice,
      totalVolumeCredits: Number(
        (market.totalVolumeCredits + quote.proceedsCredits).toFixed(2)
      ),
      tradeCount: market.tradeCount + 1,
    },
  };
}
