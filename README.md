# Fiasco

Three AI couriers race to make three deliveries across a toy city before the battery or the clock runs out. Roads close mid-run. You bet chips on who finishes and who falls apart.

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

## The economy

The economy is the game. Nothing in it is scripted.

- **Prices come from a market maker.** Each courier has a FINISHES / FAILS market priced by LMSR (`src/lib/market/lmsr.ts`, liquidity `b = 5`). Every bet moves the price for everyone after it.
- **Three NPC punters bet in every game.** Mako backs favourites with big stakes, Dottie bets small, Rook fades the crowd. Each has one bankroll that persists across every player's rounds. They set the opening odds from a form book, bet again at each window based on what the couriers have actually done, win and lose real chips, and sit out a round when they go broke.
- **The form book learns.** Punters start from measured finish rates per map and fold in every settled round, so opening odds drift as results come in. No patch needed.
- **Every round is new.** The map is derived from the hash of the latest final NEAR block (`src/lib/sim/variation.ts`). Same block hash, same round, so anyone can recompute it. Across 400 seeds per map each courier finishes between roughly 20% and 98% of the time depending on the map (`npm run tune` prints the table).

## What is on NEAR

Contract: `contracts/fiasco-market` (Rust, near-sdk 5.5), deployed on testnet at `fiasco.sr-mfz6qx.testnet`.

The contract is the chip ledger. It holds a balance for every player and every punter, and for each round it holds the markets, the positions and the result.

- `bet` and `sell`: the contract recomputes the LMSR price itself and rejects any trade that is off the curve by more than 0.5%. It also rejects bets while a round is locked and bets a balance cannot cover.
- `settle`: stores the result hashes and pays 100 chips per winning share straight into each bettor's balance.
- `void`: an abandoned round returns every stake.
- `publish`: commits the mission hash and the NEAR block the round was seeded from.

Players never see any of this. The game answers instantly from the server engine and writes each action to the contract in order, batched into one transaction at a time (`src/lib/server/store.ts`). The header shows a write counter; LEDGER > ON-CHAIN shows your on-chain balance, the punters' balances, the round state and a link for every transaction. In testing, server and on-chain balances matched to the cent.

## What is not built

- **Players do not hold keys.** The game's relayer account signs every ledger write on the player's behalf, under an anonymous id taken from the session cookie. This is custody by the game server. There is no wallet login and no withdrawal.
- **Chips are test chips.** They live in the contract's own ledger, not in a NEP-141 token, and have no value.
- **Testnet only.**
- **The couriers run a local policy by default.** They are driven by three fixed strategies in `src/lib/sim/engine.ts`. Setting `NEAR_AI_API_KEY` routes each move through NEAR AI Cloud with a TEE attestation request; this path was not exercised during the final test pass.
- **Game state is in server memory.** Sessions and the form book reset when the server restarts (chip balances are read back from the contract). It needs a long-running Node host, not a serverless one.
- **The NEAR Intents panel is a preview.** PORTFOLIO in the Ledger view fetches a dry-run 1Click quote. Nothing is swapped.

## Turning the chain on locally

Without configuration the game runs on a local ledger and says LOCAL LEDGER in the header. To write to testnet:

```bash
cp .env.example .env.local      # fill in a funded testnet account and its key
npm run contract:build          # needs Rust with the wasm32-unknown-unknown target
npm run contract:deploy         # creates fiasco.<your-account>, deploys, initialises
```

Put the printed `NEAR_CONTRACT_ID` in `.env.local` and restart.

## Checks

```bash
npm run test:engine   # market maths, round variation, ledger encoding, full simulated rounds
npm run tune          # finish rates per courier over 400 seeded rounds per map
npm run build         # typecheck and production bundle
```

## Trailer

The 90-second trailer is the real game played from a fixed script (`src/film/timeline.ts`, shown at `/film`; add `?preview=1` to watch it live). It is rendered frame by frame, so it is smooth on any machine. With the dev server running:

```bash
npm run film:picture   # 1080p picture, about ten minutes
npm run film:voice     # scratch voice lines (needs Python and edge-tts)
npm run film:voice:eleven   # or: ElevenLabs voice, needs ELEVENLABS_API_KEY in .env.local
npm run film:audio     # original music and sound effects, synthesised
npm run film:mix       # video/out/fiasco-trailer.mp4
```

To use your own voice recordings, replace the files in `video/vo/` and run `npm run film:mix` again.

## Layout

| Path | What it is |
|---|---|
| `src/components/CityStage.tsx` | The 3D city (three.js): couriers, closures, effects, camera |
| `src/components/FiascoApp.tsx`, `Tote.tsx` | Game screen, tote board, bet slip, punters |
| `src/components/ChainLedger.tsx` | Read-only view of the contract |
| `src/lib/sim/engine.ts` | Courier simulation and round phases |
| `src/lib/sim/variation.ts` | Seeded per-round map |
| `src/lib/market/lmsr.ts` | Market maker |
| `src/lib/server/store.ts` | Per-player sessions, punters, ledger queue |
| `src/lib/near/testnet.ts` | Relayer, contract calls, block seed |
| `contracts/fiasco-market/src/lib.rs` | The contract |

Libraries: Next.js 15, React 19, three.js, Tailwind CSS 4, near-api-js, near-sdk-rs. Large parts of the code were written with AI assistance.

MIT licensed. Terms and privacy pages are at `/terms` and `/privacy`.
