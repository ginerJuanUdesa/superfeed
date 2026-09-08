import { NextRequest, NextResponse } from "next/server";
import { isDemo, demoGmailClassifications } from "@/lib/demo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SYSTEM = `You classify inbox emails. Output STRICT JSON:
{ "results": [ { "id": "<echoed id>", "summary": "<one sentence>", "isSpam": <true|false>, "isAlert": <true|false> } ] }

One entry per input email, same id, same order. No markdown, no prose outside the JSON.

summary: max 22 words, plain English, what the email is about and what it asks of the reader.

isSpam: true for marketing, newsletters, unsolicited bulk. False for real conversations, receipts, personal or work mail.

isAlert: true only when the email PASSIVELY NOTIFIES about a security event, service problem, or infra incident the user should look at now. False for anything transactional the user just triggered.

isAlert = TRUE:
  - security event notice: new sign-in / login from new device or location, password changed, 2FA changed, recovery info changed, suspicious activity, account locked or suspended
  - phrases like "security alert", "Alerta de seguridad", "new sign-in", "nuevo inicio de sesión", "was this you", "¿fuiste vos?" describing a PAST event
  - data breach / leaked password notice
  - urgent service problem for the user: payment failed, subscription about to be cancelled, domain expiring, deploy failed
  - infra alerts: PagerDuty, Sentry, StatusPage, Dependabot vulnerability, uptime monitor down

isAlert = FALSE (do NOT flag these):
  - one-time verification codes, OTPs, magic links, sudo codes, "confirm your email" — the user just requested them
  - receipts, invoices, shipping updates
  - calendar invites, reminders
  - newsletters, marketing, digests
  - normal conversation, PR reviews, mentions

isSpam and isAlert are independent.

Examples:
  "Alerta de seguridad — nuevo inicio de sesión en Linux" → alert:true, spam:false
  "Nuevo inicio de sesión desde Chrome (Buenos Aires)" → alert:true, spam:false
  "Dependabot: high-severity vulnerability in lodash" → alert:true, spam:false
  "Payment failed — update your billing" → alert:true, spam:false
  "[GitHub] Sudo email verification code" → alert:false, spam:false
  "Your one-time login code is 483920" → alert:false, spam:false
  "Weekly digest: this week in AI" → alert:false, spam:true
  "Your Uber receipt" → alert:false, spam:false`;

interface ClassifyItem {
  id: string;
  from: string;
  fromEmail?: string;
  subject: string;
  snippet?: string;
  body?: string;
  receivedAt?: string;
}

interface ClassifyBody {
  items: ClassifyItem[];
  llmUrl?: string;
  llmModel?: string;
}

interface ClassifyResult {
  id: string;
  summary: string;
  isSpam: boolean;
  isAlert: boolean;
}

function buildUserPrompt(items: ClassifyItem[]): string {
  const blocks = items.map((it, i) => {
    const lines = [
      `--- Email ${i + 1} ---`,
      `id: ${it.id}`,
      `from: ${it.from}${it.fromEmail ? ` <${it.fromEmail}>` : ""}`,
      `subject: ${it.subject}`,
    ];
    if (it.receivedAt) lines.push(`received: ${it.receivedAt}`);
    if (it.snippet) lines.push(`snippet: ${it.snippet.slice(0, 200)}`);
    if (it.body) lines.push(`body: ${it.body.slice(0, 600)}`);
    return lines.join("\n");
  });
  return `Classify each email below.\n\n${blocks.join("\n\n")}`;
}

function extractJSON(text: string): { results?: ClassifyResult[] } {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const m = trimmed.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {
        // ignore — fall through to per-object salvage
      }
    }
  }
  // The whole-JSON parse failed, usually because the array was truncated
  // mid-entry (finish_reason: length). Salvage every self-contained result
  // object so a cut-off batch still summarizes the emails that made it in,
  // instead of throwing the entire batch away.
  const results: ClassifyResult[] = [];
  for (const match of trimmed.matchAll(/\{[^{}]*"id"[^{}]*\}/g)) {
    try {
      results.push(JSON.parse(match[0]) as ClassifyResult);
    } catch {
      // skip a malformed fragment
    }
  }
  return results.length ? { results } : {};
}

function authHeaders(): Record<string, string> {
  const key = process.env.LOCAL_LLM_API_KEY?.trim();
  return key ? { Authorization: `Bearer ${key}` } : {};
}

async function discoverModel(llmUrl: string): Promise<string | undefined> {
  try {
    const modelsUrl = llmUrl.replace(/\/chat\/completions\/?$/, "/models");
    const res = await fetch(modelsUrl, {
      headers: authHeaders(),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return undefined;
    const data = (await res.json()) as { data?: { id?: string }[] };
    return data.data?.[0]?.id;
  } catch {
    return undefined;
  }
}

export async function POST(req: NextRequest) {
  try {
    const { items, llmUrl, llmModel } = (await req.json()) as ClassifyBody;
    if (!items?.length) {
      return NextResponse.json({ error: "items required" }, { status: 400 });
    }
    if (isDemo()) return NextResponse.json(demoGmailClassifications(items));
    if (!llmUrl) {
      return NextResponse.json({ error: "llmUrl required" }, { status: 400 });
    }
    const model = llmModel?.trim() || (await discoverModel(llmUrl));
    if (!model) {
      return NextResponse.json({ error: "no model configured or discoverable" }, { status: 400 });
    }

    const upstream = await fetch(llmUrl, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: buildUserPrompt(items) },
        ],
        temperature: 0.2,
        max_tokens: 4096,
        stream: false,
        // Classification needs no chain-of-thought. With thinking on, a
        // reasoning backend spends the whole token budget reasoning and either
        // leaves content empty or truncates the JSON array mid-way, so the
        // batch fails to parse and those emails never get a summary.
        chat_template_kwargs: { enable_thinking: false },
        reasoning_effort: "none",
      }),
      signal: AbortSignal.timeout(180_000),
    });
    if (!upstream.ok) {
      const body = await upstream.text().catch(() => "");
      return NextResponse.json(
        { error: `LLM ${upstream.status}: ${body.slice(0, 200)}` },
        { status: 502 }
      );
    }
    const data = (await upstream.json()) as {
      choices?: {
        finish_reason?: string;
        message?: { content?: string; reasoning_content?: string };
      }[];
    };
    const choice = data.choices?.[0];
    const msg = choice?.message ?? {};
    const content = msg.content?.trim() || msg.reasoning_content?.trim() || "";
    const parsed = extractJSON(content);

    // Filter to entries that at least reference one of the ids we sent.
    const knownIds = new Set(items.map((i) => i.id));
    const results = (parsed.results ?? [])
      .filter((r) => r && typeof r.id === "string" && knownIds.has(r.id))
      .map((r) => ({
        id: r.id,
        summary: typeof r.summary === "string" ? r.summary.trim() : "",
        isSpam: r.isSpam === true,
        isAlert: r.isAlert === true,
      }))
      .filter((r) => r.summary.length > 0);

    if (!results.length) {
      console.error(
        `[gmail/classify] unusable output for ${items.length} emails (finish=${choice?.finish_reason}): ${content.slice(0, 200)}`
      );
      return NextResponse.json(
        { error: "LLM returned unusable output", finish: choice?.finish_reason, raw: content.slice(0, 300) },
        { status: 502 }
      );
    }
    return NextResponse.json({ results });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
