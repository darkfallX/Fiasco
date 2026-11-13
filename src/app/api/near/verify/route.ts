import { NextRequest, NextResponse } from "next/server";
import { verifyNearTestnetRpc } from "@/lib/near/verifier";

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as { accountId?: string };
    const accountId =
      (body.accountId || process.env.NEAR_CONTRACT_ID || "fiasco.sr-mfz6qx.testnet").trim();
    const result = await verifyNearTestnetRpc(accountId);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Verification error" },
      { status: 500 }
    );
  }
}
