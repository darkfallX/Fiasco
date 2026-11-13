import { NextRequest, NextResponse } from "next/server";
import { getSession, sessionPayload } from "@/lib/server/store";
import { sidFromRequest } from "@/lib/server/sid";

export async function GET(req: NextRequest) {
  try {
    const session = await getSession(sidFromRequest(req));
    return NextResponse.json(sessionPayload(session));
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load game" },
      { status: 500 }
    );
  }
}
