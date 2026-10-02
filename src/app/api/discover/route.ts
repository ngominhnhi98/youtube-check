import { NextRequest, NextResponse } from "next/server";
import { connectToDatabase } from "@/lib/mongodb";
import { requireAuth } from "@/lib/auth";
import { getPoolKeys, recordKeyQuota } from "@/lib/models/Settings";
import { discoverChannels, type SearchQuery } from "@/lib/discover";
import { YouTubeError } from "@/lib/youtube";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface DiscoverBody {
  queries?: { q?: string; lang?: string; note?: string; region?: string }[];
  includeVietnam?: boolean;
  pagesPerQuery?: number;
  maxSubs?: number;
  minSubs?: number;
  minAvgViews?: number;
  minVideos?: number;
  publishedWithinDays?: number;
  videoDurations?: string[];
  order?: string;
  longFormOnly?: boolean;
  longMinMinutes?: number;
  longRatioMin?: number;
  matchMinMinutes?: number;
  matchMaxMinutes?: number;
  limit?: number;
}

const num = (v: unknown, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : d;
};

const DURATIONS = new Set(["any", "short", "medium", "long"]);
const ORDERS = new Set(["viewCount", "relevance", "date"]);

export async function POST(req: NextRequest) {
  const unauthorized = requireAuth(req);
  if (unauthorized) return unauthorized;

  let body: DiscoverBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const queries: SearchQuery[] = (body.queries ?? [])
    .map((x) => ({
      q: (x?.q ?? "").trim(),
      lang: (x?.lang ?? "").trim(),
      note: (x?.note ?? "").trim(),
      // regionCode sai định dạng làm YouTube trả 400 cho cả lượt search → chỉ nhận
      // đúng 2 chữ cái in hoa.
      region: /^[A-Z]{2}$/.test((x?.region ?? "").trim()) ? (x?.region ?? "").trim() : "",
    }))
    .filter((x) => x.q.length > 0)
    .slice(0, 20);

  const errors: string[] = [];
  if (queries.length === 0) errors.push("Chưa có truy vấn nào — bấm “Tạo từ khoá” trước.");
  const maxSubs = num(body.maxSubs);
  const minSubs = num(body.minSubs);
  if (maxSubs > 0 && minSubs > maxSubs) errors.push("Sub tối thiểu phải ≤ sub tối đa.");
  const matchMinMinutes = num(body.matchMinMinutes);
  const matchMaxMinutes = num(body.matchMaxMinutes);
  if (matchMaxMinutes > 0 && matchMinMinutes > matchMaxMinutes)
    errors.push("Thời lượng video khớp tối thiểu phải ≤ tối đa.");
  if (errors.length) return NextResponse.json({ errors }, { status: 400 });

  const pagesPerQuery = Math.min(3, Math.max(1, num(body.pagesPerQuery, 1)));

  // Mỗi độ dài là một lượt search riêng (100 units), nên chặn danh sách rác từ
  // client: chỉ giữ giá trị hợp lệ, bỏ trùng, và "any" thì nuốt hết các giá trị
  // khác vì nó đã bao trùm chúng.
  const picked = [...new Set(body.videoDurations ?? [])].filter((d) => DURATIONS.has(d));
  const videoDurations = (
    picked.length === 0 || picked.includes("any") ? ["any"] : picked
  ) as ("any" | "short" | "medium" | "long")[];

  const longMinSec = Math.round(Math.min(120, Math.max(1, num(body.longMinMinutes, 4))) * 60);
  const longRatioMin = Math.min(100, Math.max(0, num(body.longRatioMin, 60)));

  try {
    await connectToDatabase();
    const apiKeys = await getPoolKeys();
    if (apiKeys.length === 0) {
      return NextResponse.json(
        { error: "Không có API key còn quota. Thêm/kiểm tra key trong Settings (⚙️)." },
        { status: 400 }
      );
    }

    const result = await discoverChannels({
      queries,
      apiKeys,
      includeVietnam: Boolean(body.includeVietnam),
      pagesPerQuery,
      maxSubs,
      minSubs,
      minAvgViews: num(body.minAvgViews),
      minVideos: num(body.minVideos),
      publishedWithinDays: num(body.publishedWithinDays),
      matchMinSec: Math.round(matchMinMinutes * 60),
      matchMaxSec: Math.round(matchMaxMinutes * 60),
      videoDurations,
      order: (ORDERS.has(body.order ?? "") ? body.order : "viewCount") as
        | "viewCount"
        | "relevance"
        | "date",
      inspectLimit: 200,
      longFormOnly: body.longFormOnly !== false,
      longMinSec,
      longRatioMin,
      limit: Math.min(300, Math.max(10, num(body.limit, 100))),
    });

    // Ghi quota đã tiêu (best-effort; không chặn response).
    recordKeyQuota(result.usage).catch(() => {});

    return NextResponse.json({
      ok: true,
      channels: result.channels,
      videosScanned: result.videosScanned,
      channelsFound: result.channelsFound,
      channelsAfterFilter: result.channelsAfterFilter,
      vietnameseDropped: result.vietnameseDropped,
      matchDurationDropped: result.matchDurationDropped,
      inspected: result.inspected,
      shortFormDropped: result.shortFormDropped,
      quotaSpent: result.quotaSpent,
      keyCount: apiKeys.length,
      queriesUsed: queries.length,
    });
  } catch (err) {
    if (err instanceof YouTubeError)
      return NextResponse.json({ error: err.message, kind: "youtube" }, { status: 502 });
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Lỗi không xác định" },
      { status: 500 }
    );
  }
}
