import { accessTokenFor } from "./googleAuth";

export interface GmailItem {
  /** Gmail message id. Stable across accounts as long as it lives in the mailbox. */
  id: string;
  /** Account label from Settings — used to check-filter and route in the UI. */
  account: string;
  /** Actual email address of the mailbox this message lives in. Used to build
   *  a click-through URL that lands in the right Gmail session for users with
   *  multiple Google accounts logged in the same browser. */
  accountEmail: string;
  from: string;
  fromEmail: string;
  subject: string;
  snippet: string;
  /** First ~1kb of the plain text body. Empty if we couldn't decode it. */
  body: string;
  receivedAt: string;
  /** Gmail's own read/unread signal — presence of the UNREAD label. */
  isUnread: boolean;
}

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

function headerValue(headers: { name?: string; value?: string }[] | undefined, name: string) {
  if (!headers) return "";
  const target = name.toLowerCase();
  for (const h of headers) {
    if (h.name?.toLowerCase() === target) return h.value ?? "";
  }
  return "";
}

/** From: "Name" <email@x> → { name: "Name", email: "email@x" }. */
function parseFrom(raw: string): { name: string; email: string } {
  const match = raw.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (match) return { name: match[1].trim() || match[2].trim(), email: match[2].trim() };
  return { name: raw.trim(), email: raw.trim() };
}

interface GmailPart {
  mimeType?: string;
  filename?: string;
  body?: { data?: string; size?: number };
  parts?: GmailPart[];
}

function base64UrlDecode(data: string): string {
  const normalized = data.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const buf = Buffer.from(padded, "base64");
  return buf.toString("utf-8");
}

/**
 * Prefer text/plain, fall back to text/html with tags stripped. We walk the
 * MIME tree depth-first and take the first thing that yields readable text —
 * mailing lists and marketing often bury the plain part under multipart/alt.
 */
function extractBody(payload: GmailPart | undefined): string {
  if (!payload) return "";
  const preference = ["text/plain", "text/html"];
  for (const wanted of preference) {
    const found = findPart(payload, (p) => p.mimeType === wanted && !!p.body?.data);
    if (found?.body?.data) {
      const raw = base64UrlDecode(found.body.data);
      const text = wanted === "text/html" ? stripHtml(raw) : raw;
      return text.replace(/\s+/g, " ").trim();
    }
  }
  return "";
}

function findPart(
  root: GmailPart,
  pred: (p: GmailPart) => boolean
): GmailPart | null {
  if (pred(root)) return root;
  if (!root.parts) return null;
  for (const p of root.parts) {
    const hit = findPart(p, pred);
    if (hit) return hit;
  }
  return null;
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

/** ISO date → Gmail search query "after:YYYY/MM/DD". */
function isoToQueryDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}/${m}/${day}`;
}

async function pool<T>(tasks: (() => Promise<T>)[], concurrency: number): Promise<T[]> {
  const out: T[] = new Array(tasks.length);
  let cursor = 0;
  async function worker() {
    while (cursor < tasks.length) {
      const i = cursor++;
      try {
        out[i] = await tasks[i]();
      } catch {
        out[i] = null as unknown as T;
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker())
  );
  return out;
}

async function fetchProfileEmail(token: string): Promise<string> {
  try {
    const res = await fetch(`${GMAIL_BASE}/profile`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return "";
    const data = (await res.json()) as { emailAddress?: string };
    return data.emailAddress ?? "";
  } catch {
    return "";
  }
}

export async function fetchInbox(opts: {
  account: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  since?: string;
  max?: number;
}): Promise<GmailItem[]> {
  const { account, clientId, clientSecret, refreshToken, since, max = 25 } = opts;
  const token = await accessTokenFor(clientId, clientSecret, refreshToken);
  const accountEmail = await fetchProfileEmail(token);

  const parts = ["in:inbox", "-category:promotions", "-category:social"];
  if (since) {
    const q = isoToQueryDate(since);
    if (q) parts.push(`after:${q}`);
  }
  const q = parts.join(" ");

  const listUrl = `${GMAIL_BASE}/messages?maxResults=${max}&q=${encodeURIComponent(q)}`;
  const listRes = await fetch(listUrl, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!listRes.ok) {
    const text = await listRes.text().catch(() => "");
    throw new Error(`Gmail list failed (${listRes.status}): ${text.slice(0, 200)}`);
  }
  const list = (await listRes.json()) as {
    messages?: { id: string; threadId?: string }[];
  };
  const ids = (list.messages ?? []).map((m) => m.id);
  if (!ids.length) return [];

  const details = await pool(
    ids.map((id) => async () => {
      const url = `${GMAIL_BASE}/messages/${id}?format=full`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return null;
      return (await res.json()) as {
        id: string;
        internalDate?: string;
        snippet?: string;
        labelIds?: string[];
        payload?: GmailPart & { headers?: { name?: string; value?: string }[] };
      };
    }),
    8
  );

  const items: GmailItem[] = [];
  for (const d of details) {
    if (!d) continue;
    const headers = d.payload?.headers;
    const from = headerValue(headers, "From");
    const subject = headerValue(headers, "Subject") || "(no subject)";
    const { name, email } = parseFrom(from);
    const receivedAt = d.internalDate
      ? new Date(Number(d.internalDate)).toISOString()
      : "";
    const body = extractBody(d.payload).slice(0, 1200);
    items.push({
      id: d.id,
      account,
      accountEmail,
      from: name,
      fromEmail: email,
      subject,
      snippet: (d.snippet ?? "").trim(),
      body,
      receivedAt,
      isUnread: (d.labelIds ?? []).includes("UNREAD"),
    });
  }
  return items;
}
