import assert from "node:assert/strict";
import {
  createAgentMarket,
  quoteBuyByCredits,
  quoteSellShares,
  applyBuyTrade,
  applySellTrade,
  lmsrCostUnits,
  DEFAULT_LMSR_B,
} from "../market/lmsr";
import {
  createInitialArenaState,
  executeMarketTrade,
  findShortestPath,
  stepSimulationTurn,
  AGENT_IDS,
} from "../sim/engine";
import { MISSIONS } from "../sim/missions";
import { buildRoundMission } from "../sim/variation";
import { BLIND, hasBrain, N_FEATURES } from "../sim/brain";
import { play } from "../../../scripts/courier-sim";
import brains from "../sim/brains.json";
import { KeyPair } from "@near-js/crypto";
import { signLinkProof, signPlayerAction, verifyLinkProof, verifyPayload } from "../near/delegate";

function testLmsrConservation() {
  const m = createAgentMarket("vanguard", "Test?");
  assert.equal(m.yesPrice, 50);
  assert.equal(m.noPrice, 50);

  const buyQ = quoteBuyByCredits(m, "YES", 120);
  assert.ok(buyQ.shares > 1.5 && buyQ.shares < 2.5, `Unexpected shares: ${buyQ.shares}`);

  const { updatedMarket: afterBuy, shares } = applyBuyTrade(m, "YES", 120);
  assert.ok(afterBuy.yesPrice > 50, "YES price should rise after buying YES");

  const sellQ = quoteSellShares(afterBuy, "YES", shares);
  assert.ok(
    Math.abs(sellQ.proceedsCredits - 120) < 0.05,
    `Roundtrip mismatch: ${sellQ.proceedsCredits}`
  );

  const { updatedMarket: afterSell } = applySellTrade(afterBuy, "YES", shares);
  assert.ok(Math.abs(afterSell.yesPrice - 50) < 0.05, "Price should return to 50");
  console.log("[PASS] LMSR conservation & pricing");
}

/**
 * Mirrors the contract's price check: integer e4 shares and cents, the same cost
 * function, and the same tolerance. Every trade the game produces must pass it.
 */
function testLedgerEncodingStaysOnCurve() {
  const costCents = (y: number, n: number) =>
    lmsrCostUnits(y / 10000, n / 10000, DEFAULT_LMSR_B) * 10000;
  let market = createAgentMarket("pivot", "Test?");
  let qYes = 0;
  let qNo = 0;
  const spends = [25, 50, 187, 250, 30, 999, 10, 142];
  spends.forEach((spend, i) => {
    const side = i % 3 === 0 ? "NO" : "YES";
    const { updatedMarket, shares } = applyBuyTrade(market, side, spend);
    const sharesE4 = Math.round(shares * 10000);
    const y1 = side === "YES" ? qYes + sharesE4 : qYes;
    const n1 = side === "NO" ? qNo + sharesE4 : qNo;
    const expected = costCents(y1, n1) - costCents(qYes, qNo);
    const quoted = spend * 100;
    const allowed = Math.max(5, expected * 0.005);
    assert.ok(
      Math.abs(expected - quoted) <= allowed,
      `Bet ${i} off curve: quoted ${quoted}, curve ${expected.toFixed(2)}`
    );
    qYes = y1;
    qNo = n1;
    market = updatedMarket;
  });
  console.log("[PASS] Ledger encoding stays within the contract's price tolerance");
}

function testRoundVariation() {
  for (const base of MISSIONS) {
    const a = buildRoundMission(base, "block-hash-A");
    const again = buildRoundMission(base, "block-hash-A");
    assert.deepEqual(a, again, "Same seed must give the same mission");

    const signatures = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const m = buildRoundMission(base, `seed-${i}`);
      signatures.add(JSON.stringify([m.startBattery, m.maxTurns, m.scheduledHazards, m.deliveries]));
      const closed = m.scheduledHazards.map((h) => h.coord);
      for (const d of m.deliveries) {
        assert.ok(
          findShortestPath(m.startCoord, d.coord, m, closed) !== null,
          `${base.id} seed ${i}: drop ${d.id} unreachable`
        );
      }
      assert.ok(m.checkpoints[1] < m.maxTurns, "Second window must fall inside the clock");
    }
    assert.ok(signatures.size > 30, `${base.id}: seeds should give distinct rounds`);
  }
  console.log("[PASS] Round variation is deterministic, distinct and always solvable");
}

