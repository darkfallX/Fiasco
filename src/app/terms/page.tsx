import Link from "next/link";

export default function TermsPage() {
  return (
    <div className="min-h-screen bg-[#F7F2E6] text-[#1A1915]">
      <header className="border-b border-[#CDC3AC] bg-[#F7F2E6]">
        <div className="mx-auto max-w-4xl px-6 h-14 flex items-center justify-between">
          <Link href="/" className="font-display text-sm font-bold tracking-tight text-[#1A1915]">
            FIASCO
          </Link>
          <Link
            href="/"
            className="border border-[#CDC3AC] bg-[#E6DDC8] px-3 py-1 font-mono-num text-xs text-[#1A1915]"
          >
            BACK TO THE GAME
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-6 py-10 space-y-8">
        <div className="border-b border-[#CDC3AC] pb-4">
          <p className="font-mono-num text-[11px] uppercase tracking-widest text-[#5E584B]">
            LEGAL / EFFECTIVE NOVEMBER 2026
          </p>
          <h1 className="mt-2 font-display text-2xl font-bold tracking-tight">
            Terms of Service
          </h1>
        </div>

        <section className="space-y-2 border border-[#CDC3AC] bg-[#F7F2E6] p-5 text-sm text-[#5E584B]">
          <h2 className="font-display text-base font-bold text-[#1A1915]">
            01. Experimental Hackathon Environment
          </h2>
          <p>
            Fiasco is an experimental hackathon game. You bet test chips on whether AI couriers finish their delivery run. Chips have no monetary value and cannot be redeemed for money or for any mainnet asset.
          </p>
        </section>

        <section className="space-y-2 border border-[#CDC3AC] bg-[#F7F2E6] p-5 text-sm text-[#5E584B]">
          <h2 className="font-display text-base font-bold text-[#1A1915]">
            02. NEAR Testnet Transactions
          </h2>
          <p>
            Bets, cash-outs and payouts are written to a contract on the NEAR testnet by the game's own relayer account. Testnet tokens and balances hold no real-world value and may be reset by network operators at any time.
          </p>
        </section>

        <section className="space-y-2 border border-[#CDC3AC] bg-[#F7F2E6] p-5 text-sm text-[#5E584B]">
          <h2 className="font-display text-base font-bold text-[#1A1915]">
            03. Deterministic Settlement Policy
          </h2>
          <p>
            All round resolutions are governed by published mission rules and deterministic
            state transitions. In the event of platform interruption or invalid third-party API
            output, the simulator enforces documented fallback or void rules without manual
            intervention.
          </p>
        </section>
      </main>
    </div>
  );
}
