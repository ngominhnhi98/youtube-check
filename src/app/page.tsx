"use client";

import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import { useGoogleConnection } from "@/components/useGoogleAuth";
import SettingsModal from "@/components/SettingsModal";
import DupeForm from "@/components/DupeForm";
import DiscoverForm from "@/components/DiscoverForm";
import { Field, Section, Stat, input } from "@/components/ui";

interface VideoRow {
  videoId: string;
  title: string;
  url: string;
  viewsLabel: string;
  durationLabel: string;
  publishedRelative: string;
  likeCount: number;
  commentCount: number;
  engagementRate: number;
  viewsPerDay: number;
}

interface RunResult {
  channelTitle: string;
  scanned: number;
  matched: number;
  wrote: number;
  updated: number;
  tab: string | null;
  keyCount: number;
  preview: VideoRow[];
}

type Mode = "filter" | "dupes" | "discover";
const MODES: { id: Mode; label: string }[] = [
  { id: "filter", label: "Lọc video → Sheet" },
  { id: "dupes", label: "Quét link trùng" },
  { id: "discover", label: "Tìm kênh theo chủ đề" },
];

type Phase = "idle" | "resolve" | "fetch" | "write" | "done" | "error";
const STEPS: { key: Phase; label: string }[] = [
  { key: "resolve", label: "Tìm kênh" },
  { key: "fetch", label: "Lấy video" },
  { key: "write", label: "Ghi Sheet" },
];

const COLUMN_GROUPS = [
  { id: "likesComments", label: "Likes + Comments" },
  { id: "engagementVelocity", label: "Engagement % + Views/ngày" },
  { id: "dateCategoryChannel", label: "Ngày đăng + Category + Channel" },
];

// Numeric fields are kept as strings so the input never gets "stuck" (a React
// controlled number input that normalises back to the same number skips the
// re-render, leaving stray digits like "030" on screen). We parse on submit.
const toNum = (s: string) => (s.trim() === "" ? 0 : Number(s) || 0);
const cleanInt = (v: string) => v.replace(/[^\d]/g, "").replace(/^0+(?=\d)/, "");
const cleanFloat = (v: string) => v.replace(/[^\d.]/g, "").replace(/^0+(?=\d)/, "");

// Handler factories. We ALSO write the cleaned value back onto the DOM node so
// the field never gets stuck: if normalising yields the same state value React
// skips the re-render, and without this the raw keystrokes (e.g. "030") would
// linger in the input.
type Setter = (v: string) => void;
const onInt = (set: Setter) => (e: React.ChangeEvent<HTMLInputElement>) => {
  const v = cleanInt(e.target.value);
  e.target.value = v;
  set(v);
};
const onFloat = (set: Setter) => (e: React.ChangeEvent<HTMLInputElement>) => {
  const v = cleanFloat(e.target.value);
  e.target.value = v;
  set(v);
};

