import { NextRequest, NextResponse } from "next/server";
import {
  clearGmailClassifications,
  getAllGmailClassifications,
  upsertGmailClassifications,
  type GmailClassificationRow,
} from "@/lib/db";
import { isDemo } from "@/lib/demo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  if (isDemo()) return NextResponse.json({ classifications: {} });
  return NextResponse.json({ classifications: getAllGmailClassifications() });
}

export async function PATCH(req: NextRequest) {
  if (isDemo()) return NextResponse.json({ ok: true, written: 0 });
  try {
    const body = (await req.json()) as {
      classifications?: Record<string, Partial<GmailClassificationRow>>;
    };
    const entries = body.classifications;
    if (!entries || typeof entries !== "object") {
      return NextResponse.json(
        { error: "classifications object required" },
        { status: 400 }
      );
    }
    const clean: Record<string, GmailClassificationRow> = {};
    for (const [id, v] of Object.entries(entries)) {
      if (!v || typeof v !== "object") continue;
      if (typeof v.summary !== "string") continue;
      clean[id] = {
        summary: v.summary,
        isSpam: v.isSpam === true,
        isAlert: v.isAlert === true,
      };
    }
    if (Object.keys(clean).length) upsertGmailClassifications(clean);
    return NextResponse.json({ ok: true, written: Object.keys(clean).length });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE() {
  if (isDemo()) return NextResponse.json({ ok: true });
  clearGmailClassifications();
  return NextResponse.json({ ok: true });
}
