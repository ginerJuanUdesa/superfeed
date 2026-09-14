import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SYSTEM = `You are a concise technical editor. Given a GitHub pull request's repo, title, and description, output STRICT JSON with one field:
{
  "summary": "<one short English fragment>"
}
Rules:
- summary: one short fragment describing WHAT THE PR IMPLEMENTS or CHANGES, max 16 words. The UI already shows the repo and PR title above the summary, so DO NOT repeat them. Just describe the substance. Good: "adds cross-platform build support and a CLI proxy", "fixes tensor-parallel crash on multi-GPU inference", "reworks the SLAM grid mapping to fixed-size cells". Bad: "This PR adds…" (filler), "In repo X, the PR titled Y…" (repeats context).
- Start with a verb or the substantive detail, not with "a", "the", "this PR", or the title.
- Base it on the description; if the description is empty or noise (checklists, template boilerplate), infer from the title instead.
- Do not include any other text, markdown, or code fences. JSON only.`;

/** Sampling params some backends (e.g. vLLM diffusion models) reject with a
 *  400. When they do, the error body names them — we strip the named ones and
 *  retry. Only params we actually send need appear here. */
const SAMPLING_PARAMS = [
  "temperature",
  "min_p",
  "seed",
  "min_tokens",
  "logit_bias",
  "bad_words",
  "allowed_token_ids",
] as const;

interface Body {
  title?: string;
  body?: string;
  repo?: string;
  llmUrl?: string;
  llmModel?: string;
}

function extractJSON(text: string): { summary?: string } {
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
    const { title, body, repo, llmUrl, llmModel } = (await req.json()) as Body;
    if (!title && !body) {
      return NextResponse.json({ error: "title or body required" }, { status: 400 });
    }
    if (!llmUrl) return NextResponse.json({ error: "llmUrl required" }, { status: 400 });

    const model = llmModel?.trim() || (await discoverModel(llmUrl));
    if (!model) {
      return NextResponse.json({ error: "no model configured or discoverable" }, { status: 400 });
    }

    const userPrompt = [
      repo ? `Repo: ${repo}` : "",
      `PR title: ${title ?? ""}`,
      `Description:\n${(body ?? "").slice(0, 2000) || "(empty)"}`,
    ]
      .filter(Boolean)
      .join("\n");

    // Sampling params live in a mutable object so we can strip the ones a given
    // backend rejects and retry. `temperature` is the usual offender: reasoning
    // backends want it, but diffusion models served through the same vLLM 400 on
    // it (along with min_p/seed/… ). We only send `temperature` from that set,
    // so dropping it clears the 400. Mirrors /api/summarize.
    const params: Record<string, unknown> = {
      model,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.3,
      max_tokens: 4096,
      stream: false,
      // Same rationale as the HF summarizer: a 16-word fragment needs no
      // reasoning trace, and leaving thinking on lets reasoning backends burn
      // the whole budget and return empty content on finish_reason "length".
      chat_template_kwargs: { enable_thinking: false },
      reasoning_effort: "none",
    };

    const callUpstream = () =>
      fetch(llmUrl, {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders() },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(120_000),
      });

    let upstream = await callUpstream();

    // Some backends reject sampling params they don't support with a 400 that
    // names the offending fields. Strip whatever it names and retry once, so a
    // model swap on the same endpoint doesn't silently break summaries.
    if (upstream.status === 400) {
      const b = await upstream.text().catch(() => "");
      const stripped = SAMPLING_PARAMS.filter(
        (p) => p in params && b.includes(p)
      );
      if (stripped.length) {
        for (const p of stripped) delete params[p];
        console.warn(
          `[pr-summary] retrying without unsupported params [${stripped.join(", ")}]`
        );
        upstream = await callUpstream();
      } else {
        return NextResponse.json(
          { error: `LLM 400: ${b.slice(0, 200)}` },
          { status: 502 }
        );
      }
    }

    if (!upstream.ok) {
      const b = await upstream.text().catch(() => "");
      return NextResponse.json(
        { error: `LLM ${upstream.status}: ${b.slice(0, 200)}` },
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
    const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
    if (!summary) {
      return NextResponse.json(
        { error: "LLM returned unusable output", raw: content.slice(0, 300) },
        { status: 502 }
      );
    }
    return NextResponse.json({ summary });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