export default function Home() {
  const { canEdit, lock } = useAuth();
  const g = useGoogleConnection();

  const [channelUrl, setChannelUrl] = useState("");
  const [maxDays, setMaxDays] = useState("30");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [minViews, setMinViews] = useState("1000");
  const [minLikes, setMinLikes] = useState("0");
  const [minComments, setMinComments] = useState("0");
  const [minMinutes, setMinMinutes] = useState("0");
  const [maxMinutes, setMaxMinutes] = useState("0");
  const [minEngagement, setMinEngagement] = useState("0");
  const [minViewsPerDay, setMinViewsPerDay] = useState("0");

  const [sheetUrl, setSheetUrl] = useState("");
  const [tab, setTab] = useState("");
  const [createNewTab, setCreateNewTab] = useState(false);
  const [extraGroups, setExtraGroups] = useState<string[]>([]);

  const [mode, setMode] = useState<Mode>("filter");
  const [showSettings, setShowSettings] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RunResult | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  const running = phase === "resolve" || phase === "fetch" || phase === "write";

  function toggleGroup(id: string) {
    setExtraGroups((g) => (g.includes(id) ? g.filter((x) => x !== id) : [...g, id]));
  }

  async function run(e: React.FormEvent) {
    e.preventDefault();
    if (running) return;
    setError(null);
    setResult(null);

    // Get this browser's own Google token (may briefly show Google's popup).
    let googleAccessToken: string | null = null;
    if (g.configured) {
      googleAccessToken = await g.getToken();
      if (!googleAccessToken) {
        setError("Chưa kết nối Google. Bấm “Kết nối Google” trước khi chạy.");
        return;
      }
    }

    timers.current.forEach(clearTimeout);
    setPhase("resolve");
    timers.current = [
      setTimeout(() => setPhase((p) => (p === "resolve" ? "fetch" : p)), 1200),
      setTimeout(() => setPhase((p) => (p === "fetch" ? "write" : p)), 3500),
    ];

    try {
      const res = await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channelUrl,
          maxDays: toNum(maxDays) || 30,
          dateFrom,
          dateTo,
          minViews: toNum(minViews),
          minLikes: toNum(minLikes),
          minComments: toNum(minComments),
          minMinutes: toNum(minMinutes),
          maxMinutes: toNum(maxMinutes),
          minEngagement: toNum(minEngagement),
          minViewsPerDay: toNum(minViewsPerDay),
          sheetUrl,
          tab,
          createNewTab,
          extraColumnGroups: extraGroups,
          googleAccessToken,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        finishError(data.error ?? (data.errors ? data.errors.join(" ") : "Thất bại"));
        return;
      }
      timers.current.forEach(clearTimeout);
      setPhase("done");
      setResult(data);
      setToast(
        data.matched === 0
          ? "Hoàn tất — không có video nào đạt điều kiện."
          : `✅ Ghi ${data.wrote} video mới${data.updated ? `, cập nhật ${data.updated} video trùng` : ""} vào tab “${data.tab}”.`
      );
    } catch {
      finishError("Lỗi kết nối.");
    }
  }

  function finishError(msg: string) {
    timers.current.forEach(clearTimeout);
    setPhase("error");
    setError(msg);
  }

  const disabled = !canEdit || running;

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 border-b bg-card/80 backdrop-blur">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-3 px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-red-500/10 text-lg">
              ▶️
            </span>
            <div className="min-w-0 leading-tight">
              <div className="truncate text-sm font-semibold">YouTube Check</div>
              <div className="truncate text-xs text-muted">Lọc video &amp; đẩy vào Google Sheet</div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              onClick={() => setShowSettings(true)}
              className="rounded-md border px-2.5 py-1.5 text-sm hover:bg-black/5 dark:hover:bg-white/5"
              title="Cài đặt API key"
            >
              ⚙️
            </button>
            <button
              onClick={() => lock()}
              className="rounded-md border px-2.5 py-1.5 text-sm hover:bg-black/5 dark:hover:bg-white/5"
              title="Khóa"
            >
              🔒
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl px-3 py-4 sm:px-4 sm:py-6">
        {/* Tab "Tìm kênh" không đụng tới Sheet nên không cần Google. */}
        {mode !== "discover" && <GoogleCard g={g} />}

        <ModeTabs mode={mode} onChange={setMode} />

        {mode === "dupes" ? (
          <DupeForm g={g} canEdit={canEdit} />
        ) : mode === "discover" ? (
          <DiscoverForm canEdit={canEdit} />
        ) : (
          <>
          <form
            onSubmit={run}
            className="mt-3 space-y-5 rounded-2xl border bg-card p-4 shadow-sm sm:mt-4 sm:p-5"
          >
            <Section title="Nguồn">
              <Field label="Link kênh YouTube" hint="/channel/, /@handle, /user/, /c/">
                <input
                  value={channelUrl}
                  onChange={(e) => setChannelUrl(e.target.value)}
                  placeholder="https://www.youtube.com/@RedditTalesByUncleSammy"
                  className={input}
                  disabled={disabled}
                  inputMode="url"
                />
              </Field>
            </Section>

            <Section title="Khoảng thời gian">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <Field label="Trong N ngày" hint="khi bỏ trống ngày">
                  <input value={maxDays} onChange={onInt(setMaxDays)}
                    className={input} disabled={disabled} inputMode="numeric" />
                </Field>
                <Field label="Từ ngày">
                  <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)}
                    className={input} disabled={disabled} />
                </Field>
                <Field label="Đến ngày">
                  <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)}
                    className={input} disabled={disabled} />
                </Field>
              </div>
            </Section>

            <Section title="Bộ lọc">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4">
                <Field label="View tối thiểu">
                  <input value={minViews} onChange={onInt(setMinViews)}
                    className={input} disabled={disabled} inputMode="numeric" />
                </Field>
                <Field label="Like tối thiểu">
                  <input value={minLikes} onChange={onInt(setMinLikes)}
                    className={input} disabled={disabled} inputMode="numeric" />
                </Field>
                <Field label="Comment tối thiểu">
                  <input value={minComments} onChange={onInt(setMinComments)}
                    className={input} disabled={disabled} inputMode="numeric" />
                </Field>
                <Field label="Thời lượng ≥ phút" hint="0 = bỏ">
                  <input value={minMinutes} onChange={onInt(setMinMinutes)}
                    className={input} disabled={disabled} inputMode="numeric" />
                </Field>
                <Field label="Thời lượng ≤ phút" hint="0 = bỏ">
                  <input value={maxMinutes} onChange={onInt(setMaxMinutes)}
                    className={input} disabled={disabled} inputMode="numeric" />
                </Field>
                <Field label="Engagement ≥ %" hint="0 = bỏ">
                  <input value={minEngagement} onChange={onFloat(setMinEngagement)}
                    className={input} disabled={disabled} inputMode="decimal" />
                </Field>
                <Field label="Views/ngày ≥" hint="0 = bỏ">
                  <input value={minViewsPerDay} onChange={onInt(setMinViewsPerDay)}
                    className={input} disabled={disabled} inputMode="numeric" />
                </Field>
              </div>
            </Section>

            <Section title="Đích Google Sheet">
              <Field label="Link Google Sheet">
                <input
                  value={sheetUrl}
                  onChange={(e) => setSheetUrl(e.target.value)}
                  placeholder="https://docs.google.com/spreadsheets/d/…/edit"
                  className={input}
                  disabled={disabled}
                  inputMode="url"
                />
              </Field>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto] sm:items-end sm:gap-4">
                <Field label="Tên tab" hint={createNewTab ? "tên tab mới" : "bỏ trống = Sheet1"}>
                  <input value={tab} onChange={(e) => setTab(e.target.value)}
                    placeholder={createNewTab ? "Vd: tên kênh" : "Sheet1"} className={input} disabled={disabled} />
                </Field>
                <label className="flex items-center pb-2.5">
                  <span className="flex cursor-pointer items-center gap-2 text-sm">
                    <input type="checkbox" checked={createNewTab}
                      onChange={(e) => setCreateNewTab(e.target.checked)} disabled={disabled} className="h-4 w-4" />
                    Tạo tab mới
                  </span>
                </label>
              </div>

              <div>
                <span className="mb-1.5 block text-sm font-medium">Cột chi tiết (thêm từ cột G)</span>
                <div className="flex flex-wrap gap-2">
                  {COLUMN_GROUPS.map((c) => {
                    const on = extraGroups.includes(c.id);
                    return (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => toggleGroup(c.id)}
                        disabled={disabled}
                        className={`rounded-full border px-3 py-1.5 text-xs transition ${
                          on
                            ? "border-blue-500 bg-blue-500/10 text-blue-600 dark:text-blue-300"
                            : "text-muted hover:bg-black/5 dark:hover:bg-white/5"
                        }`}
                      >
                        {on ? "✓ " : "+ "}
                        {c.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <p className="text-xs leading-relaxed text-muted">
                Cột gốc A–F: <b>STT · Tieu de · Thoi luong · Luot xem · Dang luc · Link</b>. Tab
                trống tự tạo header; sai định dạng báo lỗi cụ thể.
              </p>
            </Section>

            {(running || phase === "done" || phase === "error") && <Stepper phase={phase} />}

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
              {running ? "Đang xử lý…" : "▶ Chạy & ghi vào Sheet"}
            </button>
          </form>

          {result && <ResultPanel result={result} />}
          </>
        )}
      </main>

      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}

      {toast && (
        <div className="fixed inset-x-3 bottom-4 z-50 mx-auto max-w-md rounded-lg border bg-card px-4 py-2.5 text-center text-sm shadow-lg sm:inset-x-0">
          {toast}
        </div>
      )}
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────

function GoogleCard({ g }: { g: ReturnType<typeof useGoogleConnection> }) {
  if (g.loading) return null;
  if (!g.configured) {
    return (
      <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-700/50 dark:bg-amber-950/30 dark:text-amber-200">
        Chưa cấu hình <code>NEXT_PUBLIC_GOOGLE_CLIENT_ID</code> — sẽ dùng service account (nếu có)
        để ghi Sheet.
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2 rounded-xl border bg-card px-4 py-3 shadow-sm sm:flex-row sm:items-center sm:justify-between sm:gap-3">
      <div className="flex min-w-0 items-center gap-2 text-sm">
        <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${g.connected ? "bg-green-500" : "bg-gray-400"}`} />
        {g.connected ? (
          <span className="truncate">
            Đã kết nối{g.email ? <> — <b>{g.email}</b></> : " Google"}
          </span>
        ) : (
          <span className="text-muted">Chưa kết nối Google</span>
        )}
      </div>
      {g.connected ? (
        <button onClick={g.disconnect}
          className="shrink-0 rounded-md border px-3 py-1.5 text-sm hover:bg-black/5 dark:hover:bg-white/5">
          Ngắt
        </button>
      ) : (
        <button onClick={g.connect} disabled={g.loading || g.connecting}
          className="shrink-0 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
          {g.connecting ? "Đang mở…" : "Kết nối Google"}
        </button>
      )}
    </div>
  );
}

function ModeTabs({ mode, onChange }: { mode: Mode; onChange: (m: Mode) => void }) {
  return (
    <div className="mt-3 flex gap-1 rounded-xl border bg-card p-1 shadow-sm sm:mt-4">
      {MODES.map((m) => (
        <button
          key={m.id}
          type="button"
          onClick={() => onChange(m.id)}
          className={`flex-1 rounded-lg px-3 py-2 text-sm font-medium transition ${
            mode === m.id
              ? "bg-blue-600 text-white"
              : "text-muted hover:bg-black/5 dark:hover:bg-white/5"
          }`}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}

function Stepper({ phase }: { phase: Phase }) {
  const order: Phase[] = ["resolve", "fetch", "write", "done"];
  const current = order.indexOf(phase === "error" ? "done" : phase);
  return (
    <div className="flex items-center gap-1.5 sm:gap-2">
      {STEPS.map((s, i) => {
        const done = phase === "done" || current > i;
        const active = current === i && phase !== "done" && phase !== "error";
        const failed = phase === "error" && current === i;
        return (
          <div key={s.key} className="flex flex-1 items-center gap-1.5 sm:gap-2">
            <div
              className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-xs font-medium ${
                failed
                  ? "border-red-400 bg-red-50 text-red-600 dark:bg-red-950/40"
                  : done
                    ? "border-green-500 bg-green-500 text-white"
                    : active
                      ? "border-blue-500 text-blue-600"
                      : "border-border text-muted"
              }`}
            >
              {done ? "✓" : active ? (
                <span className="h-3 w-3 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />
              ) : (
                i + 1
              )}
            </div>
            <span className={`truncate text-xs ${active || done ? "" : "text-muted"}`}>{s.label}</span>
            {i < STEPS.length - 1 && <div className="h-px flex-1 bg-border" />}
          </div>
        );
      })}
    </div>
  );
}

