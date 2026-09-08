import { NextResponse } from "next/server";
import { listAllVisibleMembers } from "@/lib/redmine";
import { isDemo, demoRedmineMembers } from "@/lib/demo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  if (isDemo()) return NextResponse.json({ users: demoRedmineMembers() });
  try {
    const users = await listAllVisibleMembers();
    return NextResponse.json({ users });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
