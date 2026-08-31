import { NextRequest, NextResponse } from "next/server";
import type { HFItem } from "@/lib/hf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SYSTEM = `You are a concise technical editor. Given metadata about a HuggingFace release, output STRICT JSON with one field:
{
  "summary": "<one short English fragment>"
}
Rules:
- summary: one short fragment describing WHAT IT DOES, max 14 words. The UI already shows the author/name above the summary, so DO NOT repeat the model name, author name, or the word "model"/"dataset"/"space" unless it is essential. Just describe the function. Good: "8B chat finetune trained on multilingual data", "4-bit quant of a SoTA math LLM", "image-to-video diffusion with camera control", "curated 40k Spanish RAG eval set". Bad: "Foo-Bar-8B is an 8B parameter chat model finetuned on…" (repeats name), "This model is a…" (filler).
- Start with the substantive detail, not with "a", "the", "this is", or the name.
- If the input says this is an UPDATE (not a new release), lead with what changed, e.g. "README rewritten with new benchmarks" or "added GGUF quants for the 8B variant". Use the commit title as the primary signal. Still do not repeat the repo name.
- Do not include any other text, markdown, or code fences. JSON only.`;

interface SummarizeBody {
  item: HFItem;
  llmUrl?: string;
  llmModel?: string;
}

function buildUserPrompt(item: HFItem): string {
  const lines = [
    `Kind: ${item.kind}`,
    `Author: ${item.author}`,
    `Name: ${item.name}`,
  ];
  if (item.pipeline) lines.push(`Pipeline: ${item.pipeline}`);
  if (item.tags && item.tags.length) lines.push(`Tags: ${item.tags.slice(0, 12).join(", ")}`);
  if (item.description) lines.push(`HF description: ${item.description.slice(0, 500)}`);
  if (item.isUpdate) {
    lines.push("Event: UPDATE to an existing repo (not a brand-new release)");
    if (item.lastCommit) lines.push(`Last commit: ${item.lastCommit}`);
    if (item.lastCommitBy) lines.push(`Pushed by: ${item.lastCommitBy}`);
  } else {
    lines.push("Event: NEW release");
  }
  return lines.join("\n");
}

function extractJSON(text: string): { summary?: string } {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // best-effort: extract the first {...} block
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
    const { item, llmUrl, llmModel } = (await req.json()) as SummarizeBody;
    if (!item) return NextResponse.json({ error: "item required" }, { status: 400 });
    if (!llmUrl) return NextResponse.json({ error: "llmUrl required" }, { status: 400 });

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
          { role: "user", content: buildUserPrompt(item) },
        ],
        temperature: 0.3,
        max_tokens: 4096,
        stream: false,
        // This task wants a 14-word fragment, not a reasoning trace. Reasoning
        // backends (Qwen3 & co. behind vLLM) otherwise burn the whole token
        // budget in `reasoning_content` and leave `message.content` empty on a
        // `finish_reason: "length"` — the summary then silently fails. Turning
        // thinking off makes the call both reliable and several times faster.
        chat_template_kwargs: { enable_thinking: false },
        reasoning_effort: "none",
      }),
      signal: AbortSignal.timeout(120_000),
    });

    if (!upstream.ok) {
      const body = await upstream.text().catch(() => "");
      console.error(`[summarize] LLM ${upstream.status} for ${item.author}/${item.name}: ${body.slice(0, 200)}`);
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
    // Reasoning backends put the answer in `content` but, when they run out of
    // budget mid-thought (`finish_reason: "length"`), `content` is empty while
    // `reasoning_content` holds the trace. Fall back to the trace so a partial
    // JSON blob there can still be salvaged instead of silently failing.
    const content = msg.content?.trim() || msg.reasoning_content?.trim() || "";
    const parsed = extractJSON(content);
    const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
    if (!summary) {
      console.error(
        `[summarize] unusable output for ${item.author}/${item.name} (finish=${choice?.finish_reason}): ${content.slice(0, 200)}`
      );
      return NextResponse.json(
        { error: "LLM returned unusable output", finish: choice?.finish_reason, raw: content.slice(0, 300) },
        { status: 502 }
      );
    }
    return NextResponse.json({ summary });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    console.error(`[summarize] error: ${message}`);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
