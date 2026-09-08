import { NextResponse } from "next/server";
import { listProjects } from "@/lib/redmine";
import { isDemo, demoRedmineProjects } from "@/lib/demo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  if (isDemo()) return NextResponse.json({ projects: demoRedmineProjects() });
  try {
    const projects = await listProjects();
    return NextResponse.json({ projects });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
