import { NextRequest, NextResponse } from "next/server";
import { fetchInbox, GmailItem } from "@/lib/gmail";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface FeedBody {
  clientId?: string;
  clientSecret?: string;
  accounts?: { label: string; refreshToken: string }[];
  since?: string;
  maxPerAccount?: number;
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as FeedBody;
    const clientId = (body.clientId ?? "").trim();
    const clientSecret = (body.clientSecret ?? "").trim();
    const accounts = (body.accounts ?? []).filter(
      (a) => a.label?.trim() && a.refreshToken?.trim()
    );
    if (!clientId || !clientSecret) {
      return NextResponse.json(
        { error: "Gmail client id/secret required" },
        { status: 400 }
      );
    }
    if (!accounts.length) {
      return NextResponse.json({ items: [] });
    }

    const results = await Promise.all(
      accounts.map(async (a) => {
        try {
          return await fetchInbox({
            account: a.label,
            clientId,
            clientSecret,
            refreshToken: a.refreshToken,
            since: body.since,
            max: body.maxPerAccount ?? 25,
          });
        } catch (err) {
          // one dead account shouldn't take down the whole feed
          console.error(`gmail account ${a.label} failed:`, err);
          return [] as GmailItem[];
        }
      })
    );

    const items = results
      .flat()
      .sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt));

    return NextResponse.json({ items });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
