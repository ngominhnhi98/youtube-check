"use client";

import { useEffect, useState } from "react";
import type { GoogleConnection } from "@/components/useGoogleAuth";
import { Field, Section, Stat, input } from "@/components/ui";
import ColorPicker from "@/components/ColorPicker";

const DEFAULT_COLOR = "#ff0000";

interface DupeItem {
  row: number;
  firstRow: number;
  value: string;
}

interface DupeResult {
  tab: string;
  column: string;
  scanned: number;
  unique: number;
  duplicates: number;
  painted: number;
  textOnly: number;
  applied: boolean;
  items: DupeItem[];
  truncated: boolean;
}

const cleanInt = (v: string) => v.replace(/[^\d]/g, "").replace(/^0+(?=\d)/, "");

export default function DupeForm({
  g,
  canEdit,
}: {
  g: GoogleConnection;
  canEdit: boolean;
}) {
  const [sheetUrl, setSheetUrl] = useState("");
  const [column, setColumn] = useState("B");
  const [tab, setTab] = useState("");
  const [startRow, setStartRow] = useState("2");
  const [color, setColor] = useState(DEFAULT_COLOR);
  const [dryRun, setDryRun] = useState(false);

  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<DupeResult | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  const disabled = !canEdit || running;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (running) return;
    setError(null);
    setResult(null);

    let googleAccessToken: string | null = null;
    if (g.configured) {
      googleAccessToken = await g.getToken();
      if (!googleAccessToken) {
        setError("Chưa kết nối Google. Bấm “Kết nối Google” trước khi chạy.");
        return;
      }
    }

    setRunning(true);
    try {
      const res = await fetch("/api/dupes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sheetUrl,
          column,
          tab,
          startRow: Number(startRow) || 1,
          apply: !dryRun,
          color,
          googleAccessToken,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? (data.errors ? data.errors.join(" ") : "Thất bại"));
        return;
      }
      setResult(data);
      setToast(
        data.duplicates === 0
          ? `Không có link trùng trong cột ${data.column} (tab “${data.tab}”).`
          : data.applied
            ? `${data.painted} dòng trùng đã được tô màu trong tab “${data.tab}”.`
            : `Tìm thấy ${data.duplicates} dòng trùng (chưa tô — đang bật quét thử).`
      );
    } catch {
      setError("Lỗi kết nối.");
    } finally {
      setRunning(false);
    }
  }

  return (
    <>
      <form
        onSubmit={submit}
        className="mt-3 space-y-5 rounded-2xl border bg-card p-4 shadow-sm sm:mt-4 sm:p-5"
      >
        <Section title="Nguồn">
          <Field label="Link Google Sheet" hint="gid trong link = tab được quét">
            <input
              value={sheetUrl}
              onChange={(e) => setSheetUrl(e.target.value)}
              placeholder="https://docs.google.com/spreadsheets/d/…/edit?gid=0#gid=0"
              className={input}
              disabled={disabled}
              inputMode="url"
            />
          </Field>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4">
            <Field label="Cột chứa link" hint="vd: B">
              <input
                value={column}
                onChange={(e) => setColumn(e.target.value.replace(/[^A-Za-z]/g, "").toUpperCase())}
                placeholder="B"
                className={input}
                disabled={disabled}
                maxLength={3}
              />
            </Field>
            <Field label="Dòng bắt đầu" hint="bỏ qua header">
              <input
                value={startRow}
                onChange={(e) => {
                  const v = cleanInt(e.target.value);
                  e.target.value = v;
                  setStartRow(v);
                }}
                className={input}
                disabled={disabled}
                inputMode="numeric"
              />
            </Field>
            <Field label="Tên tab" hint="bỏ trống = theo gid">
              <input
                value={tab}
                onChange={(e) => setTab(e.target.value)}
                placeholder="(theo link)"
                className={input}
                disabled={disabled}
              />
            </Field>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 sm:gap-4">
            <Field label="Màu tô dòng trùng" hint="mặc định đỏ">
              <ColorPicker color={color} onChange={setColor} disabled={disabled} />
            </Field>
            <div className="flex items-end pb-2 sm:col-span-2">
              {color.toLowerCase() !== DEFAULT_COLOR && (
                <button
                  type="button"
                  onClick={() => setColor(DEFAULT_COLOR)}
                  disabled={disabled}
                  className="text-xs text-blue-600 hover:underline disabled:opacity-50 dark:text-blue-400"
                >
                  ↺ về màu đỏ mặc định
                </button>
              )}
            </div>
          </div>

          <label className="flex items-center">
            <span className="flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={dryRun}
                onChange={(e) => setDryRun(e.target.checked)}
                disabled={disabled}
                className="h-4 w-4"
              />
              Chỉ quét thử — không tô màu vào sheet
            </span>
          </label>

          <p className="text-xs leading-relaxed text-muted">
            Quét cột từ trên xuống. Link xuất hiện <b>lần đầu</b> được giữ nguyên; mọi dòng lặp lại
            link đó sẽ bị <b>tô màu cả dòng</b> ngay trên Google Sheet. Đọc được cả ô dạng
            <b>smart chip</b> (ô hiện tiêu đề video), ô gắn link, công thức <code>HYPERLINK</code> và
            URL thường. Link YouTube được so theo mã video nên <code>youtu.be/…</code> và
            <code>watch?v=…</code> vẫn tính là trùng. Màu cũ của dòng bị trùng sẽ bị ghi đè (có thể
            Ctrl+Z trong Sheet để hoàn tác).
          </p>
        </Section>

        {error && (
          <p className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={disabled}
          className="w-full rounded-lg bg-blue-600 px-4 py-3 text-sm font-semibold text-white transition hover:bg-blue-700 active:scale-[0.99] disabled:opacity-50"
        >
          {running ? (
            "Đang quét…"
          ) : dryRun ? (
            "🔍 Quét thử (không tô màu)"
          ) : (
            <span className="inline-flex items-center justify-center gap-2">
              <span
                className="h-3.5 w-3.5 rounded-full border border-white/60"
                style={{ backgroundColor: color }}
                aria-hidden
              />
              Quét &amp; tô màu dòng trùng
            </span>
          )}
        </button>
      </form>

      {result && <DupePanel result={result} />}

      {toast && (
        <div className="fixed inset-x-3 bottom-4 z-50 mx-auto max-w-md rounded-lg border bg-card px-4 py-2.5 text-center text-sm shadow-lg sm:inset-x-0">
          {toast}
        </div>
      )}
    </>
  );
}

function DupePanel({ result }: { result: DupeResult }) {
  return (
    <section className="mt-4 rounded-2xl border bg-card p-4 shadow-sm sm:mt-5 sm:p-5">
      <h2 className="mb-3 text-base font-semibold">Báo cáo link trùng</h2>
      <div className="mb-4 grid grid-cols-2 gap-2.5 sm:grid-cols-4 sm:gap-3">
        <Stat label="Tab · cột" value={`${result.tab} · ${result.column}`} />
        <Stat label="Ô có link" value={String(result.scanned)} />
        <Stat label="Link khác nhau" value={String(result.unique)} />
        <Stat
          label={result.applied ? "Trùng · đã tô màu" : "Trùng (chưa tô)"}
          value={result.applied ? `${result.duplicates} · ${result.painted}` : String(result.duplicates)}
        />
      </div>

      {result.textOnly > 0 && (
        <p className="mb-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-700/50 dark:bg-amber-950/30 dark:text-amber-200">
          {result.textOnly} ô không có link bên trong — những ô này được so theo <b>chữ hiển thị</b>,
          nên hai video khác nhau mà trùng tiêu đề vẫn bị coi là trùng.
        </p>
      )}

      {result.items.length > 0 ? (
        <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
          <table className="w-full text-left text-sm">
            <thead className="text-muted">
              <tr className="border-b">
                <th className="py-2 pr-3">Dòng trùng</th>
                <th className="py-2 pr-3">Trùng với dòng</th>
                <th className="py-2">Link</th>
              </tr>
            </thead>
            <tbody>
              {result.items.map((it) => (
                <tr key={it.row} className="border-b border-border/60">
                  <td className="py-2 pr-3 tabular-nums font-medium text-red-600 dark:text-red-400">
                    {it.row}
                  </td>
                  <td className="py-2 pr-3 tabular-nums text-muted">{it.firstRow}</td>
                  <td className="max-w-[60vw] truncate py-2 sm:max-w-lg">
                    {/^https?:\/\//.test(it.value) ? (
                      <a
                        href={it.value}
                        target="_blank"
                        rel="noreferrer"
                        className="text-blue-600 hover:underline"
                      >
                        {it.value}
                      </a>
                    ) : (
                      it.value
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {result.truncated && (
            <p className="mt-2 text-xs text-muted">
              Hiển thị {result.items.length}/{result.duplicates} dòng —
              {result.applied ? " toàn bộ đã được tô màu trong sheet." : " phần còn lại chưa liệt kê."}
            </p>
          )}
        </div>
      ) : (
        <p className="text-sm text-muted">Không tìm thấy link trùng. 🎉</p>
      )}
    </section>
  );
}
