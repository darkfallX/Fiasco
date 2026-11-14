//! Fiasco market: the on-chain ledger for a courier-race betting game.
//!
//! Every player and every NPC punter has a chip balance here. Bets are priced by an
//! LMSR market maker that this contract recomputes itself, so the game server cannot
//! credit a bet at a price the curve does not support. Settlement pays winning shares
//! straight into balances.
//!
//! Units: shares are stored in 1e-4 share units (e4), chips in cents.
//! One winning share pays 100 chips, so one e4 unit pays exactly one cent.
//!
//! Two kinds of player:
//! - Anonymous players (ids like "p:abc...") are custodied: the game's verifier account
//!   writes their bets through `apply`.
//! - Players with a NEAR account sign their own bets (`place_bet`, `place_sell`), usually
//!   as NEP-366 meta transactions that the game relays, so they never pay gas or see a
//!   popup. Their table chips can be cashed out to their wallet as CHIP, a NEP-141 token
//!   issued by this contract, and bought back in.

use near_contract_standards::fungible_token::events::{FtBurn, FtMint};
use near_contract_standards::fungible_token::metadata::{
    FungibleTokenMetadata, FungibleTokenMetadataProvider, FT_METADATA_SPEC,
};
use near_contract_standards::fungible_token::{
    FungibleToken, FungibleTokenCore, FungibleTokenResolver,
};
use near_contract_standards::storage_management::{
    StorageBalance, StorageBalanceBounds, StorageManagement,
};
use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, AccountId, NearToken, PanicOnDefault, PromiseOrValue};

const CHIP_ICON: &str = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' fill='%231A1915'/%3E%3Crect x='6' y='6' width='20' height='20' fill='%23E2A400'/%3E%3Cpath d='M12 11h9v3h-6v2h5v3h-5v5h-3z' fill='%231A1915'/%3E%3C/svg%3E";

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
    /// CHIP, the NEP-141 token for chips that have left the table for a wallet.
    pub token: FungibleToken,
    /// Who may place self-signed bets in each round.
    pub round_owner: LookupMap<String, String>,
}

