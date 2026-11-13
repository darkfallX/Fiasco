import { FilmApp } from "@/components/FilmApp";
import { DEFAULT_RPC_URL, viewLedger } from "@/lib/near/testnet";
import type { SeedBlock } from "@/film/timeline";

export const dynamic = "force-dynamic";

async function rpcBlock(params: unknown): Promise<SeedBlock | null> {
  try {
    const res = await fetch(process.env.NEAR_TESTNET_RPC_URL || DEFAULT_RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "film", method: "block", params }),
      signal: AbortSignal.timeout(5000),
    });
    const json = (await res.json()) as { result?: { header?: { height?: number; hash?: string } } };
    const h = json.result?.header;
    return h?.hash && typeof h.height === "number" ? { height: h.height, hash: h.hash } : null;
  } catch {
    return null;
  }
}

/**
 * The trailer. Plays the real game from a fixed script so it can be rendered frame by
 * frame (see video/capture.mjs). Add ?preview=1 to watch it in real time.
 */
export default async function FilmPage({
  searchParams,
}: {
  searchParams: Promise<{ url?: string }>;
}) {
  const { url } = await searchParams;

  // Four consecutive real blocks seed the four cities in the "new block, new city" shot.
  const blocks: SeedBlock[] = [];
  const latest = await rpcBlock({ finality: "final" });
  if (latest) {
    blocks.push(latest);
    for (let i = 1; i < 12 && blocks.length < 4; i++) {
      const prev = await rpcBlock({ block_id: latest.height - i });
      if (prev) blocks.push(prev);
    }
  }

  const [stats, punters] = await Promise.all([
    viewLedger<{ rounds: number; bets: number; volume_cents: number }>("get_stats", {}),
    viewLedger<({ balance_cents: number } | null)[]>("get_players", {
      players: ["npc:mako", "npc:dottie", "npc:rook"],
    }),
  ]);

  return (
    <FilmApp
      blocks={blocks.length === 4 ? blocks : []}
      punterBanks={punters?.every(Boolean) ? punters.map((p) => (p ? p.balance_cents / 100 : 1000)) : undefined}
      ledger={
        stats
          ? {
              contractId: process.env.NEAR_CONTRACT_ID || "fiasco.sr-mfz6qx.testnet",
              rounds: stats.rounds,
              bets: stats.bets,
              stakedCents: stats.volume_cents,
            }
          : null
      }
      playUrl={url}
    />
  );
}
