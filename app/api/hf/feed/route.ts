import { NextRequest, NextResponse } from "next/server";
import { fetchFeed, HFKind } from "@/lib/hf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      user?: string;
      kinds?: HFKind[];
      since?: string;
      token?: string;
      fresh?: boolean;
    };
    const user = (body.user ?? "").trim();
    if (!user) {
      return NextResponse.json({ error: "user is required" }, { status: 400 });
    }
    const kinds: HFKind[] = body.kinds?.length
      ? body.kinds
      : (["model", "dataset", "space", "paper"] as HFKind[]);
    const items = await fetchFeed({
      user,
      kinds,
      since: body.since,
      token: body.token,
      fresh: body.fresh,
    });
    return NextResponse.json({ items });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
