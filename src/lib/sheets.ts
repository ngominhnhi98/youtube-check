/**
 * Write video rows into a Google Sheet.
 *
 * Base layout (columns A–F, matches the user's existing sheets):
 *   STT | Tieu de | Thoi luong | Luot xem | Dang luc | Link
 * Optional extra columns are appended from column G onward, so old 6-column
 * sheets stay valid.
 *
 * Auth: uses the server-side Google OAuth access token (refresh-token flow);
 * falls back to a service account (GOOGLE_SERVICE_ACCOUNT_JSON) if present.
 */
import { JWT } from "google-auth-library";
import type { VideoRow } from "@/lib/youtube";

export const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";
const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];

export const HEADER = ["STT", "Tieu de", "Thoi luong", "Luot xem", "Dang luc", "Link"];

export class SheetsError extends Error {}
export class SheetFormatError extends SheetsError {}

// ── Optional extra columns (G+) ─────────────────────────────────────────────

export interface ExtraColumn {
  header: string;
  value: (v: VideoRow) => string | number;
}

const EXTRA_COLUMNS: Record<string, ExtraColumn> = {
  likes: { header: "Likes", value: (v) => v.likeCount },
  comments: { header: "Comments", value: (v) => v.commentCount },
  engagement: { header: "Engagement %", value: (v) => v.engagementRate },
  viewsPerDay: { header: "Views/ngay", value: (v) => v.viewsPerDay },
  publishedDate: { header: "Ngay dang", value: (v) => v.publishedDate },
  category: { header: "Category", value: (v) => v.categoryName },
  channel: { header: "Channel", value: (v) => v.channelTitle },
};

export function resolveExtraColumns(keys: string[]): ExtraColumn[] {
  return keys.map((k) => EXTRA_COLUMNS[k]).filter(Boolean);
}

// ── Auth ───────────────────────────────────────────────────────────────────

function loadServiceAccount(): { client_email: string; private_key: string } {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON!;
  const parsed = JSON.parse(raw);
  parsed.private_key = parsed.private_key.replace(/\\n/g, "\n");
  return parsed;
}

async function serviceAccountToken(): Promise<string> {
  const sa = loadServiceAccount();
  const client = new JWT({ email: sa.client_email, key: sa.private_key, scopes: SCOPES });
  const { access_token } = await client.authorize();
  if (!access_token) throw new SheetsError("Service account không lấy được access token.");
  return access_token;
}

export async function resolveToken(accessToken?: string | null): Promise<string> {
  // Prefer the per-user Google access token from the browser (privacy).
  if (accessToken) return accessToken;
  // Fallback: a shared service account, only if configured server-side.
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) return serviceAccountToken();
  throw new SheetsError("Chưa kết nối Google. Bấm “Kết nối Google”.");
}

// ── REST helpers ─────────────────────────────────────────────────────────────

export function authHeaders(token: string) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

export async function apiError(res: Response, op: string): Promise<SheetsError> {
  let detail = "";
  try {
    detail = (await res.json())?.error?.message ?? "";
  } catch {
    /* ignore */
  }
  if (res.status === 401)
    return new SheetsError(`Phiên Google hết hạn (401). Kết nối Google lại. ${detail}`);
  if (res.status === 403)
    return new SheetsError(
      `Không có quyền ghi sheet (403). Tài khoản Google phải là chủ/Editor của sheet. ${detail}`
    );
  if (res.status === 404)
    return new SheetsError(`Không tìm thấy spreadsheet (404). Kiểm tra link. ${detail}`);
  return new SheetsError(`Sheets ${op} lỗi (${res.status})${detail ? `: ${detail}` : ""}`);
}

export interface SheetMeta {
  sheetId: number;
  title: string;
}

export async function getSheets(id: string, token: string): Promise<SheetMeta[]> {
  const res = await fetch(`${SHEETS_API}/${id}?fields=sheets(properties(sheetId,title))`, {
    headers: authHeaders(token),
  });
  if (!res.ok) throw await apiError(res, "read metadata");
  const j = await res.json();
  return (j.sheets ?? []).map((s: { properties: SheetMeta }) => s.properties);
}

