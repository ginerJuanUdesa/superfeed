import { NextRequest, NextResponse } from "next/server";
import { patchState, readState } from "@/lib/serverState";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const state = await readState();
  return NextResponse.json(state);
}

export async function PATCH(req: NextRequest) {
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