function testOutcomesVary() {
  for (const base of MISSIONS) {
    const combos = new Set<string>();
    for (let i = 0; i < 60; i++) {
      let s = createInitialArenaState(base.id, "local-policy", "t", "c", "r", buildRoundMission(base, `v-${i}`));
      let guard = 0;
      while (s.phase !== "SETTLED" && guard++ < 80) s = stepSimulationTurn(s);
      assert.equal(s.phase, "SETTLED");
      combos.add(AGENT_IDS.map((id) => (s.agents[id].status === "completed" ? "W" : "L")).join(""));
    }
    assert.ok(combos.size >= 3, `${base.id}: results should differ between rounds, saw ${[...combos]}`);
  }
  console.log("[PASS] Results differ from round to round on every map");
}

function testAllMissionsSimulateCleanly() {
  for (const mission of MISSIONS) {
    let state = createInitialArenaState(mission.id);
    assert.equal(state.tradingStatus, "OPEN");

    const t1 = executeMarketTrade(state, {
      agentId: "vanguard",
      action: "BUY",
      side: "YES",
      amount: 100,
    });
    assert.equal(t1.error, undefined);
    state = t1.state;

    state = stepSimulationTurn(state);
    assert.equal(state.tradingStatus, "LOCKED");

    const blocked = executeMarketTrade(state, {
      agentId: "pivot",
      action: "BUY",
      side: "YES",
      amount: 50,
    });
    assert.ok(blocked.error, "Trade during execution must be rejected");

    let safety = 0;
    let sawCheckpoint1 = false;
    let sawCheckpoint2 = false;
    let sawPlannedPath = false;
    while (state.phase !== "SETTLED" && safety < 50) {
      state = stepSimulationTurn(state);
      if (AGENT_IDS.some((id) => state.agents[id].plannedPath.length > 0)) {
        sawPlannedPath = true;
      }
      if (state.phase === "CHECKPOINT_1") sawCheckpoint1 = true;
      if (state.phase === "CHECKPOINT_2") sawCheckpoint2 = true;
      safety += 1;
    }

    assert.equal(state.phase, "SETTLED", `${mission.id} should settle`);
    assert.ok(sawPlannedPath, `${mission.id} should populate projected plannedPath`);
    assert.ok(sawCheckpoint1, `${mission.id} should hit Checkpoint 1`);
    assert.ok(
      sawCheckpoint2 || state.turn <= mission.checkpoints[1],
      `${mission.id} should hit Checkpoint 2 or settle earlier`
    );

    const summary = AGENT_IDS.map(
      (id) =>
        `${id}:${state.agents[id].status}(del=${state.agents[id].deliveredIds.length}/3,bat=${state.agents[id].battery},t=${state.agents[id].finishedTurn ?? state.turn})`
    ).join(" | ");
    console.log(`[PASS] ${mission.seed} base map -> ${summary}`);
  }
}

function testBrainsLoaded() {
  for (const id of AGENT_IDS) {
    assert.ok(hasBrain(id), `${id} has trained weights`);
    assert.ok(BLIND[id].every((i) => i > 0 && i < N_FEATURES), `${id} blind list is valid`);
  }
  assert.ok((brains as { meta?: unknown }).meta, "brains.json records how it was trained");
  console.log("[PASS] All three couriers are driven by trained networks");
}

