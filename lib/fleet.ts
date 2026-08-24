import net from "net";

/** A single machine in the user's fleet. `port` is where we probe TCP; if
 *  omitted we default to 22 (SSH), which is up on essentially every Linux
 *  box Juan runs — good enough as an "is the host alive" signal. */
export interface FleetEndpoint {
  label: string;
  host: string;
  port?: number;
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

const DEFAULT_PORT = 22;
const TIMEOUT_MS = 2500;

/** TCP-connect probe. Resolves as soon as the SYN-ACK comes back (or the
 *  timeout / RST fires), never rejects — errors are folded into the result. */
export function probeEndpoint(ep: FleetEndpoint): Promise<FleetProbeResult> {
  const port = ep.port ?? DEFAULT_PORT;
  const started = performance.now();
  const finish = (
    reachable: boolean,
    error?: string
  ): FleetProbeResult => ({
    label: ep.label,
    host: ep.host,
    port,
    reachable,
    latencyMs: reachable ? Math.round(performance.now() - started) : null,
    error,
    checkedAt: new Date().toISOString(),
  });

  return new Promise<FleetProbeResult>((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (result: FleetProbeResult) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(TIMEOUT_MS);
    socket.once("connect", () => done(finish(true)));
    socket.once("timeout", () => done(finish(false, "timeout")));
    socket.once("error", (err) => done(finish(false, err.message)));
    try {
      socket.connect(port, ep.host);
    } catch (err) {
      done(finish(false, (err as Error).message));
    }
  });
}

export async function probeAll(endpoints: FleetEndpoint[]): Promise<FleetProbeResult[]> {
  return Promise.all(endpoints.map(probeEndpoint));
}
