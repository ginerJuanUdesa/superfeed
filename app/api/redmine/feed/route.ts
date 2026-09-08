import { NextRequest, NextResponse } from "next/server";
import { listIssues } from "@/lib/redmine";
import { isDemo, demoRedmineIssues } from "@/lib/demo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface FeedBody {
  projectIds?: number[];
  assigneeIds?: number[];
  since?: string;
  maxPerProject?: number;
}

export async function POST(req: NextRequest) {
  if (isDemo()) return NextResponse.json({ items: demoRedmineIssues() });
  try {
    const body = (await req.json()) as FeedBody;
    const numericIds = (arr: number[] | undefined) =>
      (arr ?? []).filter((n) => typeof n === "number" && Number.isFinite(n));
    const items = await listIssues({
      projectIds: numericIds(body.projectIds),
      assigneeIds: numericIds(body.assigneeIds),
      since: body.since,
      maxPerProject: body.maxPerProject ?? 25,
    });
    return NextResponse.json({ items });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
