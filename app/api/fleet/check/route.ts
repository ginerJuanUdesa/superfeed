import { NextRequest, NextResponse } from "next/server";
import { probeAll, type FleetEndpoint } from "@/lib/fleet";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { endpoints?: FleetEndpoint[] };
    const endpoints = Array.isArray(body.endpoints) ? body.endpoints : [];
    const clean = endpoints
      .filter((e) => e && typeof e.host === "string" && e.host.trim())
      .map((e) => ({
        label: (e.label ?? "").trim() || e.host,
        host: e.host.trim(),
        port:
          typeof e.port === "number" && Number.isFinite(e.port) && e.port > 0
            ? Math.floor(e.port)
            : undefined,
      }));
    const results = await probeAll(clean);
    return NextResponse.json({ results });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
