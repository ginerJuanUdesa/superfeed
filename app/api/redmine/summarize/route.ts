import { NextRequest, NextResponse } from "next/server";
import { getIssueDetail, type RedmineIssueDetail } from "@/lib/redmine";
import { isDemo, demoRedmineSummary } from "@/lib/demo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SYSTEM = `You are a concise project-management editor summarizing a Redmine issue for someone who has 5 seconds to catch up.

Output STRICT JSON:
{
  "headline": "<one sentence, max 18 words, plain English, states what the issue is about>",
  "status_note": "<one sentence, max 20 words, what is happening RIGHT NOW — latest activity, blockers, or who owes what>",
  "bullets": ["<3-6 short bullets covering the important facts, decisions, and open questions from the description and notes>"]
}

Rules:
- Read the description and ALL journal notes in chronological order. Weigh the latest notes highest — they usually contain the current state.
- Ignore pure field changes with no note unless they reveal status transitions or assignment changes worth flagging.
- Bullets are terse fragments, not sentences. No trailing periods. No filler like "the user says".
- If information is missing (e.g. no notes), keep bullets short — do not invent facts.
- Preserve technical identifiers verbatim (ticket refs, commit hashes, filenames, versions).
- Write in the same language as the issue content (Spanish issue → Spanish summary).
- JSON only. No prose, no markdown fences.`;

interface SummarizeBody {
  issueId: number;
  llmUrl?: string;
  llmModel?: string;
}

function buildUserPrompt(issue: RedmineIssueDetail): string {
  const lines: string[] = [
    `Project: ${issue.projectName}`,
    `Tracker: ${issue.tracker}`,
    `#${issue.id} — ${issue.subject}`,
    `Status: ${issue.status}${issue.statusIsClosed ? " (closed)" : ""}`,
    `Priority: ${issue.priority}`,
    `Author: ${issue.author}`,
    `Assignee: ${issue.assignedTo || "(unassigned)"}`,
    `Created: ${issue.createdAt}`,
    `Updated: ${issue.updatedAt}`,
    "",
    "== Description ==",
    issue.fullDescription?.trim() || "(no description)",
  ];
  if (issue.journals.length) {
    lines.push("", "== Journal (chronological) ==");
    for (const j of issue.journals) {
      const header = `--- ${j.createdAt} · ${j.author}`;
      lines.push(header);
      if (j.changes.length) {
        for (const c of j.changes) {
          lines.push(`  · ${c.field}: ${c.from || "∅"} → ${c.to || "∅"}`);
        }
      }
      if (j.notes) lines.push(j.notes);
    }
  }
  return lines.join("\n").slice(0, 12_000);
}

function extractJSON(text: string): {
  headline?: string;
  status_note?: string;
  bullets?: unknown;
} {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const m = trimmed.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {
        // ignore
      }
    }
  }
  return {};
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
    const { issueId, llmUrl, llmModel } = (await req.json()) as SummarizeBody;
    if (!issueId || !Number.isFinite(issueId)) {
      return NextResponse.json({ error: "issueId required" }, { status: 400 });
    }
    if (isDemo()) return NextResponse.json(demoRedmineSummary(issueId));
    if (!llmUrl) {
      return NextResponse.json({ error: "llmUrl required" }, { status: 400 });
    }

    const issue = await getIssueDetail(issueId);
    const model = llmModel?.trim() || (await discoverModel(llmUrl));
    if (!model) {
      return NextResponse.json(
        { error: "no model configured or discoverable" },
        { status: 400 }
      );
    }

    const upstream = await fetch(llmUrl, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: buildUserPrompt(issue) },
        ],
        temperature: 0.2,
        max_tokens: 4096,
        stream: false,
        // Same reason as /api/summarize: reasoning backends otherwise spend the
        // whole token budget thinking and leave message.content empty. Turn
        // thinking off so the call is reliable and several times faster.
        chat_template_kwargs: { enable_thinking: false },
        reasoning_effort: "none",
      }),
      signal: AbortSignal.timeout(120_000),
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
    const msg = data.choices?.[0]?.message ?? {};
    const content = msg.content?.trim() || msg.reasoning_content?.trim() || "";
    const parsed = extractJSON(content);
    const headline =
      typeof parsed.headline === "string" ? parsed.headline.trim() : "";
    const statusNote =
      typeof parsed.status_note === "string" ? parsed.status_note.trim() : "";
    const bullets = Array.isArray(parsed.bullets)
      ? parsed.bullets
          .filter((b): b is string => typeof b === "string")
          .map((b) => b.trim())
          .filter(Boolean)
      : [];
    if (!headline && !bullets.length) {
      return NextResponse.json(
        { error: "LLM returned unusable output", raw: content.slice(0, 300) },
        { status: 502 }
      );
    }
    return NextResponse.json({
      headline,
      statusNote,
      bullets,
      updatedAt: issue.updatedAt,
      journalCount: issue.journals.length,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
