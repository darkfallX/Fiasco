import { NextRequest, NextResponse } from "next/server";
import { walletKey } from "@/lib/server/store";
import { sidFromRequest } from "@/lib/server/sid";

/** Nonce and block height the browser needs to sign the player's next action. */
export async function GET(req: NextRequest) {
  try {
    const key = await walletKey(sidFromRequest(req));
    if (!key) return NextResponse.json({ error: "No wallet key found" }, { status: 404 });
    return NextResponse.json({ nonce: key.nonce, blockHeight: key.blockHeight });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Key lookup failed" }, { status: 500 });
  }
}
