import { NextRequest, NextResponse } from "next/server";
import {
  probeAll,
  probeAllServers,
  type FleetEndpoint,
  type FleetServer,
} from "@/lib/fleet";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      endpoints?: FleetEndpoint[];
      servers?: FleetServer[];
    };
    const endpoints = (Array.isArray(body.endpoints) ? body.endpoints : [])
      .filter((e) => e && typeof e.host === "string" && e.host.trim())
      .filter((e) => typeof e.port === "number" && Number.isFinite(e.port) && e.port > 0)
      .map((e) => ({
        label: (e.label ?? "").trim() || `${e.host}:${e.port}`,
        host: e.host.trim(),
        port: Math.floor(e.port),
      }));
    const servers = (Array.isArray(body.servers) ? body.servers : [])
      .filter((s) => s && typeof s.host === "string" && s.host.trim())
      .map((s) => ({
        label: (s.label ?? "").trim() || s.host,
        host: s.host.trim(),
      }));
    const [endpointResults, serverResults] = await Promise.all([
      probeAll(endpoints),
      probeAllServers(servers),
    ]);
    return NextResponse.json({
      results: endpointResults,
      servers: serverResults,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