function ResultPanel({ result }: { result: RunResult }) {
  return (
    <section className="mt-4 rounded-2xl border bg-card p-4 shadow-sm sm:mt-5 sm:p-5">
      <h2 className="mb-3 text-base font-semibold">Kết quả</h2>
      <div className="mb-4 grid grid-cols-2 gap-2.5 sm:grid-cols-4 sm:gap-3">
        <Stat label="Kênh" value={result.channelTitle || "—"} />
        <Stat label="Quét (trong ngày)" value={String(result.scanned)} />
        <Stat label="Đạt điều kiện" value={String(result.matched)} />
        <Stat
          label="Đã ghi (tab)"
          value={`${result.wrote} mới${result.updated ? ` · ${result.updated} cập nhật` : ""}${result.tab ? ` · ${result.tab}` : ""}`}
        />
      </div>

      {result.preview.length > 0 ? (
        <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
          <table className="w-full text-left text-sm">
            <thead className="text-muted">
              <tr className="border-b">
                <th className="py-2 pr-3">Tiêu đề</th>
                <th className="py-2 pr-3">T.lượng</th>
                <th className="py-2 pr-3 text-right">Views</th>
                <th className="hidden py-2 pr-3 text-right sm:table-cell">Eng.%</th>
                <th className="hidden py-2 pr-3 text-right sm:table-cell">V/ngày</th>
                <th className="py-2 whitespace-nowrap">Đăng</th>
              </tr>
            </thead>
            <tbody>
              {result.preview.map((v) => (
                <tr key={v.videoId} className="border-b border-border/60">
                  <td className="max-w-[46vw] truncate py-2 pr-3 sm:max-w-xs">
                    <a href={v.url} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline">
                      {v.title}
                    </a>
                  </td>
                  <td className="py-2 pr-3 tabular-nums text-muted">{v.durationLabel}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{v.viewsLabel}</td>
                  <td className="hidden py-2 pr-3 text-right tabular-nums text-muted sm:table-cell">
                    {v.engagementRate}
                  </td>
                  <td className="hidden py-2 pr-3 text-right tabular-nums text-muted sm:table-cell">
                    {v.viewsPerDay.toLocaleString()}
                  </td>
                  <td className="py-2 whitespace-nowrap text-muted">{v.publishedRelative}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {result.matched > result.preview.length && (
            <p className="mt-2 text-xs text-muted">
              Hiển thị {result.preview.length}/{result.matched} — toàn bộ đã ghi vào sheet.
            </p>
          )}
        </div>
      ) : (
        <p className="text-sm text-muted">Không có video nào đạt điều kiện.</p>
      )}
    </section>
  );
}
