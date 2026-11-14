# Fiasco

Three AI couriers, each driven by its own trained neural network, race to make three deliveries across a toy city before the battery or the clock runs out. Roads close mid-run. You bet chips on who finishes and who falls apart.

Built for NEAR HACKATHON, Games With Real Economies track.

**Play it now: https://fiasco.onrender.com** (no keys, no wallet, no sign-up)

## Play it

The live game is at https://fiasco.onrender.com, writing to the testnet contract.

To run it locally:

```bash
npm install
npm run dev
```

Open http://localhost:3000. No keys, no wallet, no sign-up.

1. Read the board. Every round has a different battery, clock, drop points and road closures. The yellow tags on the map show which turn each road closes.
2. Pick a courier on the right, choose FINISHES or FAILS, tap a stake, press BET. The multiplier is what the market pays right now.
3. Press START RUN (or Space). Betting locks while the couriers drive.
4. Betting reopens twice mid-run. Add to a bet, back someone else, or cash out at the current price.
5. At the end, winning bets pay 100 chips per share. Your bankroll carries into the next round. Drop below 25 and you are restaked to 1,000.
6. Optional: press CONNECT NEAR to play from your own NEAR testnet account. You approve one transaction in your wallet; after that you sign every bet yourself without popups, and you can cash your chips out to your wallet as CHIP tokens.

## The couriers

Each courier is a small neural network (16 inputs, 10 hidden units) in `src/lib/sim/brain.ts`, with its weights in `src/lib/sim/brains.json`. Every turn it lists its legal moves (step to a free neighbouring cell, or charge if it is on a charger), describes each one by features such as distance to the next drop, battery left after the move, and slack against the clock, scores them, and takes the best.

The networks were trained by evolution strategies (`scripts/train-couriers.ts`) on thousands of seeded rounds built exactly like real ones. Each courier was trained against its own reward, which is where the personalities come from:

| Courier | Trained to | Also |
|---|---|---|
| Vanguard | finish fast; every charger stop cost it | short-sighted by design: its network never sees the whole-tour features, so it plans one drop at a time |
| Gridwise | finish with battery to spare; running dry cost it most | charges about twice as often as the others |
| Pivot | simply finish, with a small bonus for speed | sees the whole tour |

Measured over 400 seeded rounds per map with the real engine (`npm run tune`):

| Map | Vanguard | Gridwise | Pivot |
|---|---|---|---|
| Sector 4 (Standard) | 83% | 69% | 84% |
| Crosswind (Hazard) | 55% | 77% | 71% |
| Low-Charge Sprint (Extreme) | 60% | 60% | 71% |

Inference is plain arithmetic, so the same seed block always plays out the same way. Retrain with `npm run train`; the tests check that the training simulator and the game engine agree turn for turn.

## The economy

The economy is the game. Nothing in it is scripted.

- **Prices come from a market maker.** Each courier has a FINISHES / FAILS market priced by LMSR (`src/lib/market/lmsr.ts`, liquidity `b = 5`). Every bet moves the price for everyone after it.
- **Three NPC punters bet in every game.** Mako backs favourites with big stakes, Dottie bets small, Rook fades the crowd. Each has one bankroll that persists across every player's rounds. They set the opening odds from a form book, bet again at each window based on what the couriers have actually done, win and lose real chips, and sit out a round when they go broke.
- **The form book learns.** Punters start from measured finish rates per map and fold in every settled round, so opening odds drift as results come in. No patch needed.
- **Every round is new.** The map is derived from the hash of the latest final NEAR block (`src/lib/sim/variation.ts`). Same block hash, same round, so anyone can recompute it.

## What is on NEAR

Contract: `contracts/fiasco-market` (Rust, near-sdk 5.5), deployed on testnet at `fiasco.sr-mfz6qx.testnet`.

The contract is the chip ledger. It holds a table balance for every player and every punter, and for each round it holds the markets, the positions, the owner and the result.

- `bet` and `sell`: the contract recomputes the LMSR price itself and rejects any trade that is off the curve by more than 0.5%. It also rejects bets while a round is locked and bets a balance cannot cover.
- `settle`: stores the result hashes and pays 100 chips per winning share straight into each bettor's balance.
- `void`: an abandoned round returns every stake.
- `publish`: commits the mission hash, the NEAR block the round was seeded from, and the round's owner.
- **CHIP token.** The contract is also a NEP-141 fungible token, CHIP (2 decimals, NEP-148 metadata, NEP-145 storage). `cash_out` moves chips from your table balance to your wallet as CHIP; `buy_in` moves them back. CHIP is an ordinary NEP-141 token once it is in your wallet: `ft_transfer` and `ft_transfer_call` work.

