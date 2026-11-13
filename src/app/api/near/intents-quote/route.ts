import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      originAsset?: string;
      amount?: string;
      recipient?: string;
    };

    const originAsset = body.originAsset || "nep141:wrap.near";
    const amount = body.amount || "1000000000000000000000000";
    const recipient = (body.recipient || "fiasco-demo.near").trim();
    const deadline = new Date(Date.now() + 30 * 60 * 1000).toISOString();

    const payload = {
      dry: true,
      swapType: "EXACT_INPUT",
      slippageTolerance: 100,
      originAsset,
      depositType: "INTENTS",
      destinationAsset: "nep141:usdt.tether-token.near",
      amount,
      recipient,
      recipientType: "INTENTS",
      refundTo: recipient,
      refundType: "INTENTS",
      deadline,
    };

    const res = await fetch("https://1click.chaindefuser.com/v0/quote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(6000),
    });

    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // keep raw text
    }

    return NextResponse.json({
      ok: res.ok,
      status: res.status,
      endpoint: "https://1click.chaindefuser.com/v0/quote",
      requestPayload: payload,
      response: parsed,
    });
  } catch (err) {
    return NextResponse.json({
      ok: false,
      endpoint: "https://1click.chaindefuser.com/v0/quote",
      error: err instanceof Error ? err.message : "Failed to reach NEAR Intents 1Click API",
    });
  }
}
