import { NextRequest, NextResponse } from "next/server";
import { getAllHFSummaries, upsertHFSummaries } from "@/lib/db";
import { isDemo } from "@/lib/demo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  if (isDemo()) return NextResponse.json({ summaries: {} });
  return NextResponse.json({ summaries: getAllHFSummaries() });
}

export async function PATCH(req: NextRequest) {
  if (isDemo()) return NextResponse.json({ ok: true, written: 0 });
  try {
    const body = (await req.json()) as { summaries?: Record<string, string> };
    const entries = body.summaries;
    if (!entries || typeof entries !== "object") {
      return NextResponse.json({ error: "summaries object required" }, { status: 400 });
    }
    // Filter to well-formed string entries. A single bad value shouldn't
    // reject the whole batch — the client uploads a lot of these.
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(entries)) {
      if (typeof k === "string" && typeof v === "string" && v.length > 0) {
        clean[k] = v;
      }
    }
    if (Object.keys(clean).length) upsertHFSummaries(clean);
    return NextResponse.json({ ok: true, written: Object.keys(clean).length });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
