import { NextRequest, NextResponse } from "next/server";
import { connectToDatabase } from "@/lib/mongodb";
import { getSettings, toApiKeyDTOs, Settings } from "@/lib/models/Settings";
import { isAuthed, requireAuth } from "@/lib/auth";
import { noStore } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/settings — list stored YouTube API keys (masked).
export async function GET(req: NextRequest) {
  if (!isAuthed(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    await connectToDatabase();
    const doc = await getSettings();
    return noStore(NextResponse.json({ apiKeys: toApiKeyDTOs(doc) }));
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed" },
      { status: 500 }
    );
  }
}

// POST /api/settings — add a YouTube API key. Body: { value, label? }
export async function POST(req: NextRequest) {
  const unauthorized = requireAuth(req);
  if (unauthorized) return unauthorized;

  let body: { value?: string; label?: string } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const value = (body.value ?? "").trim();
  if (!value) return NextResponse.json({ error: "value is required" }, { status: 400 });
  if (!/^AIza[0-9A-Za-z_-]{20,}$/.test(value)) {
    return NextResponse.json(
      { error: "Trông không giống YouTube API key (thường bắt đầu bằng 'AIza…')." },
      { status: 400 }
    );
  }

  try {
    await connectToDatabase();
    const doc = await getSettings();
    const exists = (doc.youtubeApiKeys ?? []).some(
      (k) => (k as unknown as { value: string }).value === value
    );
    if (exists) {
      return NextResponse.json({ error: "Key này đã tồn tại." }, { status: 409 });
    }
    await Settings.updateOne(
      { key: "global" },
      { $push: { youtubeApiKeys: { value, label: (body.label ?? "").trim() } } }
    );
    const fresh = await getSettings();
    return NextResponse.json({ apiKeys: toApiKeyDTOs(fresh) }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed" },
      { status: 500 }
    );
  }
}

// DELETE /api/settings?id=<keyId> — remove a stored key.
export async function DELETE(req: NextRequest) {
  const unauthorized = requireAuth(req);
  if (unauthorized) return unauthorized;

  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

  try {
    await connectToDatabase();
    await Settings.updateOne(
      { key: "global" },
      { $pull: { youtubeApiKeys: { _id: id } } }
    );
    const fresh = await getSettings();
    return NextResponse.json({ apiKeys: toApiKeyDTOs(fresh) });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed" },
      { status: 500 }
    );
  }
}