/// Layout of the v0.2 contract, read once by `migrate`.
#[near(serializers = [borsh])]
pub struct FiascoMarketV2 {
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
            token: FungibleToken::new(b"t".to_vec()),
            round_owner: LookupMap::new(b"o"),
        }
    }

    /// Upgrades a v0.2 contract in place: every balance, round and stat is kept.
    #[private]
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        let old: FiascoMarketV2 = env::state_read().expect("No v0.2 state to migrate");
        Self {
            owner: old.owner,
            verifier: old.verifier,
            rounds: old.rounds,
            markets: old.markets,
            positions: old.positions,
            players: old.players,
            stats: old.stats,
            token: FungibleToken::new(b"t".to_vec()),
            round_owner: LookupMap::new(b"o"),
        }
    }

    // ------------------------------------------------------------ self-signed play

    fn require_round_owner(&self, round_id: &str, player: &str) {
        match self.round_owner.get(round_id) {
            Some(owner) if owner == player => {}
            _ => env::panic_str("This round belongs to another player"),
        }
    }

    fn signed_op(kind: &str, round_id: String, agent: String, yes: bool, shares_e4: u64, cents: u64) -> Op {
        Op {
            kind: kind.to_string(),
            round_id,
            player: env::predecessor_account_id().to_string(),
            agent,
            yes,
            shares_e4,
            cents,
            a: String::new(),
            b: String::new(),
            n: 0,
            winners: vec![],
        }
    }

    /// A bet signed by the player's own NEAR account. Same price check as `apply`.
    pub fn place_bet(&mut self, round_id: String, agent: String, yes: bool, shares_e4: u64, cents: u64) {
        let op = Self::signed_op("bet", round_id, agent, yes, shares_e4, cents);
        self.require_round_owner(&op.round_id, &op.player);
        if let Err(e) = self.op_bet(&op) {
            env::panic_str(&e);
        }
    }

    /// A cash-out of shares back to the market, signed by the player's own account.
    pub fn place_sell(&mut self, round_id: String, agent: String, yes: bool, shares_e4: u64, cents: u64) {
        let op = Self::signed_op("sell", round_id, agent, yes, shares_e4, cents);
        self.require_round_owner(&op.round_id, &op.player);
        if let Err(e) = self.op_sell(&op) {
            env::panic_str(&e);
        }
    }

    /// Moves chips from the caller's table balance to their wallet as CHIP (NEP-141).
    pub fn cash_out(&mut self, cents: u64) -> U128 {
        require!(cents > 0, "Nothing to cash out");
        let account = env::predecessor_account_id();
        let key = account.to_string();
        let player = self.players.get_mut(&key).expect("No table balance for this account");
        require!(player.balance_cents >= cents, "Not enough chips on the table");
        player.balance_cents -= cents;
        if !self.token.accounts.contains_key(&account) {
            self.token.internal_register_account(&account);
        }
        self.token.internal_deposit(&account, cents as u128);
        FtMint {
            owner_id: &account,
            amount: U128(cents as u128),
            memo: Some("cash out from the table"),
        }
        .emit();
        self.token.ft_balance_of(account)
    }

    /// Moves CHIP from the caller's wallet back onto their table balance.
    pub fn buy_in(&mut self, cents: u64) -> u64 {
        require!(cents > 0, "Nothing to buy in");
        let account = env::predecessor_account_id();
        self.token.internal_withdraw(&account, cents as u128);
        FtBurn {
            owner_id: &account,
            amount: U128(cents as u128),
            memo: Some("buy in to the table"),
        }
        .emit();
        let key = account.to_string();
        self.ensure_player(&key);
        let player = self.players.get_mut(&key).expect("player missing");
        player.balance_cents += cents;
        player.balance_cents
    }

    pub fn get_round_owner(&self, round_id: String) -> Option<String> {
        self.round_owner.get(&round_id).cloned()
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
        if !op.player.is_empty() {
            self.round_owner.insert(op.round_id.clone(), op.player.clone());
        }
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

// ------------------------------------------------------------------ NEP-141 CHIP

#[near]
impl FungibleTokenCore for FiascoMarket {
    #[payable]
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        self.token.ft_transfer(receiver_id, amount, memo)
    }

    #[payable]
    fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<U128> {
        self.token.ft_transfer_call(receiver_id, amount, memo, msg)
    }

    fn ft_total_supply(&self) -> U128 {
        self.token.ft_total_supply()
    }

    fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        self.token.ft_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenResolver for FiascoMarket {
    #[private]
    fn ft_resolve_transfer(
        &mut self,
        sender_id: AccountId,
        receiver_id: AccountId,
        amount: U128,
    ) -> U128 {
        let (used_amount, _burned_amount) =
            self.token.internal_ft_resolve_transfer(&sender_id, receiver_id, amount);
        used_amount.into()
    }
}

#[near]
impl StorageManagement for FiascoMarket {
    #[payable]
    fn storage_deposit(
        &mut self,
        account_id: Option<AccountId>,
        registration_only: Option<bool>,
    ) -> StorageBalance {
        self.token.storage_deposit(account_id, registration_only)
    }

    #[payable]
    fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance {
        self.token.storage_withdraw(amount)
    }

    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        self.token.internal_storage_unregister(force).is_some()
    }

    fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        self.token.storage_balance_bounds()
    }

    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.token.storage_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenMetadataProvider for FiascoMarket {
    fn ft_metadata(&self) -> FungibleTokenMetadata {
        FungibleTokenMetadata {
            spec: FT_METADATA_SPEC.to_string(),
            name: "Fiasco Chip".to_string(),
            symbol: "CHIP".to_string(),
            icon: Some(CHIP_ICON.to_string()),
            reference: None,
            reference_hash: None,
            decimals: 2,
        }
    }
}
