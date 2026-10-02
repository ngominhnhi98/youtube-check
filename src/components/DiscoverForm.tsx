"use client";

import { useEffect, useMemo, useState } from "react";
import { Field, Section, Stat, input } from "@/components/ui";
import { MARKETS } from "@/lib/markets";

interface SearchQuery {
  q: string;
  lang: string;
  note: string;
  region?: string;
}

interface ChannelRow {
  channelId: string;
  title: string;
  url: string;
  description: string;
  thumbnail: string;
  country: string;
  createdAt: string;
  subscribers: number;
  subscribersHidden: boolean;
  subscribersLabel: string;
  totalViews: number;
  totalViewsLabel: string;
  videoCount: number;
  avgViews: number;
  avgViewsLabel: string;
  viewsPerSub: number;
  matchCount: number;
  matchedQueries: string[];
  sampleTitle: string;
  sampleUrl: string;
  sampleDurationLabel: string;
  latestUploadAt: string;
  latestUploadRelative: string;
  latestUploadDays: number;
  avgDurationSec: number;
  avgDurationLabel: string;
  longRatio: number;
  recentSampled: number;
  isVietnamese: boolean;
}

interface DiscoverResult {
  channels: ChannelRow[];
  videosScanned: number;
  channelsFound: number;
  channelsAfterFilter: number;
  vietnameseDropped: number;
  matchDurationDropped: number;
  inspected: number;
  shortFormDropped: number;
  quotaSpent: number;
  keyCount: number;
  queriesUsed: number;
}

type SortKey =
  | "viewsPerSub"
  | "subscribers"
  | "avgViews"
  | "totalViews"
  | "videoCount"
  | "matchCount"
  | "avgDurationSec"
  | "longRatio"
  | "latestUploadDays";

const COLUMNS: { key: SortKey; label: string; hint: string }[] = [
  { key: "subscribers", label: "Sub", hint: "Số người đăng ký" },
  { key: "avgViews", label: "View TB", hint: "Tổng view / số video" },
  { key: "viewsPerSub", label: "View/Sub", hint: "View TB chia số sub — càng cao càng tiềm năng" },
  { key: "totalViews", label: "Tổng view", hint: "Tổng view toàn kênh" },
  { key: "videoCount", label: "Video", hint: "Số video công khai" },
  {
    key: "avgDurationSec",
    label: "T.lượng TB",
    hint: "Thời lượng trung bình 10 video gần nhất",
  },
  { key: "longRatio", label: "% dài", hint: "Tỉ lệ video dài trong 10 video gần nhất" },
  { key: "matchCount", label: "Khớp", hint: "Số video khớp truy vấn" },
  { key: "latestUploadDays", label: "Đăng gần nhất", hint: "Ngày kể từ video mới nhất" },
];

const DURATION_OPTIONS = [
  { id: "long", label: "Dài (> 20 phút)" },
  { id: "medium", label: "Vừa (4–20 phút)" },
  { id: "short", label: "Ngắn (< 4 phút, Shorts)" },
  { id: "any", label: "Tất cả" },
];

const cleanInt = (v: string) => v.replace(/[^\d]/g, "").replace(/^0+(?=\d)/, "");
const toNum = (s: string) => (s.trim() === "" ? 0 : Number(s) || 0);
const onInt =
  (set: (v: string) => void) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = cleanInt(e.target.value);
    e.target.value = v;
    set(v);
  };

