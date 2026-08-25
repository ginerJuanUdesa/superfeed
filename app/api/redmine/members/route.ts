import { NextRequest, NextResponse } from "next/server";
import { listMembersUnion } from "@/lib/redmine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  projectIds?: number[];
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as Body;
    const projectIds = (body.projectIds ?? []).filter(
      (n) => typeof n === "number" && Number.isFinite(n)
    );
    const users = await listMembersUnion(projectIds);
    return NextResponse.json({ users });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
