/**
 * Duplicate-link scanner for a Google Sheet column.
 *
 * Reads one column top-to-bottom; the first time a link appears it is kept,
 * every later row holding the same link is a duplicate and its WHOLE row is
 * painted red in the sheet (Google Sheets "undo" can revert it).
 *
 * Cells are read through `includeGridData` rather than the values API because
 * the column rarely holds plain URLs. It mixes:
 *   - smart chips (Insert > Smart chip / paste + "Chip") — the cell shows the
 *     YouTube *title*, the URL lives in `chipRuns[].chip.richLinkProperties`;
 *   - normal hyperlinks (`hyperlink` / `textFormatRuns[].format.link`);
 *   - `=HYPERLINK("…")` formulas;
 *   - plain text URLs.
 * A values read would return the visible label ("A VERDADE POR TRÁS DA …") for
 * the first three, so every row would look unique.
 */
import {
  SHEETS_API,
  SheetsError,
  apiError,
  authHeaders,
  colLetter,
  getSheets,
  parseSpreadsheetId,
  resolveToken,
  type SheetMeta,
} from "@/lib/sheets";

export const DEFAULT_COLOR = "#ff0000";
/** Sheets rejects very large batchUpdate bodies; paint in chunks. */
const PAINT_CHUNK = 200;
/** Rows returned to the browser (the sheet itself always gets every row). */
export const MAX_REPORTED = 500;

export interface DupeOptions {
  sheetUrl: string;
  /** Column letter, e.g. "B". */
  column: string;
  /** Tab name; empty = the tab from `#gid=` in the link, else the first tab. */
  tab?: string;
  /** 1-based first data row (skips header rows). */
  startRow?: number;
  /** false = report only, don't touch the sheet. */
  apply?: boolean;
  /** Highlight colour as hex, e.g. "#ff0000". */
  color?: string;
  accessToken?: string | null;
}

export interface DupeItem {
  /** 1-based sheet row of the duplicate. */
  row: number;
  /** 1-based row where the link was first seen. */
  firstRow: number;
  /** The link (or cell text when the cell holds no link). */
  value: string;
}

export interface DupeResult {
  spreadsheetId: string;
  tab: string;
  column: string;
  /** Non-empty cells looked at, from `startRow` down. */
  scanned: number;
  /** Distinct links among them. */
  unique: number;
  /** Rows that repeat an earlier link. */
  duplicates: number;
  /** Rows actually painted red (0 when `apply` is false). */
  painted: number;
  /** Scanned cells with no URL at all — compared by their visible text. */
  textOnly: number;
  applied: boolean;
  items: DupeItem[];
  truncated: boolean;
}

// ── Parsing helpers ─────────────────────────────────────────────────────────