/** The training simulator must resolve every turn exactly like the game engine. */
function testTrainingSimMatchesEngine() {
  let compared = 0;
  for (const base of MISSIONS) {
    for (let i = 0; i < 25; i++) {
      const m = buildRoundMission(base, `agree-${i}`);
      let s = createInitialArenaState(base.id, "local-policy", "t", "c", "r", m);
      let guard = 0;
      while (s.phase !== "SETTLED" && guard++ < 80) s = stepSimulationTurn(s);
      for (const id of AGENT_IDS) {
        const lean = play(id, m, (brains as unknown as Record<string, number[]>)[id]);
        const real = s.agents[id];
        assert.equal(lean.status, real.status, `${base.id} #${i} ${id} status`);
        assert.equal(lean.delivered, real.deliveredIds.length, `${base.id} #${i} ${id} drops`);
        if (real.status === "completed") {
          assert.equal(lean.finished, real.finishedTurn, `${base.id} #${i} ${id} finish turn`);
          assert.equal(lean.battery, real.battery, `${base.id} #${i} ${id} battery`);
        }
        compared++;
      }
    }
  }
  console.log(`[PASS] Training simulator matches the engine on ${compared} courier runs`);
}

/** The three brains should not drive alike. */
function testPersonalitiesDiffer() {
  const totals: Record<string, { charges: number; battery: number; wins: number }> = {};
  for (const id of AGENT_IDS) totals[id] = { charges: 0, battery: 0, wins: 0 };
  for (const base of MISSIONS) {
    for (let i = 0; i < 40; i++) {
      let s = createInitialArenaState(base.id, "local-policy", "t", "c", "r", buildRoundMission(base, `style-${i}`));
      let guard = 0;
      while (s.phase !== "SETTLED" && guard++ < 80) s = stepSimulationTurn(s);
      for (const id of AGENT_IDS) {
        totals[id].charges += s.agents[id].chargesUsed;
        if (s.agents[id].status === "completed") {
          totals[id].wins++;
          totals[id].battery += s.agents[id].battery;
        }
      }
    }
  }
  const avgBattery = (id: string) => totals[id].battery / Math.max(1, totals[id].wins);
  assert.ok(totals.gridwise.charges > totals.pivot.charges, "Gridwise charges more than Pivot");
  assert.ok(totals.gridwise.charges > totals.vanguard.charges, "Gridwise charges more than Vanguard");
  assert.ok(avgBattery("gridwise") > avgBattery("pivot") + 2, "Gridwise finishes with more battery than Pivot");
  console.log(
    "[PASS] Personalities differ: charges " +
      AGENT_IDS.map((id) => `${id} ${totals[id].charges}`).join(", ") +
      " | battery at finish " +
      AGENT_IDS.map((id) => `${id} ${avgBattery(id).toFixed(1)}`).join(", ")
  );
}

/** Player-signed actions: a valid signature verifies, any change to the action breaks it. */
async function testSignedActions() {
  const kp = KeyPair.fromRandom("ed25519");
  const signed = await signPlayerAction({
    secretKey: kp.toString(),
    senderId: "alice.testnet",
    receiverId: "fiasco.testnet",
    methodName: "place_bet",
    args: { round_id: "R1", agent: "pivot", yes: true, shares_e4: 15000, cents: 10000 },
    nonce: BigInt(42),
    blockHeight: 1000,
  });
  assert.ok(verifyPayload(signed), "signed bet verifies");
  assert.ok(!verifyPayload({ ...signed, args: { ...signed.args, cents: 1 } }), "changed stake fails");
  assert.ok(!verifyPayload({ ...signed, senderId: "mallory.testnet" }), "changed sender fails");
  assert.ok(!verifyPayload({ ...signed, nonce: "43" }), "changed nonce fails");
  const proof = signLinkProof(kp.toString(), "alice.testnet", 123);
  assert.ok(verifyLinkProof(kp.getPublicKey().toString(), "alice.testnet", 123, proof), "login proof verifies");
  assert.ok(!verifyLinkProof(kp.getPublicKey().toString(), "bob.testnet", 123, proof), "login proof is bound to the account");
  console.log("[PASS] Player-signed bets verify, and any change breaks the signature");
}

testLmsrConservation();
testBrainsLoaded();
testTrainingSimMatchesEngine();
testPersonalitiesDiffer();
await testSignedActions();
testLedgerEncodingStaysOnCurve();
testRoundVariation();
testOutcomesVary();
testAllMissionsSimulateCleanly();
