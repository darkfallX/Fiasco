//! Fiasco market: the on-chain ledger for a courier-race betting game.
//!
//! Every player and every NPC punter has a chip balance here. Bets are priced by an
//! LMSR market maker that this contract recomputes itself, so the game server cannot
//! credit a bet at a price the curve does not support. Settlement pays winning shares
//! straight into balances.
//!
//! Units: shares are stored in 1e-4 share units (e4), chips in cents.
//! One winning share pays 100 chips, so one e4 unit pays exactly one cent.

use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, AccountId, PanicOnDefault};

const AGENTS: [&str; 3] = ["vanguard", "gridwise", "pivot"];
const LMSR_B: f64 = 5.0;
const STARTING_CENTS: u64 = 100_000;
const REBUY_BELOW_CENTS: u64 = 2_500;

const OPEN: u8 = 0;
const LOCKED: u8 = 1;
const SETTLED: u8 = 2;
const VOID: u8 = 3;

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Round {
    pub mission_hash: String,
    pub seed_hash: String,
    pub seed_height: u64,
    pub action_log_hash: String,
    pub settlement_hash: String,
    pub status: u8,
    pub winners: Vec<String>,
    pub bettors: Vec<String>,
    pub updated_at_ns: u64,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, Default)]
pub struct Market {
    pub q_yes_e4: i64,
    pub q_no_e4: i64,
    pub volume_cents: u64,
    pub trades: u32,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, Default)]
pub struct Position {
    pub yes_e4: u64,
    pub no_e4: u64,
    pub net_cost_cents: i64,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, Default)]
pub struct Player {
    pub balance_cents: u64,
    pub bets: u32,
    pub rounds_settled: u32,
    pub rebuys: u32,
    pub staked_cents: u64,
    pub paid_out_cents: u64,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, Default)]
pub struct Stats {
    pub rounds: u64,
    pub settled: u64,
    pub players: u64,
    pub bets: u64,
    pub volume_cents: u64,
}

/// One ledger operation. Unused fields are sent as empty or zero.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct Op {
    pub kind: String,
    pub round_id: String,
    pub player: String,
    pub agent: String,
    pub yes: bool,
    pub shares_e4: u64,
    pub cents: u64,
    pub a: String,
    pub b: String,
    pub n: u64,
    pub winners: Vec<String>,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct FiascoMarket {
    pub owner: AccountId,
    pub verifier: AccountId,
    pub rounds: LookupMap<String, Round>,
    pub markets: LookupMap<String, Market>,
    pub positions: LookupMap<String, Position>,
    pub players: LookupMap<String, Player>,
    pub stats: Stats,
}

fn lmsr_cost_units(q_yes_e4: i64, q_no_e4: i64) -> f64 {
    let a = (q_yes_e4 as f64 / 10_000.0) / LMSR_B;
    let c = (q_no_e4 as f64 / 10_000.0) / LMSR_B;
    let m = if a > c { a } else { c };
    LMSR_B * (m + ((a - m).exp() + (c - m).exp()).ln())
}

/// Cents moved by taking the market from (y0, n0) to (y1, n1). Positive when buying.
fn lmsr_delta_cents(y0: i64, n0: i64, y1: i64, n1: i64) -> f64 {
    (lmsr_cost_units(y1, n1) - lmsr_cost_units(y0, n0)) * 10_000.0
}

fn within_tolerance(expected: f64, quoted: u64) -> bool {
    let diff = (expected - quoted as f64).abs();
    let allowed = if expected * 0.005 > 5.0 { expected * 0.005 } else { 5.0 };
    diff <= allowed
}

#[near]
impl FiascoMarket {
    #[init]
    pub fn new(verifier: AccountId) -> Self {
        Self {
            owner: env::predecessor_account_id(),
            verifier,
            rounds: LookupMap::new(b"r"),
            markets: LookupMap::new(b"m"),
            positions: LookupMap::new(b"p"),
            players: LookupMap::new(b"u"),
            stats: Stats::default(),
        }
    }

    /// Applies a batch of ledger operations in order. A rejected operation is reported
    /// in the result and skipped; it never rolls back the ones around it.
    pub fn apply(&mut self, ops: Vec<Op>) -> Vec<String> {
        let caller = env::predecessor_account_id();
        require!(
            caller == self.verifier || caller == self.owner,
            "Only the game verifier can write to the ledger"
        );
        ops.into_iter()
            .map(|op| match self.apply_one(&op) {
                Ok(()) => "ok".to_string(),
                Err(e) => format!("rejected {}: {}", op.kind, e),
            })
            .collect()
    }

    fn apply_one(&mut self, op: &Op) -> Result<(), String> {
        match op.kind.as_str() {
            "publish" => self.op_publish(op),
            "lock" => self.op_lock(op),
            "bet" => self.op_bet(op),
            "sell" => self.op_sell(op),
            "settle" => self.op_settle(op),
            "void" => self.op_void(op),
            "rebuy" => self.op_rebuy(op),
            _ => Err("unknown operation".to_string()),
        }
    }

