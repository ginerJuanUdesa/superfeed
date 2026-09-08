import { NextRequest, NextResponse } from "next/server";
import { patchState, readState } from "@/lib/serverState";
import { isDemo, demoState } from "@/lib/demo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  // Demo mode serves a fixed, pre-arranged board and never reads the DB.
  if (isDemo()) return NextResponse.json(demoState());
  const state = await readState();
  return NextResponse.json(state);
}

export async function PATCH(req: NextRequest) {
  // In demo mode the board is read-only: swallow writes so a visitor dragging
  // tiles around never mutates the seeded state on disk.
  if (isDemo()) return NextResponse.json(demoState());
  try {
    const body = await req.json();
    if (typeof body !== "object" || body === null) {
      return NextResponse.json({ error: "body must be an object" }, { status: 400 });
    }
    const next = await patchState(body);
    return NextResponse.json(next);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
