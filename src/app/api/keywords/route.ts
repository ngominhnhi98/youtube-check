import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { buildQueries } from "@/lib/discover";
import { GeminiError } from "@/lib/gemini";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// POST /api/keywords — Gemini sinh truy vấn tìm kiếm từ một keyword.
// Tách khỏi /api/discover để người dùng xem/sửa danh sách trước khi đốt quota
// YouTube (mỗi truy vấn = 100 units).
export async function POST(req: NextRequest) {
  const unauthorized = requireAuth(req);
  if (unauthorized) return unauthorized;

  let body: {
    keyword?: string;
    includeVietnam?: boolean;
    count?: number;
    markets?: string[];
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const keyword = (body.keyword ?? "").trim();
  if (!keyword) return NextResponse.json({ error: "Thiếu từ khoá chủ đề." }, { status: 400 });
  if (keyword.length > 200)
    return NextResponse.json({ error: "Từ khoá quá dài (tối đa 200 ký tự)." }, { status: 400 });

  const count = Math.min(20, Math.max(3, Number(body.count) || 10));

  try {
    const queries = await buildQueries({
      keyword,
      includeVietnam: Boolean(body.includeVietnam),
      count,
      markets: Array.isArray(body.markets) ? body.markets.map(String).slice(0, 20) : [],
    });
    if (queries.length === 0)
      return NextResponse.json(
        { error: "Gemini không sinh được truy vấn nào. Thử mô tả chủ đề rõ hơn." },
        { status: 502 }
      );
    return NextResponse.json({ ok: true, queries });
  } catch (err) {
    if (err instanceof GeminiError)
      return NextResponse.json({ error: err.message, kind: "gemini" }, { status: 502 });
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Lỗi không xác định" },
      { status: 500 }
    );
  }
}
