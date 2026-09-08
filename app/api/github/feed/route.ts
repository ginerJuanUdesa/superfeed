import { NextRequest, NextResponse } from "next/server";
import { fetchFeed } from "@/lib/github";
import { isDemo, demoGithubItems } from "@/lib/demo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  user?: string;
  token?: string;
  since?: string;
  max?: number;
  page?: number;
}

export async function POST(req: NextRequest) {
  if (isDemo()) return NextResponse.json({ items: demoGithubItems(), hasMore: false });
  try {
    const body = (await req.json()) as Body;
    const user = body.user?.trim();
    if (!user) {
      return NextResponse.json({ error: "Missing GitHub username." }, { status: 400 });
    }
    const { items, hasMore } = await fetchFeed({
      user,
      token: body.token?.trim() || undefined,
      since: body.since,
      max: body.max ?? 30,
      page: body.page && body.page > 0 ? Math.min(body.page, 10) : 1,
    });
    return NextResponse.json({ items, hasMore });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