    fn ensure_player(&mut self, id: &str) {
        if !self.players.contains_key(id) {
            self.players.insert(
                id.to_string(),
                Player {
                    balance_cents: STARTING_CENTS,
                    ..Default::default()
                },
            );
            self.stats.players += 1;
        }
    }

    fn op_publish(&mut self, op: &Op) -> Result<(), String> {
        if op.round_id.is_empty() || op.round_id.len() > 64 {
            return Err("bad round id".into());
        }
        if self.rounds.contains_key(&op.round_id) {
            return Err("round already exists".into());
        }
        self.rounds.insert(
            op.round_id.clone(),
            Round {
                mission_hash: op.a.clone(),
                seed_hash: op.b.clone(),
                seed_height: op.n,
                action_log_hash: String::new(),
                settlement_hash: String::new(),
                status: OPEN,
                winners: vec![],
                bettors: vec![],
                updated_at_ns: env::block_timestamp(),
            },
        );
        self.stats.rounds += 1;
        Ok(())
    }

    fn op_lock(&mut self, op: &Op) -> Result<(), String> {
        let round = self.rounds.get_mut(&op.round_id).ok_or("round not found")?;
        if round.status == SETTLED || round.status == VOID {
            return Err("round is closed".into());
        }
        round.status = if op.yes { LOCKED } else { OPEN };
        round.updated_at_ns = env::block_timestamp();
        Ok(())
    }

    fn open_round_check(&self, op: &Op) -> Result<(), String> {
        let round = self.rounds.get(&op.round_id).ok_or("round not found")?;
        if round.status != OPEN {
            return Err("betting window is closed".into());
        }
        if !AGENTS.contains(&op.agent.as_str()) {
            return Err("unknown courier".into());
        }
        if op.player.is_empty() || op.player.len() > 64 {
            return Err("bad player id".into());
        }
        if op.shares_e4 == 0 || op.shares_e4 > 10_000_000 {
            return Err("bad share amount".into());
        }
        Ok(())
    }

    fn op_bet(&mut self, op: &Op) -> Result<(), String> {
        self.open_round_check(op)?;
        let mkey = format!("{}|{}", op.round_id, op.agent);
        let market = self.markets.get(&mkey).cloned().unwrap_or_default();
        let d = op.shares_e4 as i64;
        let (y1, n1) = if op.yes {
            (market.q_yes_e4 + d, market.q_no_e4)
        } else {
            (market.q_yes_e4, market.q_no_e4 + d)
        };
        let expected = lmsr_delta_cents(market.q_yes_e4, market.q_no_e4, y1, n1);
        if !within_tolerance(expected, op.cents) {
            return Err(format!("price off curve, curve says {} cents", expected.round()));
        }

        self.ensure_player(&op.player);
        let player = self.players.get_mut(&op.player).ok_or("player missing")?;
        if player.balance_cents < op.cents {
            return Err("insufficient chips".into());
        }
        player.balance_cents -= op.cents;
        player.bets += 1;
        player.staked_cents += op.cents;

        self.markets.insert(
            mkey,
            Market {
                q_yes_e4: y1,
                q_no_e4: n1,
                volume_cents: market.volume_cents + op.cents,
                trades: market.trades + 1,
            },
        );

        let pkey = format!("{}|{}|{}", op.round_id, op.agent, op.player);
        let mut pos = self.positions.get(&pkey).cloned().unwrap_or_default();
        if op.yes {
            pos.yes_e4 += op.shares_e4;
        } else {
            pos.no_e4 += op.shares_e4;
        }
        pos.net_cost_cents += op.cents as i64;
        self.positions.insert(pkey, pos);

        let round = self.rounds.get_mut(&op.round_id).ok_or("round not found")?;
        if !round.bettors.contains(&op.player) {
            round.bettors.push(op.player.clone());
        }
        self.stats.bets += 1;
        self.stats.volume_cents += op.cents;
        Ok(())
    }

