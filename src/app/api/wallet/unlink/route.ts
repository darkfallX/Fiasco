import { NextRequest, NextResponse } from "next/server";
import { sessionPayload, unlinkWallet } from "@/lib/server/store";
import { sidFromRequest } from "@/lib/server/sid";

export async function POST(req: NextRequest) {
  try {
    return NextResponse.json(sessionPayload(await unlinkWallet(sidFromRequest(req))));
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Disconnect failed" }, { status: 500 });
  }
}
