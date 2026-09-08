import { NextRequest, NextResponse } from "next/server";
import { fetchOpenPRs } from "@/lib/github";
import { isDemo, demoGithubPRs } from "@/lib/demo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  user?: string;
  token?: string;
}

export async function POST(req: NextRequest) {
  if (isDemo()) return NextResponse.json({ items: demoGithubPRs() });
  try {
    const body = (await req.json()) as Body;
    const user = body.user?.trim();
    if (!user) {
      return NextResponse.json({ error: "Missing GitHub username." }, { status: 400 });
    }
    const items = await fetchOpenPRs({
      user,
      token: body.token?.trim() || undefined,
    });
    return NextResponse.json({ items });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
