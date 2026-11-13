import { NextRequest, NextResponse } from "next/server";
import { advanceArena, sessionPayload } from "@/lib/server/store";
import { sidFromRequest } from "@/lib/server/sid";

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as { mode?: "step" | "phase" };
    const session = await advanceArena(sidFromRequest(req), {
      mode: body.mode === "phase" ? "phase" : "step",
    });
    return NextResponse.json(sessionPayload(session));
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to advance the run" },
      { status: 500 }
    );
  }
}