async function addTab(id: string, token: string, title: string): Promise<void> {
  const res = await fetch(`${SHEETS_API}/${id}:batchUpdate`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ requests: [{ addSheet: { properties: { title } } }] }),
  });
  if (!res.ok) throw await apiError(res, "add tab");
}

async function getValues(id: string, token: string, range: string): Promise<string[][]> {
  const res = await fetch(`${SHEETS_API}/${id}/values/${encodeURIComponent(range)}`, {
    headers: authHeaders(token),
  });
  if (!res.ok) throw await apiError(res, "read values");
  return ((await res.json()).values ?? []) as string[][];
}

async function putValues(
  id: string,
  token: string,
  range: string,
  values: (string | number)[][]
): Promise<void> {
  const res = await fetch(
    `${SHEETS_API}/${id}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
    { method: "PUT", headers: authHeaders(token), body: JSON.stringify({ values }) }
  );
  if (!res.ok) throw await apiError(res, "write values");
}

/** Update several (range, values) pairs in one request. */
async function batchPutValues(
  id: string,
  token: string,
  data: { range: string; values: (string | number)[][] }[]
): Promise<void> {
  if (data.length === 0) return;
  const res = await fetch(`${SHEETS_API}/${id}/values:batchUpdate`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ valueInputOption: "USER_ENTERED", data }),
  });
  if (!res.ok) throw await apiError(res, "batch write values");
}

// ── Format helpers ──────────────────────────────────────────────────────────

export function parseSpreadsheetId(input: string): string {
  const raw = input.trim();
  const m = raw.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (m) return m[1];
  if (/^[a-zA-Z0-9-_]{20,}$/.test(raw)) return raw;
  throw new SheetsError(`Không tìm thấy spreadsheet id trong "${input}".`);
}

export function colLetter(index0: number): string {
  let n = index0;
  let s = "";
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

/** Only the base A–F header is enforced; extra columns are additive. */
function headerMismatch(existing: string[]): string | null {
  const problems: string[] = [];
  for (let i = 0; i < HEADER.length; i++) {
    const got = (existing[i] ?? "").trim();
    if (got !== HEADER[i]) {
      problems.push(`cột ${colLetter(i)}: cần "${HEADER[i]}", đang là "${got || "(trống)"}"`);
    }
  }
  return problems.length ? problems.join("; ") : null;
}

/** Full row for a video, given its STT number. */
function buildRow(v: VideoRow, stt: number, extra: ExtraColumn[]): (string | number)[] {
  return [
    stt,
    v.title,
    v.durationLabel,
    v.viewsLabel,
    v.publishedRelative,
    v.url,
    ...extra.map((c) => c.value(v)),
  ];
}

function buildRows(
  videos: VideoRow[],
  startStt: number,
  extra: ExtraColumn[]
): (string | number)[][] {
  return videos.map((v, i) => buildRow(v, startStt + i, extra));
}

/**
 * Dedup key for a video URL — the YouTube video id when present, else the
 * trimmed URL. Lets us match rows even if the stored URL differs slightly.
 */
export function videoKey(url: string): string {
  const s = (url ?? "").trim();
  const m = s.match(/[?&]v=([a-zA-Z0-9_-]{11})/) || s.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : s.toLowerCase();
}

// ── Public API ──────────────────────────────────────────────────────────────

export interface WriteOptions {
  tab?: string;
  createNewTab?: boolean;
  channelTitle?: string;
  extraColumns?: ExtraColumn[];
  /** Per-user Google OAuth access token from the browser. */
  accessToken?: string | null;
}

export interface WriteResult {
  spreadsheetId: string;
  tab: string;
  /** New rows appended to the bottom. */
  rowsWritten: number;
  /** Existing rows whose views were refreshed (duplicate URLs). */
  rowsUpdated: number;
  headerCreated: boolean;
  startStt: number;
}

export async function writeVideosToSheet(
  sheetUrlOrId: string,
  videos: VideoRow[],
  opts: WriteOptions = {}
): Promise<WriteResult> {
  const extra = opts.extraColumns ?? [];
  const fullHeader = [...HEADER, ...extra.map((c) => c.header)];
  const spreadsheetId = parseSpreadsheetId(sheetUrlOrId);
  const token = await resolveToken(opts.accessToken);
  const titles = (await getSheets(spreadsheetId, token)).map((t) => t.title);

  let tab: string;
  let headerCreated = false;
  let startStt = 1;
  let existing: string[][] = []; // full existing values incl. header row (empty if new tab)

  if (opts.createNewTab) {
    const base =
      (opts.tab && opts.tab.trim()) || sanitizeTabName(opts.channelTitle || "Videos") || "Videos";
    tab = uniqueTabName(base, titles);
    await addTab(spreadsheetId, token, tab);
    await putValues(spreadsheetId, token, `${tab}!A1`, [fullHeader]);
    headerCreated = true;
  } else {
    tab = (opts.tab && opts.tab.trim()) || "Sheet1";
    if (!titles.includes(tab)) {
      await addTab(spreadsheetId, token, tab);
      await putValues(spreadsheetId, token, `${tab}!A1`, [fullHeader]);
      headerCreated = true;
    } else {
      existing = await getValues(spreadsheetId, token, `${tab}!A1:Z`);
      if (existing.length === 0) {
        await putValues(spreadsheetId, token, `${tab}!A1`, [fullHeader]);
        headerCreated = true;
        existing = [];
      } else {
        const mismatch = headerMismatch(existing[0] ?? []);
        if (mismatch) {
          throw new SheetFormatError(
            `Sheet/tab "${tab}" sai định dạng — ${mismatch}. Header đúng: ${HEADER.join(" | ")}.`
          );
        }
        // Ensure the extra-column headers exist (additive, on the right).
        if (extra.length > 0) {
          await putValues(spreadsheetId, token, `${tab}!${colLetter(HEADER.length)}1`, [
            extra.map((c) => c.header),
          ]);
        }
        startStt = existing.length; // continue numbering after existing rows
      }
    }
  }

  // Map existing URLs (Link = column F, index 5) -> their sheet row & STT so we
  // can refresh a duplicate in place instead of appending a second copy.
  const rowByKey = new Map<string, number>(); // videoKey -> 1-based sheet row
  const sttByKey = new Map<string, number>();
  for (let r = 1; r < existing.length; r++) {
    // skip header at r=0
    const url = existing[r]?.[5] ?? "";
    if (!url) continue;
    const key = videoKey(url);
    if (rowByKey.has(key)) continue; // keep the first occurrence
    rowByKey.set(key, r + 1);
    const stt = Number(existing[r]?.[0]);
    sttByKey.set(key, Number.isFinite(stt) ? stt : r);
  }

  // Split incoming videos: duplicates → update existing row; new URLs → append.
  const updates: { range: string; values: (string | number)[][] }[] = [];
  const appends: VideoRow[] = [];
  const seenNew = new Set<string>();
  for (const v of videos) {
    const key = videoKey(v.url);
    const row = rowByKey.get(key);
    if (row !== undefined) {
      // Refresh the existing row (views + other metrics), keeping its STT.
      updates.push({ range: `${tab}!A${row}`, values: [buildRow(v, sttByKey.get(key) ?? row - 1, extra)] });
    } else if (!seenNew.has(key)) {
      seenNew.add(key); // avoid duplicate appends within this same batch
      appends.push(v);
    }
  }

  await batchPutValues(spreadsheetId, token, updates);

  const rows = buildRows(appends, startStt, extra);
  if (rows.length > 0) {
    const firstRow = headerCreated ? 2 : startStt + 1;
    await putValues(spreadsheetId, token, `${tab}!A${firstRow}`, rows);
  }

  return {
    spreadsheetId,
    tab,
    rowsWritten: rows.length,
    rowsUpdated: updates.length,
    headerCreated,
    startStt,
  };
}

function sanitizeTabName(name: string): string {
  return name.replace(/[:\\/?*[\]]/g, " ").trim().slice(0, 90);
}

function uniqueTabName(base: string, taken: string[]): string {
  if (!taken.includes(base)) return base;
  let i = 2;
  while (taken.includes(`${base} (${i})`)) i++;
  return `${base} (${i})`;
}
