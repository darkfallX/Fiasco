import { NextRequest } from "next/server";

export function sidFromRequest(req: NextRequest): string {
  const sid = req.headers.get("x-fiasco-sid") || req.cookies.get("fiasco_sid")?.value || "";
  if (!/^[a-f0-9]{32}$/.test(sid)) throw new Error("Missing session");
  return sid;
}
