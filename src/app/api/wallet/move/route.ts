import { NextRequest, NextResponse } from "next/server";
import { moveChips, sessionPayload } from "@/lib/server/store";
import { sidFromRequest } from "@/lib/server/sid";
import type { DelegatePayload } from "@/lib/near/delegate";

/** Cash chips out to the player's wallet as CHIP, or buy back in. */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { direction?: "out" | "in"; meta?: DelegatePayload };
    if ((body.direction !== "out" && body.direction !== "in") || !body.meta) {
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }
    const { session, error } = await moveChips(sidFromRequest(req), body.direction, body.meta);
    if (error) return NextResponse.json({ error }, { status: 400 });
    return NextResponse.json(sessionPayload(session));
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Move failed" }, { status: 500 });
  }
}
