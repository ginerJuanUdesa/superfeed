import { NextRequest, NextResponse } from "next/server";
import { fetchInbox } from "@/lib/gmail";
import { isDemo, demoGmailItems } from "@/lib/demo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface FeedBody {
  accounts?: {
    label: string;
    refreshToken: string;
    clientId: string;
    clientSecret: string;
  }[];
  since?: string;
  maxPerAccount?: number;
  /** Per-account cursor for infinite scroll: keyed by account label. */
  pageTokens?: Record<string, string | null>;
}

export async function POST(req: NextRequest) {
  if (isDemo()) return NextResponse.json({ items: demoGmailItems(), nextPageTokens: {} });
  try {
    const body = (await req.json()) as FeedBody;
    const accounts = (body.accounts ?? [])
      .filter((a) => a.label?.trim() && a.refreshToken?.trim())
      .map((a) => ({
        label: a.label,
        refreshToken: a.refreshToken.trim(),
        clientId: a.clientId?.trim() ?? "",
        clientSecret: a.clientSecret?.trim() ?? "",
      }));
    if (!accounts.length) {
      return NextResponse.json({ items: [] });
    }
    const missing = accounts.filter((a) => !a.clientId || !a.clientSecret);
    if (missing.length) {
      return NextResponse.json(
        {
          error: `Missing OAuth client for account(s): ${missing.map((m) => m.label).join(", ")}.`,
        },
        { status: 400 }
      );
    }

    const pageTokens = body.pageTokens ?? {};
    // On a paginated call, skip accounts whose cursor is null (no more mail).
    // On an initial call (no cursors sent) all accounts fetch page 1.
    const isPaginated = Object.keys(pageTokens).length > 0;
    const activeAccounts = isPaginated
      ? accounts.filter((a) => pageTokens[a.label])
      : accounts;

    const results = await Promise.all(
      activeAccounts.map(async (a) => {
        try {
          return await fetchInbox({
            account: a.label,
            clientId: a.clientId,
            clientSecret: a.clientSecret,
            refreshToken: a.refreshToken,
            since: body.since,
            max: body.maxPerAccount ?? 25,
            pageToken: pageTokens[a.label] ?? undefined,
          });
        } catch (err) {
          // one dead account shouldn't take down the whole feed
          console.error(`gmail account ${a.label} failed:`, err);
          return { items: [], nextPageToken: null };
        }
      })
    );

    const items = results
      .flatMap((r) => r.items)
      .sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt));

    const nextPageTokens: Record<string, string | null> = {};
    activeAccounts.forEach((a, i) => {
      nextPageTokens[a.label] = results[i].nextPageToken;
    });

    return NextResponse.json({ items, nextPageTokens });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
