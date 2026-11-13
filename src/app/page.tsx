import { headers } from "next/headers";
import { getSession, sessionPayload } from "@/lib/server/store";
import { FiascoApp } from "@/components/FiascoApp";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const sid = (await headers()).get("x-fiasco-sid") ?? "";
  const session = await getSession(sid);
  const { arena, archive } = sessionPayload(session);
  return <FiascoApp initialArena={arena} initialArchive={archive} />;
}
