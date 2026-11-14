import { NextRequest, NextResponse } from "next/server";
import { linkWallet, sessionPayload } from "@/lib/server/store";
import { sidFromRequest } from "@/lib/server/sid";

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      accountId?: string;
      publicKey?: string;
      issuedAt?: number;
      signature?: string;
    };
    if (!body.accountId || !body.publicKey || typeof body.issuedAt !== "number" || !body.signature) {
      return NextResponse.json({ error: "Incomplete wallet login" }, { status: 400 });
    }
    const { session, error } = await linkWallet(sidFromRequest(req), {
      accountId: body.accountId,
      publicKey: body.publicKey,
      issuedAt: body.issuedAt,
      signature: body.signature,
    });
    if (error) return NextResponse.json({ error }, { status: 400 });
    return NextResponse.json(sessionPayload(session));
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Wallet login failed" }, { status: 500 });
  }
}
