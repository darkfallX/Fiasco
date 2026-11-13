import { NextRequest, NextResponse } from "next/server";
import { resetArenaRound, sessionPayload } from "@/lib/server/store";
import { sidFromRequest } from "@/lib/server/sid";
import { MISSIONS } from "@/lib/sim/missions";

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as { missionId?: string };
    const missionId = MISSIONS.some((m) => m.id === body.missionId) ? body.missionId : undefined;
    const session = await resetArenaRound(sidFromRequest(req), missionId);
    return NextResponse.json(sessionPayload(session));
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to start round" },
      { status: 500 }
    );
  }
}
