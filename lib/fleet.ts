import net from "net";

/** A specific service listening on a host+port — probes just that port. */
export interface FleetEndpoint {
  label: string;
  host: string;
  port: number;
}

/** A whole machine — no specific port. We infer "the host is alive" by
 *  probing a small set of common ports in parallel; if ANY of them responds
 *  (whether it accepts or refuses the connection), the host answered, so
 *  it's up. Only if every probe times out do we call it down. */
export interface FleetServer {
  label: string;
  host: string;
}

export interface FleetProbeResult {
  label: string;
  host: string;
  port: number;
  reachable: boolean;
  latencyMs: number | null;
  error?: string;
  /** Server-side wall-clock at which the probe finished (ISO 8601). */
  checkedAt: string;
}

export interface FleetServerResult {
  label: string;
  host: string;
  up: boolean;
  /** Latency of the fastest port that answered (connect OR refuse). null if down. */
  latencyMs: number | null;
  /** Which of the common ports actually accepted a TCP connection (empty
   *  if the host is up but every probed port was closed/refused). */
  openPorts: number[];
  checkedAt: string;
}

const TIMEOUT_MS = 2500;
/** Common TCP ports we try when the user just gave us an IP. Order does not
 *  matter — we probe them in parallel — but the set is intentionally small
 *  so a full sweep of every server stays under one refresh interval. */
const SERVER_PROBE_PORTS = [22, 80, 443, 3389, 445];

interface RawProbe {
  /** True only when TCP actually accepted the connection. */
  accepted: boolean;
  /** True when the host answered at all — accept OR reject. Only false on timeout. */
  answered: boolean;
  latencyMs: number | null;
  error?: string;
}

/** Low-level TCP connect. Never rejects. Distinguishes "port is closed but
 *  the host is alive" (ECONNREFUSED / ECONNRESET → answered=true) from
 *  "we heard nothing" (timeout / EHOSTUNREACH → answered=false), which is
 *  the whole basis of the server-alive check below. */
function rawTcpProbe(host: string, port: number): Promise<RawProbe> {
  const started = performance.now();
  return new Promise<RawProbe>((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (r: RawProbe) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(r);
    };
    socket.setTimeout(TIMEOUT_MS);
    socket.once("connect", () =>
      done({
        accepted: true,
        answered: true,
        latencyMs: Math.round(performance.now() - started),
      })
    );
    socket.once("timeout", () =>
      done({ accepted: false, answered: false, latencyMs: null, error: "timeout" })
    );
    socket.once("error", (err) => {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      // ECONNREFUSED / ECONNRESET mean a machine at that IP replied with
      // "no service on this port" — proof the host is alive. Everything
      // else (EHOSTUNREACH, ENETUNREACH, ETIMEDOUT, DNS failures) means
      // we didn't reach the host at all.
      const answered = code === "ECONNREFUSED" || code === "ECONNRESET";
      done({
        accepted: false,
        answered,
        latencyMs: answered ? Math.round(performance.now() - started) : null,
        error: err.message,
      });
    });
    try {
      socket.connect(port, host);
    } catch (err) {
      done({
        accepted: false,
        answered: false,
        latencyMs: null,
        error: (err as Error).message,
      });
    }
  });
}

export async function probeEndpoint(ep: FleetEndpoint): Promise<FleetProbeResult> {
  const r = await rawTcpProbe(ep.host, ep.port);
  return {
    label: ep.label,
    host: ep.host,
    port: ep.port,
    reachable: r.accepted,
    latencyMs: r.accepted ? r.latencyMs : null,
    error: r.accepted ? undefined : r.error,
    checkedAt: new Date().toISOString(),
  };
}

export async function probeServer(srv: FleetServer): Promise<FleetServerResult> {
  const probes = await Promise.all(
    SERVER_PROBE_PORTS.map(async (port) => ({ port, ...(await rawTcpProbe(srv.host, port)) }))
  );
  const answered = probes.filter((p) => p.answered);
  const openPorts = probes.filter((p) => p.accepted).map((p) => p.port);
  const fastestLatency =
    answered.length === 0
      ? null
      : Math.min(...answered.map((p) => p.latencyMs ?? Infinity));
  return {
    label: srv.label,
    host: srv.host,
    up: answered.length > 0,
    latencyMs: fastestLatency !== null && Number.isFinite(fastestLatency) ? fastestLatency : null,
    openPorts,
    checkedAt: new Date().toISOString(),
  };
}

export async function probeAll(endpoints: FleetEndpoint[]): Promise<FleetProbeResult[]> {
  return Promise.all(endpoints.map(probeEndpoint));
}

export async function probeAllServers(servers: FleetServer[]): Promise<FleetServerResult[]> {
  return Promise.all(servers.map(probeServer));
}
