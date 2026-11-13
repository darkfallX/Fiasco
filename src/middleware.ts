import { NextRequest, NextResponse } from "next/server";

const SESSION_COOKIE = "fiasco_sid";
const SID_PATTERN = /^[a-f0-9]{32}$/;

/** Gives every visitor an anonymous session id, so each one plays their own game. */
export function middleware(req: NextRequest) {
  const existing = req.cookies.get(SESSION_COOKIE)?.value;
  const sid =
    existing && SID_PATTERN.test(existing) ? existing : crypto.randomUUID().replace(/-/g, "");

  const headers = new Headers(req.headers);
  headers.set("x-fiasco-sid", sid);
  const res = NextResponse.next({ request: { headers } });
  if (sid !== existing) {
    res.cookies.set(SESSION_COOKIE, sid, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
    });
  }
  return res;
}

export const config = {
  matcher: ["/", "/api/:path*"],
};
