import { NextRequest, NextResponse } from "next/server";
import { readLedger } from "@/lib/server/store";
import { sidFromRequest } from "@/lib/server/sid";

/**
 * Read-only view of the on-chain ledger for this player. The signing account is set by
 * server environment variables only; this route accepts no writes.
 */
export async function GET(req: NextRequest) {
  try {
    return NextResponse.json(await readLedger(sidFromRequest(req)));
  } catch (err) {
    return NextResponse.json(
      { enabled: false, error: err instanceof Error ? err.message : "Ledger unavailable" },
      { status: 500 }
    );
  }
}
