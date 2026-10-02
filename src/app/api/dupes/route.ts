import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { scanDuplicateLinks } from "@/lib/dupes";
import { SheetsError } from "@/lib/sheets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface DupeBody {
  sheetUrl?: string;
  column?: string;
  tab?: string;
  startRow?: number;
  apply?: boolean;
  color?: string;
  googleAccessToken?: string | null;
}

export async function POST(req: NextRequest) {
  const unauthorized = requireAuth(req);
  if (unauthorized) return unauthorized;

  let body: DupeBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const sheetUrl = (body.sheetUrl ?? "").trim();
  const column = (body.column ?? "").trim();
  const startRow = Number(body.startRow);
  const color = (body.color ?? "").trim();

  const errors: string[] = [];
  if (!sheetUrl) errors.push("Thiếu link Google Sheet.");
  if (!column) errors.push("Thiếu tên cột (ví dụ: B).");
  else if (!/^[A-Za-z]{1,3}$/.test(column)) errors.push(`Tên cột không hợp lệ: "${column}".`);
  if (body.startRow !== undefined && (!Number.isFinite(startRow) || startRow < 1))
    errors.push("Dòng bắt đầu phải ≥ 1.");
  if (color && !/^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(color))
    errors.push(`Mã màu không hợp lệ: "${color}".`);
  if (errors.length) return NextResponse.json({ errors }, { status: 400 });

  try {
    const result = await scanDuplicateLinks({
      sheetUrl,
      column,
      tab: (body.tab ?? "").trim() || undefined,
      startRow: Number.isFinite(startRow) ? startRow : 1,
      apply: body.apply !== false,
      color: color || undefined,
      accessToken: body.googleAccessToken ?? null,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof SheetsError)
      return NextResponse.json({ error: err.message, kind: "sheets" }, { status: 502 });
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Lỗi không xác định" },
      { status: 500 }
    );
  }
}