    fn op_sell(&mut self, op: &Op) -> Result<(), String> {
        self.open_round_check(op)?;
        let pkey = format!("{}|{}|{}", op.round_id, op.agent, op.player);
        let mut pos = self.positions.get(&pkey).cloned().ok_or("no position")?;
        let held = if op.yes { pos.yes_e4 } else { pos.no_e4 };
        // The game rounds holdings to 4 decimals, so allow one unit of slack.
        if op.shares_e4 > held + 1 {
            return Err("selling more than held".into());
        }
        let sold = if op.shares_e4 > held { held } else { op.shares_e4 };

        let mkey = format!("{}|{}", op.round_id, op.agent);
        let market = self.markets.get(&mkey).cloned().unwrap_or_default();
        let d = sold as i64;
        let (y1, n1) = if op.yes {
            (market.q_yes_e4 - d, market.q_no_e4)
        } else {
            (market.q_yes_e4, market.q_no_e4 - d)
        };
        let expected = -lmsr_delta_cents(market.q_yes_e4, market.q_no_e4, y1, n1);
        if !within_tolerance(expected, op.cents) {
            return Err(format!("price off curve, curve says {} cents", expected.round()));
        }

        if op.yes {
            pos.yes_e4 -= sold;
        } else {
            pos.no_e4 -= sold;
        }
        pos.net_cost_cents -= op.cents as i64;
        self.positions.insert(pkey, pos);

        self.markets.insert(
            mkey,
            Market {
                q_yes_e4: y1,
                q_no_e4: n1,
                volume_cents: market.volume_cents + op.cents,
                trades: market.trades + 1,
            },
        );

        let player = self.players.get_mut(&op.player).ok_or("player missing")?;
        player.balance_cents += op.cents;
        self.stats.volume_cents += op.cents;
        Ok(())
    }

    fn op_settle(&mut self, op: &Op) -> Result<(), String> {
        for w in op.winners.iter() {
            if !AGENTS.contains(&w.as_str()) {
                return Err("unknown courier in winners".into());
            }
        }
        let bettors = {
            let round = self.rounds.get_mut(&op.round_id).ok_or("round not found")?;
            if round.status == SETTLED || round.status == VOID {
                return Err("round is closed".into());
            }
            round.action_log_hash = op.a.clone();
            round.settlement_hash = op.b.clone();
            round.winners = op.winners.clone();
            round.status = SETTLED;
            round.updated_at_ns = env::block_timestamp();
            round.bettors.clone()
        };

        for player_id in bettors.iter() {
            let mut payout: u64 = 0;
            for agent in AGENTS.iter() {
                let pkey = format!("{}|{}|{}", op.round_id, agent, player_id);
                if let Some(pos) = self.positions.get(&pkey) {
                    let won = op.winners.iter().any(|w| w == agent);
                    payout += if won { pos.yes_e4 } else { pos.no_e4 };
                }
            }
            if let Some(player) = self.players.get_mut(player_id) {
                player.balance_cents += payout;
                player.paid_out_cents += payout;
                player.rounds_settled += 1;
            }
        }
        self.stats.settled += 1;
        Ok(())
    }

    /// Abandoned round: every bettor gets their net stake back.
    fn op_void(&mut self, op: &Op) -> Result<(), String> {
        let bettors = {
            let round = self.rounds.get_mut(&op.round_id).ok_or("round not found")?;
            if round.status == SETTLED || round.status == VOID {
                return Err("round is closed".into());
            }
            round.status = VOID;
            round.updated_at_ns = env::block_timestamp();
            round.bettors.clone()
        };
        for player_id in bettors.iter() {
            let mut net: i64 = 0;
            for agent in AGENTS.iter() {
                let pkey = format!("{}|{}|{}", op.round_id, agent, player_id);
                if let Some(pos) = self.positions.get(&pkey) {
                    net += pos.net_cost_cents;
                }
            }
            if let Some(player) = self.players.get_mut(player_id) {
                let next = player.balance_cents as i64 + net;
                player.balance_cents = if next < 0 { 0 } else { next as u64 };
            }
        }
        Ok(())
    }

    fn op_rebuy(&mut self, op: &Op) -> Result<(), String> {
        if op.player.is_empty() || op.player.len() > 64 {
            return Err("bad player id".into());
        }
        self.ensure_player(&op.player);
        let player = self.players.get_mut(&op.player).ok_or("player missing")?;
        if player.balance_cents >= REBUY_BELOW_CENTS {
            return Err("balance too high to rebuy".into());
        }
        player.balance_cents = STARTING_CENTS;
        player.rebuys += 1;
        Ok(())
    }

    pub fn get_round(&self, round_id: String) -> Option<Round> {
        self.rounds.get(&round_id).cloned()
    }

    pub fn get_player(&self, player: String) -> Option<Player> {
        self.players.get(&player).cloned()
    }

    pub fn get_players(&self, players: Vec<String>) -> Vec<Option<Player>> {
        players.iter().map(|p| self.players.get(p).cloned()).collect()
    }

    pub fn get_market(&self, round_id: String, agent: String) -> Market {
        self.markets
            .get(&format!("{}|{}", round_id, agent))
            .cloned()
            .unwrap_or_default()
    }

    pub fn get_position(&self, round_id: String, agent: String, player: String) -> Position {
        self.positions
            .get(&format!("{}|{}|{}", round_id, agent, player))
            .cloned()
            .unwrap_or_default()
    }

    pub fn get_stats(&self) -> Stats {
        self.stats.clone()
    }

    pub fn get_verifier(&self) -> AccountId {
        self.verifier.clone()
    }
}
