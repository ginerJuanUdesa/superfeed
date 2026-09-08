import { NextRequest, NextResponse } from "next/server";
import { fetchFeed, HFKind } from "@/lib/hf";
import { isDemo, demoHFItems } from "@/lib/demo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (isDemo()) return NextResponse.json({ items: demoHFItems(), hasMore: false });
  try {
    const body = (await req.json()) as {
      user?: string;
      kinds?: HFKind[];
      since?: string;
      token?: string;
      fresh?: boolean;
      beforeMs?: number;
      limit?: number;
    };
    const user = (body.user ?? "").trim();
    if (!user) {
      return NextResponse.json({ error: "user is required" }, { status: 400 });
    }
    const kinds: HFKind[] = body.kinds?.length
      ? body.kinds
      : (["model", "dataset", "space", "paper"] as HFKind[]);
    const limit = body.limit && body.limit > 0 ? Math.min(body.limit, 200) : 80;
    const items = await fetchFeed({
      user,
      kinds,
      since: body.since,
      token: body.token,
      fresh: body.fresh,
      beforeMs: body.beforeMs,
      maxItems: limit,
    });
    return NextResponse.json({ items, hasMore: items.length === limit });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
