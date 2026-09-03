import { NextRequest, NextResponse } from "next/server";
import { readFile } from "fs/promises";
import path from "path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UPLOAD_DIR = path.join(process.cwd(), ".local", "uploads");

const TYPE_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  bmp: "image/bmp",
};

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;
  // Only a bare filename is valid — reject anything that could escape the dir.
  if (!name || name.includes("/") || name.includes("\\") || name.includes("..")) {
    return NextResponse.json({ error: "bad name" }, { status: 400 });
  }
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  const type = TYPE_BY_EXT[ext];
  if (!type) {
    return NextResponse.json({ error: "unsupported type" }, { status: 400 });
  }
  const full = path.join(UPLOAD_DIR, name);
  // Defence in depth: the resolved path must stay inside UPLOAD_DIR.
  if (!path.resolve(full).startsWith(path.resolve(UPLOAD_DIR) + path.sep)) {
    return NextResponse.json({ error: "bad path" }, { status: 400 });
  }
  try {
    const buf = await readFile(full);
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        "Content-Type": type,
        // Names are content-unique (uuid) so the file at a URL never changes.
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
}