export default function DiscoverForm({ canEdit }: { canEdit: boolean }) {
  const [keyword, setKeyword] = useState("");
  /** Bật = Gemini sinh truy vấn từ một chủ đề. Tắt = ô trên ĐÃ LÀ danh sách truy
   *  vấn do người dùng tự soạn, ngăn cách bằng dấu phẩy — không gọi Gemini nữa. */
  const [autoKeyword, setAutoKeyword] = useState(true);
  const [includeVietnam, setIncludeVietnam] = useState(false);
  /** Thị trường Gemini phải viết truy vấn cho. Rỗng = Gemini tự chọn. */
  const [markets, setMarkets] = useState<string[]>([]);
  const [queryCount, setQueryCount] = useState("10");
  const [pagesPerQuery, setPagesPerQuery] = useState("1");
  const [order, setOrder] = useState("viewCount");
  // Mặc định Dài + Vừa = mọi thứ trừ Shorts. Mỗi độ dài là một lượt search riêng
  // nên đây cũng là chỗ quyết định quota (xem `quotaEstimate`).
  const [durations, setDurations] = useState<string[]>(["long", "medium"]);
  const [longFormOnly, setLongFormOnly] = useState(true);
  const [longMinMinutes, setLongMinMinutes] = useState("4");
  const [longRatioMin, setLongRatioMin] = useState("60");
  const [publishedWithinDays, setPublishedWithinDays] = useState("0");
  const [matchMinMinutes, setMatchMinMinutes] = useState("0");
  const [matchMaxMinutes, setMatchMaxMinutes] = useState("0");

  const [maxSubs, setMaxSubs] = useState("0");
  const [minSubs, setMinSubs] = useState("0");
  const [minAvgViews, setMinAvgViews] = useState("0");
  // Mặc định 10: kênh mới có 1–3 video hay lọt lên đầu bảng vì View/Sub bị thổi
  // phồng (12M view / 1 video), trong khi đó là kênh viral một lần chứ không phải
  // kênh làm nội dung đều.
  const [minVideos, setMinVideos] = useState("10");

  const [queries, setQueries] = useState<SearchQuery[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [extraQuery, setExtraQuery] = useState("");

  const [genLoading, setGenLoading] = useState(false);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<DiscoverResult | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const [sortKey, setSortKey] = useState<SortKey>("viewsPerSub");
  const [sortAsc, setSortAsc] = useState(false);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  const visibleMarkets = MARKETS.filter((m) => includeVietnam || m.id !== "vi");
  const activeMarkets = markets.filter((id) => includeVietnam || id !== "vi");

  const busy = genLoading || searching;
  const disabled = !canEdit || busy;

  // Chế độ thủ công: tách ngay khi gõ để chip + ước tính quota cập nhật theo.
  // Route chỉ nhận tối đa 20 truy vấn nên cắt luôn ở đây cho khớp.
  const manualQueries: SearchQuery[] = useMemo(() => {
    if (autoKeyword) return [];
    const seen = new Set<string>();
    return keyword
      .split(",")
      .map((x) => x.trim())
      .filter((x) => {
        if (!x || seen.has(x.toLowerCase())) return false;
        seen.add(x.toLowerCase());
        return true;
      })
      .slice(0, 20)
      .map((q) => ({ q, lang: "", note: "tự nhập" }));
  }, [autoKeyword, keyword]);

  const activeQueries = autoKeyword
    ? (queries ?? []).filter((q) => picked.has(q.q))
    : manualQueries;
  const durationCount = Math.max(1, durations.length);
  const searchCalls =
    activeQueries.length * Math.max(1, toNum(pagesPerQuery)) * durationCount;
  const quotaEstimate = searchCalls * 100 + 250;

  async function generate() {
    if (busy || !autoKeyword) return;
    if (!keyword.trim()) {
      setError("Nhập từ khoá chủ đề trước.");
      return;
    }
    setError(null);
    setResult(null);
    setGenLoading(true);
    try {
      const res = await fetch("/api/keywords", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          keyword: keyword.trim(),
          includeVietnam,
          count: toNum(queryCount) || 10,
          markets: activeMarkets,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Không tạo được từ khoá.");
        return;
      }
      setQueries(data.queries);
      setPicked(new Set((data.queries as SearchQuery[]).map((q) => q.q)));
      setToast(`Gemini đã sinh ${data.queries.length} truy vấn — bỏ chọn cái nào lệch chủ đề.`);
    } catch {
      setError("Lỗi kết nối.");
    } finally {
      setGenLoading(false);
    }
  }

  async function search() {
    if (busy) return;
    if (activeQueries.length === 0) {
      setError(
        autoKeyword
          ? "Chọn ít nhất một truy vấn."
          : "Nhập ít nhất một từ khoá (nhiều từ khoá cách nhau bởi dấu phẩy)."
      );
      return;
    }
    if (durations.length === 0) {
      setError("Chọn ít nhất một độ dài video.");
      return;
    }
    if (toNum(matchMaxMinutes) > 0 && toNum(matchMinMinutes) > toNum(matchMaxMinutes)) {
      setError("Thời lượng video khớp: tối thiểu phải ≤ tối đa.");
      return;
    }
    setError(null);
    setResult(null);
    setSearching(true);
    try {
      const res = await fetch("/api/discover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          queries: activeQueries,
          includeVietnam,
          pagesPerQuery: toNum(pagesPerQuery) || 1,
          maxSubs: toNum(maxSubs),
          minSubs: toNum(minSubs),
          minAvgViews: toNum(minAvgViews),
          minVideos: toNum(minVideos),
          publishedWithinDays: toNum(publishedWithinDays),
          matchMinMinutes: toNum(matchMinMinutes),
          matchMaxMinutes: toNum(matchMaxMinutes),
          videoDurations: durations,
          order,
          longFormOnly,
          longMinMinutes: toNum(longMinMinutes) || 4,
          longRatioMin: toNum(longRatioMin),
          limit: 150,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? (data.errors ? data.errors.join(" ") : "Thất bại"));
        return;
      }
      setResult(data);
      setToast(
        data.channels.length === 0
          ? "Không có kênh nào đạt điều kiện — nới bộ lọc hoặc đổi truy vấn."
          : `Tìm thấy ${data.channelsAfterFilter} kênh đạt điều kiện (tốn ${data.quotaSpent} units).`
      );
    } catch {
      setError("Lỗi kết nối.");
    } finally {
      setSearching(false);
    }
  }

  function toggleDuration(id: string) {
    setDurations((prev) => {
      // "Tất cả" đã bao trùm 3 mục kia nên không trộn lẫn được — chọn nó là thay
      // cả nhóm, và chọn mục khác thì nó tự nhường chỗ.
      if (id === "any") return prev.includes("any") ? [] : ["any"];
      const rest = prev.filter((x) => x !== "any");
      const next = rest.includes(id) ? rest.filter((x) => x !== id) : [...rest, id];
      return next;
    });
  }

  function toggleMarket(id: string) {
    setMarkets((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  function toggleQuery(q: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(q)) next.delete(q);
      else next.add(q);
      return next;
    });
  }

  function addQuery(e: React.FormEvent) {
    e.preventDefault();
    const q = extraQuery.trim();
    if (!q) return;
    setQueries((prev) => {
      const list = prev ?? [];
      if (list.some((x) => x.q.toLowerCase() === q.toLowerCase())) return list;
      return [...list, { q, lang: "", note: "thêm tay" }];
    });
    setPicked((prev) => new Set(prev).add(q));
    setExtraQuery("");
  }

  const sorted = useMemo(() => {
    if (!result) return [];
    const rows = [...result.channels];
    rows.sort((a, b) => {
      // "Đăng gần nhất" đo bằng số ngày → nhỏ hơn = mới hơn = tốt hơn, nên đảo
      // chiều để lần bấm đầu tiên luôn cho ra thứ tự "tốt nhất trước".
      const flip = sortKey === "latestUploadDays" ? -1 : 1;
      const av = a[sortKey];
      const bv = b[sortKey];
      // Kênh chưa lấy được ngày đăng (-1) luôn xuống cuối.
      if (sortKey === "latestUploadDays") {
        if (av < 0 && bv < 0) return 0;
        if (av < 0) return 1;
        if (bv < 0) return -1;
      }
      return (sortAsc ? 1 : -1) * flip * (av - bv);
    });
    return rows;
  }, [result, sortKey, sortAsc]);

  function sortBy(key: SortKey) {
    if (key === sortKey) setSortAsc((v) => !v);
    else {
      setSortKey(key);
      setSortAsc(false);
    }
  }

  return (
    <>
      <div className="mt-3 space-y-5 rounded-2xl border bg-card p-4 shadow-sm sm:mt-4 sm:p-5">
        <Section title="Chủ đề">
          <Field
            label={autoKeyword ? "Từ khoá" : "Danh sách từ khoá"}
            hint={
              autoKeyword
                ? "mô tả nội dung kênh bạn muốn tìm"
                : "cách nhau bởi dấu phẩy · tối đa 20"
            }
          >
            {autoKeyword ? (
              <input
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    generate();
                  }
                }}
                placeholder="Vd: review phim one punch man"
                className={input}
                disabled={disabled}
              />
            ) : (
              // Textarea vì danh sách tự nhập thường dài hơn một dòng.
              <textarea
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                rows={3}
                placeholder="Vd: one punch man review, 원펀맨 리뷰, ワンパンマン 解説, 一拳超人 解析"
                className={`${input} resize-y`}
                disabled={disabled}
              />
            )}
          </Field>

          <label className="flex cursor-pointer items-start gap-2 rounded-lg border bg-background px-3 py-2.5 text-sm">
            <input
              type="checkbox"
              checked={autoKeyword}
              onChange={(e) => setAutoKeyword(e.target.checked)}
              disabled={disabled}
              className="mt-0.5 h-4 w-4"
            />
            <span>
              Tự tạo từ khoá bằng AI (Gemini)
              <span className="mt-0.5 block text-xs text-muted">
                {autoKeyword
                  ? "Nhập một chủ đề, Gemini sẽ sinh ra nhiều truy vấn tìm kiếm đa ngôn ngữ."
                  : "Đang TẮT — ô trên chính là danh sách truy vấn của bạn, ngăn cách bằng dấu phẩy. Không gọi Gemini, bấm “Tìm kênh” là quét YouTube luôn."}
              </span>
            </span>
          </label>

          <label className="flex cursor-pointer items-start gap-2 rounded-lg border bg-background px-3 py-2.5 text-sm">
            <input
              type="checkbox"
              checked={includeVietnam}
              onChange={(e) => setIncludeVietnam(e.target.checked)}
              disabled={disabled}
              className="mt-0.5 h-4 w-4"
            />
            <span>
              Bao gồm cả kênh Việt Nam
              <span className="mt-0.5 block text-xs text-muted">
                {includeVietnam
                  ? "Không loại kênh Việt." +
                    (autoKeyword ? " Gemini sinh thêm cả truy vấn tiếng Việt." : "")
                  : "Mặc định: chỉ tìm kênh nước ngoài — kênh có nội dung/tên tiếng Việt hoặc quốc gia VN sẽ bị loại." +
                    (autoKeyword ? " Gemini cũng không sinh truy vấn tiếng Việt." : "")}
              </span>
            </span>
          </label>

          {autoKeyword && (
            <div>
              <span className="mb-1 flex items-baseline justify-between gap-1.5">
                <span className="text-sm font-medium">
                  Quốc gia / ngôn ngữ
                  {activeMarkets.length > 0 && (
                    <span className="ml-1.5 text-xs font-normal text-muted">
                      ({activeMarkets.length} đã chọn)
                    </span>
                  )}
                </span>
                {activeMarkets.length > 0 ? (
                  <button
                    type="button"
                    onClick={() => setMarkets([])}
                    disabled={disabled}
                    className="text-[11px] text-blue-600 hover:underline disabled:opacity-50 dark:text-blue-300"
                  >
                    Bỏ chọn hết
                  </button>
                ) : (
                  <span className="text-[11px] text-muted">không chọn = Gemini tự chọn</span>
                )}
              </span>
              <div className="flex flex-wrap gap-2">
                {visibleMarkets.map((m) => {
                  const on = markets.includes(m.id);
                  return (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => toggleMarket(m.id)}
                      disabled={disabled}
                      className={`rounded-full border px-3 py-1.5 text-xs transition ${
                        on
                          ? "border-blue-500 bg-blue-500/10 text-blue-600 dark:text-blue-300"
                          : "text-muted hover:bg-black/5 dark:hover:bg-white/5"
                      }`}
                    >
                      {m.label}
                    </button>
                  );
                })}
              </div>
              <p className="mt-1.5 text-xs text-muted">
                Gemini chỉ viết truy vấn bằng ngôn ngữ của các thị trường đã chọn, chia đều
                cho mỗi nơi (ít nhất 1 truy vấn/nơi). Khi tìm, mỗi truy vấn được gắn ngôn ngữ
                + quốc gia của nó để YouTube ưu tiên kết quả ở đó.
              </p>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 sm:gap-4">
            {/* Số truy vấn chỉ có nghĩa khi Gemini là bên sinh ra chúng. */}
            {autoKeyword && (
              <Field label="Số truy vấn" hint="3–20">
                <input
                  value={queryCount}
                  onChange={onInt(setQueryCount)}
                  className={input}
                  disabled={disabled}
                  inputMode="numeric"
                />
              </Field>
            )}
            <Field label="Trang/truy vấn" hint="1–3 · 50 video/trang">
              <input
                value={pagesPerQuery}
                onChange={onInt(setPagesPerQuery)}
                className={input}
                disabled={disabled}
                inputMode="numeric"
              />
            </Field>
            <Field label="Sắp xếp nguồn">
              <select
                value={order}
                onChange={(e) => setOrder(e.target.value)}
                className={input}
                disabled={disabled}
              >
                <option value="viewCount">Nhiều view nhất</option>
                <option value="relevance">Liên quan nhất</option>
                <option value="date">Mới nhất</option>
              </select>
            </Field>
          </div>

          <div>
            <span className="mb-1 flex items-baseline justify-between gap-1.5">
              <span className="text-sm font-medium">Độ dài video khi tìm</span>
              <span className="text-[11px] text-muted">
                mỗi mục = 1 lượt search riêng
              </span>
            </span>
            <div className="flex flex-wrap gap-2">
              {DURATION_OPTIONS.map((d) => {
                const on = durations.includes(d.id);
                return (
                  <button
                    key={d.id}
                    type="button"
                    onClick={() => toggleDuration(d.id)}
                    disabled={disabled}
                    className={`rounded-full border px-3 py-1.5 text-xs transition ${
                      on
                        ? "border-blue-500 bg-blue-500/10 text-blue-600 dark:text-blue-300"
                        : "text-muted hover:bg-black/5 dark:hover:bg-white/5"
                    }`}
                  >
                    {on ? "✓ " : "+ "}
                    {d.label}
                  </button>
                );
              })}
            </div>
            <p className="mt-1.5 text-xs text-muted">
              YouTube chỉ nhận một độ dài mỗi lần gọi, nên chọn 2 mục là quét 2 lượt và
              tốn gấp đôi quota. Mặc định <b>Dài + Vừa</b> = mọi thứ trừ Shorts.
            </p>
          </div>

          {autoKeyword && (
            <button
              type="button"
              onClick={generate}
              disabled={disabled}
              className="w-full rounded-lg border border-blue-500 bg-blue-500/10 px-4 py-2.5 text-sm font-semibold text-blue-600 transition hover:bg-blue-500/20 disabled:opacity-50 dark:text-blue-300"
            >
              {genLoading ? "Gemini đang nghĩ…" : "① ✨ Tạo từ khoá tìm kiếm bằng AI"}
            </button>
          )}
        </Section>

        {/* Chế độ thủ công: soi lại đúng những gì sẽ được gửi đi, để dấu phẩy
            thừa hay từ khoá trùng lộ ra trước khi tiêu 100 units/truy vấn. */}
        {!autoKeyword && manualQueries.length > 0 && (
          <Section title={`Sẽ tìm với ${manualQueries.length} truy vấn`}>
            <div className="flex flex-wrap gap-2">
              {manualQueries.map((q) => (
                <span
                  key={q.q}
                  className="rounded-full border border-blue-500 bg-blue-500/10 px-3 py-1.5 text-xs text-blue-600 dark:text-blue-300"
                >
                  {q.q}
                </span>
              ))}
            </div>
          </Section>
        )}

        {autoKeyword && queries && (
          <Section title={`Truy vấn Gemini sinh (${activeQueries.length}/${queries.length} đang chọn)`}>
            <div className="flex flex-wrap gap-2">
              {queries.map((q) => {
                const on = picked.has(q.q);
                return (
                  <button
                    key={q.q}
                    type="button"
                    onClick={() => toggleQuery(q.q)}
                    disabled={disabled}
                    title={q.note}
                    className={`rounded-full border px-3 py-1.5 text-xs transition ${
                      on
                        ? "border-blue-500 bg-blue-500/10 text-blue-600 dark:text-blue-300"
                        : "text-muted line-through hover:bg-black/5 dark:hover:bg-white/5"
                    }`}
                  >
                    {on ? "✓ " : "+ "}
                    {q.q}
                    {q.lang && (
                      <span className="ml-1 opacity-60">
                        ·{q.lang}
                        {q.region ? `·${q.region}` : ""}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            <form onSubmit={addQuery} className="flex gap-2">
              <input
                value={extraQuery}
                onChange={(e) => setExtraQuery(e.target.value)}
                placeholder="Thêm truy vấn thủ công…"
                className={input}
                disabled={disabled}
              />
              <button
                type="submit"
                disabled={disabled}
                className="shrink-0 rounded-lg border px-3 py-2 text-sm hover:bg-black/5 disabled:opacity-50 dark:hover:bg-white/5"
              >
                Thêm
              </button>
            </form>
          </Section>
        )}

        <Section title="Bộ lọc kênh">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 sm:gap-4">
            <Field label="Sub tối đa" hint="0 = bỏ">
              <input
                value={maxSubs}
                onChange={onInt(setMaxSubs)}
                placeholder="Vd: 100000"
                className={input}
                disabled={disabled}
                inputMode="numeric"
              />
            </Field>
            <Field label="Sub tối thiểu" hint="0 = bỏ">
              <input
                value={minSubs}
                onChange={onInt(setMinSubs)}
                className={input}
                disabled={disabled}
                inputMode="numeric"
              />
            </Field>
            <Field label="View TB tối thiểu" hint="0 = bỏ">
              <input
                value={minAvgViews}
                onChange={onInt(setMinAvgViews)}
                placeholder="Vd: 10000"
                className={input}
                disabled={disabled}
                inputMode="numeric"
              />
            </Field>
            <Field label="Số video tối thiểu" hint="lọc kênh viral 1 video">
              <input
                value={minVideos}
                onChange={onInt(setMinVideos)}
                className={input}
                disabled={disabled}
                inputMode="numeric"
              />
            </Field>
          </div>
          <label className="flex cursor-pointer items-start gap-2 rounded-lg border bg-background px-3 py-2.5 text-sm">
            <input
              type="checkbox"
              checked={longFormOnly}
              onChange={(e) => setLongFormOnly(e.target.checked)}
              disabled={disabled}
              className="mt-0.5 h-4 w-4"
            />
            <span>
              Chỉ kênh đăng video dài
              <span className="mt-0.5 block text-xs text-muted">
                Soi 10 video gần nhất của từng kênh và loại kênh chủ yếu đăng Shorts —
                lọc ở ô trên chỉ lọc VIDEO tìm được, không nói lên kênh đó thường đăng gì.
              </span>
            </span>
          </label>

          {longFormOnly && (
            <div className="grid grid-cols-2 gap-3 sm:gap-4">
              <Field label="Video dài ≥ phút" hint="Shorts tối đa 3 phút">
                <input
                  value={longMinMinutes}
                  onChange={onInt(setLongMinMinutes)}
                  className={input}
                  disabled={disabled}
                  inputMode="numeric"
                />
              </Field>
              <Field label="Tỉ lệ video dài ≥ %" hint="trong 10 video gần nhất">
                <input
                  value={longRatioMin}
                  onChange={onInt(setLongRatioMin)}
                  className={input}
                  disabled={disabled}
                  inputMode="numeric"
                />
              </Field>
            </div>
          )}

          <div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4">
              <Field label="Video khớp ≥ phút" hint="0 = bỏ">
                <input
                  value={matchMinMinutes}
                  onChange={onInt(setMatchMinMinutes)}
                  className={input}
                  disabled={disabled}
                  inputMode="numeric"
                />
              </Field>
              <Field label="Video khớp ≤ phút" hint="0 = bỏ">
                <input
                  value={matchMaxMinutes}
                  onChange={onInt(setMatchMaxMinutes)}
                  className={input}
                  disabled={disabled}
                  inputMode="numeric"
                />
              </Field>
              <div className="col-span-2 sm:col-span-1">
                <Field label="Video khớp đăng trong N ngày" hint="0 = bỏ">
                  <input
                    value={publishedWithinDays}
                    onChange={onInt(setPublishedWithinDays)}
                    className={input}
                    disabled={disabled}
                    inputMode="numeric"
                  />
                </Field>
              </div>
            </div>
            <p className="mt-1.5 text-xs text-muted">
              Lọc trên chính các video tìm được (không phải video gần nhất của kênh). Kênh
              không còn video khớp nào trong khoảng thời lượng sẽ bị loại. Bật lọc này tốn
              thêm ~1 unit / 50 video.
            </p>
          </div>
        </Section>

        {error && (
          <p className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
            {error}
          </p>
        )}

        <div className="space-y-2">
          <button
            type="button"
            onClick={search}
            disabled={disabled || activeQueries.length === 0}
            className="w-full rounded-lg bg-blue-600 px-4 py-3 text-sm font-semibold text-white transition hover:bg-blue-700 active:scale-[0.99] disabled:opacity-50"
          >
            {searching
              ? "Đang quét YouTube…"
              : autoKeyword
                ? "② 🔍 Tìm kênh"
                : "🔍 Tìm kênh"}
          </button>
          {searchCalls > 30 && (
            <p className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-700/50 dark:bg-amber-950/30 dark:text-amber-200">
              {searchCalls} lượt search — cấu hình này có thể chạy quá 60 giây và bị Vercel
              cắt giữa chừng (10 truy vấn × 1 trang × 2 độ dài mất ~27s). Bớt truy vấn,
              bớt trang hoặc bớt độ dài.
            </p>
          )}
          {activeQueries.length > 0 && (
            <p className="text-center text-xs text-muted">
              Ước tính tốn ~{quotaEstimate.toLocaleString()} units quota
              {" "}({activeQueries.length} truy vấn × {Math.max(1, toNum(pagesPerQuery))} trang
              {durationCount > 1 ? ` × ${durationCount} độ dài` : ""} × 100)
            </p>
          )}
        </div>
      </div>

      {result && (
        <section className="mt-4 rounded-2xl border bg-card p-4 shadow-sm sm:mt-5 sm:p-5">
          <h2 className="mb-3 text-base font-semibold">Kết quả</h2>
          <div className="mb-4 grid grid-cols-2 gap-2.5 sm:grid-cols-4 sm:gap-3">
            <Stat label="Video đã quét" value={result.videosScanned.toLocaleString()} />
            <Stat label="Kênh tìm được" value={result.channelsFound.toLocaleString()} />
            <Stat
              label="Đạt điều kiện"
              value={`${sorted.length.toLocaleString()}${
                result.shortFormDropped ? ` · bỏ ${result.shortFormDropped} kênh Shorts` : ""
              }${
                result.matchDurationDropped
                  ? ` · bỏ ${result.matchDurationDropped} kênh ngoài khoảng thời lượng`
                  : ""
              }${result.vietnameseDropped ? ` · bỏ ${result.vietnameseDropped} kênh VN` : ""}`}
            />
            <Stat label="Quota đã tiêu" value={`${result.quotaSpent.toLocaleString()} units`} />
          </div>

          {sorted.length > 0 ? (
            <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
              <table className="w-full text-left text-sm">
                <thead className="text-muted">
                  <tr className="border-b">
                    <th className="py-2 pr-3">Kênh</th>
                    {COLUMNS.map((c) => (
                      <th
                        key={c.key}
                        title={c.hint}
                        onClick={() => sortBy(c.key)}
                        className="cursor-pointer py-2 pr-3 text-right whitespace-nowrap select-none hover:text-foreground"
                      >
                        {c.label}
                        {sortKey === c.key && (sortAsc ? " ▲" : " ▼")}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((c) => (
                    <tr key={c.channelId} className="border-b border-border/60">
                      <td className="max-w-[46vw] py-2 pr-3 sm:max-w-xs">
                        <a
                          href={c.url}
                          target="_blank"
                          rel="noreferrer"
                          className="block truncate text-blue-600 hover:underline"
                          title={c.title}
                        >
                          {c.title}
                        </a>
                        <span className="block truncate text-xs text-muted" title={c.sampleTitle}>
                          {c.country && `${c.country} · `}
                          {c.sampleDurationLabel && `[${c.sampleDurationLabel}] `}
                          {c.sampleUrl ? (
                            <a href={c.sampleUrl} target="_blank" rel="noreferrer" className="hover:underline">
                              {c.sampleTitle}
                            </a>
                          ) : (
                            c.sampleTitle
                          )}
                        </span>
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">{c.subscribersLabel}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{c.avgViewsLabel}</td>
                      <td className="py-2 pr-3 text-right font-medium tabular-nums">
                        {c.viewsPerSub > 0 ? `${c.viewsPerSub}×` : "—"}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums text-muted">
                        {c.totalViewsLabel}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums text-muted">
                        {c.videoCount.toLocaleString()}
                      </td>
                      <td
                        className="py-2 pr-3 text-right tabular-nums whitespace-nowrap"
                        title={c.recentSampled ? `đo trên ${c.recentSampled} video gần nhất` : ""}
                      >
                        {c.recentSampled ? c.avgDurationLabel : "—"}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums text-muted">
                        {c.recentSampled ? `${c.longRatio}%` : "—"}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums text-muted">
                        {c.matchCount}
                      </td>
                      <td className="py-2 pr-3 text-right whitespace-nowrap text-muted">
                        {c.latestUploadRelative || "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-2 text-xs text-muted">
                Bấm tiêu đề cột để sắp xếp. <b>View/Sub</b> = view trung bình mỗi video chia số
                sub — càng cao thì kênh càng &ldquo;ít sub mà nhiều view&rdquo;.
                {" "}
                <b>T.lượng TB</b> và <b>% dài</b> đo trên 10 video gần nhất của kênh, không
                phải toàn bộ kênh.
                {result.channelsAfterFilter > result.inspected &&
                  ` Đã soi ${result.inspected}/${result.channelsAfterFilter} kênh đứng đầu bảng — phần còn lại bị bỏ vì chưa có dữ liệu thời lượng.`}
              </p>
            </div>
          ) : (
            <p className="text-sm text-muted">Không có kênh nào đạt điều kiện.</p>
          )}
        </section>
      )}

      {toast && (
        <div className="fixed inset-x-3 bottom-4 z-50 mx-auto max-w-md rounded-lg border bg-card px-4 py-2.5 text-center text-sm shadow-lg sm:inset-x-0">
          {toast}
        </div>
      )}
    </>
  );
}
