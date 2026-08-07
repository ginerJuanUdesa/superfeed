import { accessTokenFor } from "./googleAuth";

export interface CalendarEvent {
  id: string;
  /** Account label from Settings — used for filtering + per-account coloring. */
  account: string;
  /** Actual email address of the calendar owner. Used to route click-throughs
   *  to the right Gmail session when the browser has multiple Google accounts. */
  accountEmail: string;
  summary: string;
  location: string;
  /** ISO 8601. For all-day events this is a date at 00:00 in the event's TZ. */
  start: string;
  end: string;
  allDay: boolean;
  htmlLink: string;
}

const CAL_BASE = "https://www.googleapis.com/calendar/v3";

async function fetchProfileEmail(token: string): Promise<string> {
  try {
    // Calendar's own settings endpoint would work too, but we already use
    // Gmail's /profile shape everywhere else — hit the calendarList primary.
    const res = await fetch(`${CAL_BASE}/users/me/calendarList/primary`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return "";
    const data = (await res.json()) as { id?: string };
    return data.id ?? "";
  } catch {
    return "";
  }
}

interface RawEvent {
  id: string;
  summary?: string;
  location?: string;
  htmlLink?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  status?: string;
}

export async function fetchUpcomingEvents(opts: {
  account: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  max?: number;
}): Promise<CalendarEvent[]> {
  const { account, clientId, clientSecret, refreshToken, max = 15 } = opts;
  const token = await accessTokenFor(clientId, clientSecret, refreshToken);
  const accountEmail = await fetchProfileEmail(token);

  const params = new URLSearchParams({
    timeMin: new Date().toISOString(),
    maxResults: String(max),
    singleEvents: "true", // expand recurring events into individual instances
    orderBy: "startTime",
  });
  const url = `${CAL_BASE}/calendars/primary/events?${params.toString()}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Calendar list failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const data = (await res.json()) as { items?: RawEvent[] };
  const items = data.items ?? [];

  const out: CalendarEvent[] = [];
  for (const e of items) {
    if (e.status === "cancelled") continue;
    const startRaw = e.start?.dateTime ?? e.start?.date;
    const endRaw = e.end?.dateTime ?? e.end?.date;
    if (!startRaw) continue;
    const allDay = !e.start?.dateTime;
    out.push({
      id: e.id,
      account,
      accountEmail,
      summary: (e.summary ?? "(no title)").trim(),
      location: (e.location ?? "").trim(),
      start: allDay ? `${startRaw}T00:00:00` : startRaw,
      end: allDay ? `${endRaw ?? startRaw}T00:00:00` : endRaw ?? startRaw,
      allDay,
      htmlLink: e.htmlLink ?? "",
    });
  }
  return out;
}
