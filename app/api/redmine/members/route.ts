import { NextResponse } from "next/server";
import { listAllVisibleMembers } from "@/lib/redmine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const users = await listAllVisibleMembers();
    return NextResponse.json({ users });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
