import { NextRequest, NextResponse } from "next/server";
import { sessionPayload, tradeForSession } from "@/lib/server/store";
import { sidFromRequest } from "@/lib/server/sid";
import { AgentId, OutcomeSide } from "@/lib/types";

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      agentId?: AgentId;
      action?: "BUY" | "SELL";
      side?: OutcomeSide;
      amount?: number;
    };
    if (
      !body.agentId ||
      !["vanguard", "gridwise", "pivot"].includes(body.agentId) ||
      !body.action ||
      !["BUY", "SELL"].includes(body.action) ||
      !body.side ||
      !["YES", "NO"].includes(body.side) ||
      typeof body.amount !== "number" ||
      !Number.isFinite(body.amount) ||
      body.amount <= 0
    ) {
      return NextResponse.json({ error: "Invalid bet." }, { status: 400 });
    }

    const { session, error } = await tradeForSession(sidFromRequest(req), {
      agentId: body.agentId,
      action: body.action,
      side: body.side,
      amount: body.amount,
    });
    if (error) return NextResponse.json({ error }, { status: 400 });
    return NextResponse.json(sessionPayload(session));
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Bet failed" },
      { status: 500 }
    );
  }
}
