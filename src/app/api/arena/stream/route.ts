import { NextRequest, NextResponse } from "next/server";
import { getSession, sessionPayload, subscribeArenaStream } from "@/lib/server/store";
import { sidFromRequest } from "@/lib/server/sid";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const session = await getSession(sidFromRequest(req));
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let keepAlive: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream({
    start(controller) {
      const send = (payload: unknown) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        } catch {
          // stream already closed
        }
      };
      send(sessionPayload(session));
      unsubscribe = subscribeArenaStream(session, send);
      keepAlive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          if (keepAlive) clearInterval(keepAlive);
        }
      }, 15000);
    },
    cancel() {
      if (unsubscribe) unsubscribe();
      if (keepAlive) clearInterval(keepAlive);
    },
  });

  return new NextResponse(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
