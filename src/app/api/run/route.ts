import { NextRequest, NextResponse } from "next/server";
import { connectToDatabase } from "@/lib/mongodb";
import { requireAuth } from "@/lib/auth";
import { getPoolKeys, recordKeyQuota } from "@/lib/models/Settings";
import { fetchChannelVideos, YouTubeError } from "@/lib/youtube";
import {
  writeVideosToSheet,
  resolveExtraColumns,
  SheetsError,
  SheetFormatError,
} from "@/lib/sheets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface RunBody {
  channelUrl?: string;
  maxDays?: number;
  dateFrom?: string;
  dateTo?: string;
  minViews?: number;
  minLikes?: number;
  minComments?: number;
  minMinutes?: number;
  maxMinutes?: number;
  minEngagement?: number;
  minViewsPerDay?: number;
  sheetUrl?: string;
  tab?: string;
  createNewTab?: boolean;
  extraColumnGroups?: string[];
  googleAccessToken?: string | null;
}

// Column-group id (from the UI) -> concrete extra column keys.
const GROUP_TO_KEYS: Record<string, string[]> = {
  likesComments: ["likes", "comments"],
  engagementVelocity: ["engagement", "viewsPerDay"],
  dateCategoryChannel: ["publishedDate", "category", "channel"],
};

const num = (v: unknown, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

export async function POST(req: NextRequest) {
  const unauthorized = requireAuth(req);
  if (unauthorized) return unauthorized;

  let body: RunBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const errors: string[] = [];
  const channelUrl = (body.channelUrl ?? "").trim();
  const sheetUrl = (body.sheetUrl ?? "").trim();
  const maxDays = num(body.maxDays, 30);
  const dateFrom = (body.dateFrom ?? "").trim() || undefined;
  const dateTo = (body.dateTo ?? "").trim() || undefined;
  const minMinutes = num(body.minMinutes);
  const maxMinutes = num(body.maxMinutes);

  if (!channelUrl) errors.push("Thiếu link kênh.");
  if (!sheetUrl) errors.push("Thiếu link Google Sheet.");
  if (!dateFrom && (maxDays <= 0 || maxDays > 3650))
    errors.push("Số ngày phải trong khoảng 1–3650 (hoặc dùng khoảng ngày).");
  if (maxMinutes > 0 && minMinutes > 0 && maxMinutes < minMinutes)
    errors.push("Thời lượng tối đa phải ≥ tối thiểu.");
  if (dateFrom && dateTo && dateFrom > dateTo) errors.push("Ngày bắt đầu phải ≤ ngày kết thúc.");
  if (errors.length) return NextResponse.json({ errors }, { status: 400 });

  const extraKeys = (body.extraColumnGroups ?? []).flatMap((g) => GROUP_TO_KEYS[g] ?? []);
  const extraColumns = resolveExtraColumns(extraKeys);

  try {
    await connectToDatabase();
    const apiKeys = await getPoolKeys();
    if (apiKeys.length === 0) {
      return NextResponse.json(
        { error: "Không có API key còn quota. Thêm/kiểm tra key trong Settings (⚙️)." },
        { status: 400 }
      );
    }

    const result = await fetchChannelVideos({
      channelUrl,
      apiKeys,
      maxDays,
      dateFrom,
      dateTo,
      minViews: num(body.minViews),
      minLikes: num(body.minLikes),
      minComments: num(body.minComments),
      minDurationSec: Math.round(minMinutes * 60),
      maxDurationSec: Math.round(maxMinutes * 60),
      minEngagement: num(body.minEngagement),
      minViewsPerDay: num(body.minViewsPerDay),
    });

    // Persist quota spent per key (best-effort; never blocks the response).
    recordKeyQuota(result.usage).catch(() => {});

    let sheet = null;
    if (result.videos.length > 0) {
      sheet = await writeVideosToSheet(sheetUrl, result.videos, {
        tab: (body.tab ?? "").trim() || undefined,
        createNewTab: Boolean(body.createNewTab),
        channelTitle: result.channelTitle,
        extraColumns,
        accessToken: body.googleAccessToken ?? null,
      });
    }

    return NextResponse.json({
      ok: true,
      channelTitle: result.channelTitle,
      scanned: result.scanned,
      matched: result.videos.length,
      wrote: sheet?.rowsWritten ?? 0,
      updated: sheet?.rowsUpdated ?? 0,
      tab: sheet?.tab ?? null,
      keyCount: apiKeys.length,
      preview: result.videos.slice(0, 100),
    });
  } catch (err) {
    if (err instanceof SheetFormatError)
      return NextResponse.json({ error: err.message, kind: "format" }, { status: 422 });
    if (err instanceof SheetsError)
      return NextResponse.json({ error: err.message, kind: "sheets" }, { status: 502 });
    if (err instanceof YouTubeError)
      return NextResponse.json({ error: err.message, kind: "youtube" }, { status: 502 });
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Lỗi không xác định" },
      { status: 500 }
    );
  }
}
