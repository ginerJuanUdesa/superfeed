import { NextRequest, NextResponse } from "next/server";
import { listIssues } from "@/lib/redmine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface FeedBody {
  projectIds?: number[];
  since?: string;
  maxPerProject?: number;
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as FeedBody;
    const projectIds = (body.projectIds ?? []).filter(
      (n) => typeof n === "number" && Number.isFinite(n)
    );
    const items = await listIssues({
      projectIds,
      since: body.since,
      maxPerProject: body.maxPerProject ?? 25,
    });
    return NextResponse.json({ items });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
