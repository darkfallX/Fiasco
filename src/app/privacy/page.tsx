import Link from "next/link";

export default function PrivacyPage() {
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
            DATA NOTICE / EFFECTIVE NOVEMBER 2026
          </p>
          <h1 className="mt-2 font-display text-2xl font-bold tracking-tight">
            Privacy Policy
          </h1>
        </div>

        <section className="space-y-2 border border-[#CDC3AC] bg-[#F7F2E6] p-5 text-sm text-[#5E584B]">
          <h2 className="font-display text-base font-bold text-[#1A1915]">
            01. Telemetry and Session Data
          </h2>
          <p>
            Fiasco sets one anonymous session cookie (fiasco_sid) so that your game and chips stay separate from other players. Round state is held in server memory during play. No advertising trackers, analytics pixels, or third-party profiling cookies are used.
          </p>
        </section>

        <section className="space-y-2 border border-[#CDC3AC] bg-[#F7F2E6] p-5 text-sm text-[#5E584B]">
          <h2 className="font-display text-base font-bold text-[#1A1915]">
            02. Public On-Chain Commitments
          </h2>
          <p>
            Your bets, cash-outs and payouts are recorded on a public NEAR testnet contract under an anonymous player id derived from your session cookie, together with transaction hashes and SHA-256 round commitments. These records are public and permanent.
          </p>
        </section>

        <section className="space-y-2 border border-[#CDC3AC] bg-[#F7F2E6] p-5 text-sm text-[#5E584B]">
          <h2 className="font-display text-base font-bold text-[#1A1915]">
            03. Confidential AI Inference
          </h2>
          <p>
            When NEAR AI Cloud inference is enabled on the server, only game-grid state
            coordinates and strategy directives are transmitted inside TEE-attested requests.
            No personal user credentials are sent to inference providers.
          </p>
        </section>
      </main>
    </div>
  );
}