There are two ways to play:

- **Without a wallet (default).** You get an anonymous id from a cookie and the game's relayer writes your bets to the contract for you. Nothing to install, never see the chain.
- **With your own NEAR account.** CONNECT NEAR opens NEAR Wallet Selector (Meteor, HERE, Intear). You approve one transaction that adds a key to your account which may only call `place_bet`, `place_sell`, `cash_out` and `buy_in` on the Fiasco contract. Your browser keeps that key and signs each bet as a NEP-366 delegate action (`src/lib/near/delegate.ts`); the game relays it and pays the gas. The contract sees your account as the caller and only accepts bets on rounds you own, so the server cannot place or alter a bet for you. The server also checks each signature before relaying it and refuses anything tampered with.

Either way the game answers instantly from the server engine and writes each action to the contract in order, one transaction at a time (`src/lib/server/store.ts`). The header shows a write counter; the NEAR panel shows your on-chain balances, the punters' balances, the round state and a link for every transaction. In testing, server and on-chain balances matched to the cent.

## What is not built

- **Anonymous players are still custodied.** Without a wallet, the game's relayer signs your bets under a cookie id. Connecting a wallet is optional.
- **Chips are test chips.** Table balances live in the contract's own ledger; CHIP exists only for chips you cash out. Neither has any value.
- **Testnet only.**
- **The couriers are small trained networks, not language models.** Setting `NEAR_AI_API_KEY` routes each move through NEAR AI Cloud with a TEE attestation request instead; that path was not exercised in testing.
- **Game state is in server memory.** Sessions and the form book reset when the server restarts (chip balances are read back from the contract). It needs a long-running Node host, not a serverless one.
- **The NEAR Intents panel is a preview.** PORTFOLIO in the Ledger view fetches a dry-run 1Click quote. Nothing is swapped.

## Turning the chain on locally

Without configuration the game runs on a local ledger and says LOCAL LEDGER in the header. To write to testnet:

```bash
cp .env.example .env.local      # fill in a funded testnet account and its key
npm run contract:build          # needs Rust with the wasm32-unknown-unknown target
npm run contract:deploy         # creates fiasco.<your-account>, deploys, initialises
node scripts/upgrade-contract.mjs   # or: upgrade an existing contract in place, keeping its state
```

Put the printed `NEAR_CONTRACT_ID` in `.env.local` and restart.

## Checks

```bash
npm run test:engine   # market maths, brains, training/engine agreement, personalities, signatures, full rounds
npm run test:wallet   # live testnet: link a real account, signed bet, settle, cash out, buy in (needs .env.local and a running server)
npm run tune          # finish rates per courier over 400 seeded rounds per map
npm run train         # retrain the courier brains (a few minutes per courier)
npm run build         # typecheck and production bundle
```

## Layout

| Path | What it is |
|---|---|
| `src/components/CityStage.tsx` | The 3D city (three.js): couriers, closures, effects, camera |
| `src/components/FiascoApp.tsx`, `Tote.tsx` | Game screen, tote board, bet slip, punters |
| `src/components/ChainLedger.tsx` | Read-only view of the contract |
| `src/lib/sim/engine.ts` | Courier simulation and round phases |
| `src/lib/sim/brain.ts`, `brains.json` | Courier networks and their trained weights |
| `scripts/train-couriers.ts` | Evolution-strategies training |
| `src/lib/near/delegate.ts` | Player-signed actions (NEP-366) |
| `src/components/useWallet.ts`, `walletSelector.ts` | Wallet connection and signing in the browser |
| `src/lib/sim/variation.ts` | Seeded per-round map |
| `src/lib/market/lmsr.ts` | Market maker |
| `src/lib/server/store.ts` | Per-player sessions, punters, ledger queue |
| `src/lib/near/testnet.ts` | Relayer, contract calls, block seed |
| `contracts/fiasco-market/src/lib.rs` | The contract |

Libraries: Next.js 15, React 19, three.js, Tailwind CSS 4, near-api-js, @near-js/transactions, NEAR Wallet Selector, near-sdk-rs and near-contract-standards. Large parts of the code were written with AI assistance.

MIT licensed. Terms and privacy pages are at `/terms` and `/privacy`.
