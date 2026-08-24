import { NextRequest, NextResponse } from "next/server";
import {
  probeEndpoint,
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
    const servers = (Array.isArray(body.servers) ? body.servers : [])
      .filter((s) => s && typeof s.host === "string" && s.host.trim())
      .map((s) => ({
        label: (s.label ?? "").trim() || s.host,
        host: s.host.trim(),
      }));
    // Services can reference a server by its label instead of a raw host,
    // so the user doesn't have to duplicate the IP on every port row. If
    // the `host` field of a service exactly matches a server label, we
    // rewrite it to that server's actual host before probing.
    const serverByLabel = new Map(servers.map((s) => [s.label, s.host]));
    const endpoints = (Array.isArray(body.endpoints) ? body.endpoints : [])
      .filter((e) => e && typeof e.host === "string" && e.host.trim())
      .filter((e) => typeof e.port === "number" && Number.isFinite(e.port) && e.port > 0)
      .map((e) => {
        const raw = e.host.trim();
        const resolved = serverByLabel.get(raw) ?? raw;
        return {
          label: (e.label ?? "").trim() || `${raw}:${e.port}`,
          // The raw host is what the user typed — a server alias or a
          // literal IP — and it's what the module renders. `probeHost`
          // is what we actually TCP to (may be the alias resolved).
          host: raw,
          probeHost: resolved,
          port: Math.floor(e.port),
        };
      });
    const [endpointResults, serverResults] = await Promise.all([
      Promise.all(
        endpoints.map(async (e) => {
          const r = await probeEndpoint({
            label: e.label,
            host: e.probeHost,
            port: e.port,
          });
          // Show the user what they wrote, not the resolved IP.
          return { ...r, host: e.host };
        })
      ),
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