/** `…/edit?gid=123#gid=123` -> 123. */
export function parseGid(input: string): number | null {
  const m = (input ?? "").match(/[?&#]gid=(\d+)/);
  return m ? Number(m[1]) : null;
}

/** "b" -> 1, "AB" -> 27. */
export function columnIndex(letters: string): number {
  const s = (letters ?? "").trim().toUpperCase();
  if (!/^[A-Z]{1,3}$/.test(s))
    throw new SheetsError(`Tên cột không hợp lệ: "${letters}". Dùng chữ cái, ví dụ B hoặc AB.`);
  let n = 0;
  for (const ch of s) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** "#f80" / "#ff8800" -> the 0–1 RGB triple the Sheets API wants. */
export function hexToRgb(hex: string): { red: number; green: number; blue: number } {
  const s = (hex ?? "").trim().replace(/^#/, "");
  const full = s.length === 3 ? s.replace(/./g, (c) => c + c) : s;
  if (!/^[0-9a-fA-F]{6}$/.test(full))
    throw new SheetsError(`Mã màu không hợp lệ: "${hex}". Dùng dạng #RRGGBB.`);
  const n = parseInt(full, 16);
  return {
    red: ((n >> 16) & 255) / 255,
    green: ((n >> 8) & 255) / 255,
    blue: (n & 255) / 255,
  };
}

const YT_ID =
  /(?:youtube\.com\/(?:watch\?(?:[^#\s]*&)?v=|shorts\/|embed\/|live\/|v\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;

/**
 * Comparison key for a cell. Two YouTube links pointing at the same video
 * count as duplicates even when written differently (youtu.be, /shorts/,
 * extra query params). Anything else is compared as a normalised string.
 */
export function linkKey(raw: string): string {
  const s = (raw ?? "").trim();
  if (!s) return "";
  const yt = s.match(YT_ID);
  if (yt) return `yt:${yt[1]}`;
  return s
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[/?#]+$/, "");
}

function quoteTab(title: string): string {
  return `'${title.replace(/'/g, "''")}'`;
}

// ── Grid read ───────────────────────────────────────────────────────────────

interface GridCell {
  formattedValue?: string;
  hyperlink?: string;
  userEnteredValue?: { stringValue?: string; formulaValue?: string };
  textFormatRuns?: { format?: { link?: { uri?: string } } }[];
  chipRuns?: { chip?: { richLinkProperties?: { uri?: string } } }[];
}

export interface CellLink {
  /** URL when we could find one, else the cell's visible text. */
  value: string;
  /** false = we only have text, so the comparison is by label, not by URL. */
  linked: boolean;
}

/** The URL behind a cell, however the link was added; falls back to its text. */
function readCell(cell: GridCell | undefined): CellLink {
  if (!cell) return { value: "", linked: false };
  // Smart chip: the cell renders the video title, the URL is in the chip.
  for (const run of cell.chipRuns ?? []) {
    const uri = run.chip?.richLinkProperties?.uri;
    if (uri) return { value: uri, linked: true };
  }
  if (cell.hyperlink) return { value: cell.hyperlink, linked: true };
  for (const run of cell.textFormatRuns ?? []) {
    const uri = run.format?.link?.uri;
    if (uri) return { value: uri, linked: true };
  }
  const formula = cell.userEnteredValue?.formulaValue;
  if (formula) {
    const m = formula.match(/HYPERLINK\(\s*"([^"]+)"/i);
    if (m) return { value: m[1], linked: true };
  }
  const text = cell.formattedValue ?? cell.userEnteredValue?.stringValue ?? "";
  return { value: text, linked: /^https?:\/\//i.test(text.trim()) };
}

const CELL_FIELDS =
  "formattedValue,hyperlink,userEnteredValue,textFormatRuns(format(link(uri)))";
const CHIP_FIELDS = "chipRuns(chip(richLinkProperties(uri)))";

function gridUrl(spreadsheetId: string, range: string, cellFields: string): string {
  const fields = `sheets(data(rowData(values(${cellFields}))))`;
  return (
    `${SHEETS_API}/${spreadsheetId}?includeGridData=true` +
    `&ranges=${encodeURIComponent(range)}&fields=${encodeURIComponent(fields)}`
  );
}

/** Column contents, index 0 = sheet row 1. */
async function readColumn(
  spreadsheetId: string,
  token: string,
  tab: string,
  letters: string
): Promise<CellLink[]> {
  const range = `${quoteTab(tab)}!${letters}1:${letters}`;
  const headers = authHeaders(token);

  let res = await fetch(gridUrl(spreadsheetId, range, `${CELL_FIELDS},${CHIP_FIELDS}`), {
    headers,
  });
  // Older Sheets deployments reject the `chipRuns` field mask outright; without
  // it smart-chip cells fall back to their title text, which still works.
  if (res.status === 400) {
    res = await fetch(gridUrl(spreadsheetId, range, CELL_FIELDS), { headers });
  }
  if (!res.ok) throw await apiError(res, "read column");

  const json = await res.json();
  const rowData = (json.sheets?.[0]?.data?.[0]?.rowData ?? []) as {
    values?: GridCell[];
  }[];
  return rowData.map((r) => readCell(r?.values?.[0]));
}

// ── Painting ────────────────────────────────────────────────────────────────

/** [3,4,5,9] -> [[3,5],[9,9]] so consecutive duplicates become one request. */
function mergeRuns(rows: number[]): [number, number][] {
  const runs: [number, number][] = [];
  for (const r of rows) {
    const last = runs[runs.length - 1];
    if (last && r === last[1] + 1) last[1] = r;
    else runs.push([r, r]);
  }
  return runs;
}

async function batchUpdate(
  spreadsheetId: string,
  token: string,
  requests: unknown[]
): Promise<void> {
  const res = await fetch(`${SHEETS_API}/${spreadsheetId}:batchUpdate`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ requests }),
  });
  if (!res.ok) throw await apiError(res, "format rows");
}

/** Paint whole rows. `rows0` are 0-based row indexes. */
async function paintRows(
  spreadsheetId: string,
  token: string,
  sheetId: number,
  rows0: number[],
  color: { red: number; green: number; blue: number }
): Promise<void> {
  const requests = mergeRuns(rows0).map(([from, to]) => ({
    repeatCell: {
      // No column bounds = the entire row.
      range: { sheetId, startRowIndex: from, endRowIndex: to + 1 },
      cell: { userEnteredFormat: { backgroundColor: color } },
      fields: "userEnteredFormat.backgroundColor",
    },
  }));
  for (let i = 0; i < requests.length; i += PAINT_CHUNK) {
    await batchUpdate(spreadsheetId, token, requests.slice(i, i + PAINT_CHUNK));
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

function pickTab(sheets: SheetMeta[], wanted: string, gid: number | null): SheetMeta {
  if (wanted) {
    const hit = sheets.find((s) => s.title === wanted);
    if (!hit)
      throw new SheetsError(
        `Không tìm thấy tab "${wanted}". Các tab hiện có: ${sheets.map((s) => s.title).join(", ")}.`
      );
    return hit;
  }
  if (gid !== null) {
    const byGid = sheets.find((s) => s.sheetId === gid);
    if (byGid) return byGid;
  }
  return sheets[0];
}

export async function scanDuplicateLinks(opts: DupeOptions): Promise<DupeResult> {
  const spreadsheetId = parseSpreadsheetId(opts.sheetUrl);
  const colIdx = columnIndex(opts.column);
  const letters = colLetter(colIdx);
  const startRow = Math.max(1, Math.floor(opts.startRow ?? 1));
  const apply = opts.apply !== false;
  const color = hexToRgb(opts.color || DEFAULT_COLOR);

  const token = await resolveToken(opts.accessToken);
  const sheets = await getSheets(spreadsheetId, token);
  if (sheets.length === 0) throw new SheetsError("Spreadsheet không có tab nào.");
  const meta = pickTab(sheets, (opts.tab ?? "").trim(), parseGid(opts.sheetUrl));

  const values = await readColumn(spreadsheetId, token, meta.title, letters);

  const firstSeen = new Map<string, number>(); // key -> 1-based row
  const items: DupeItem[] = [];
  const dupRows0: number[] = [];
  let scanned = 0;
  let textOnly = 0;

  for (let i = startRow - 1; i < values.length; i++) {
    const cell = values[i] ?? { value: "", linked: false };
    const key = linkKey(cell.value);
    if (!key) continue; // empty cell: not a duplicate, not counted
    scanned++;
    if (!cell.linked) textOnly++;
    const first = firstSeen.get(key);
    if (first === undefined) {
      firstSeen.set(key, i + 1);
      continue;
    }
    dupRows0.push(i);
    if (items.length < MAX_REPORTED)
      items.push({ row: i + 1, firstRow: first, value: cell.value });
  }

  if (apply && dupRows0.length > 0) {
    await paintRows(spreadsheetId, token, meta.sheetId, dupRows0, color);
  }

  return {
    spreadsheetId,
    tab: meta.title,
    column: letters,
    scanned,
    unique: firstSeen.size,
    duplicates: dupRows0.length,
    painted: apply ? dupRows0.length : 0,
    textOnly,
    applied: apply,
    items,
    truncated: dupRows0.length > items.length,
  };
}
