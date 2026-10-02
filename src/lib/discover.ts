/**
 * Tìm KÊNH theo chủ đề: Gemini sinh truy vấn → YouTube tìm VIDEO → gom kênh.
 *
 * Vì sao đi đường vòng qua video chứ không `search.list&type=channel`: tìm theo
 * kênh chỉ khớp tên/mô tả kênh nên vừa ít vừa lệch, trong khi kênh làm đúng chủ
 * đề thì chắc chắn có video đúng chủ đề. Cùng giá 100 units/lần gọi.
 *
 * Quota (units): search = 100/trang/độ-dài · channels.list = 1/lô 50 kênh ·
 * playlistItems = 1/kênh soi · videos.list = 1/lô 50 video gần nhất.
 */

import { generateJson } from "@/lib/gemini";
import { MARKET_BY_ID, type Market } from "@/lib/markets";
import {
  YouTubeClient,
  formatDuration,
  formatViews,
  parseIsoDuration,
  relativeVi,
  type PoolKey,
} from "@/lib/youtube";

// ── Nhận diện nội dung tiếng Việt ───────────────────────────────────────────

/**
 * Ký tự CHỈ tiếng Việt mới có. Cố tình bỏ à/á/è/é/ì/í/ò/ó/ù/ú vì tiếng Pháp,
 * Tây Ban Nha, Ý, Bồ… cũng dùng — vơ cả vào thì kênh Tây Ban Nha bị đuổi oan.
 * Còn lại là dấu hỏi/ngã/nặng và ă â ê ô ơ ư đ: gần như độc quyền tiếng Việt.
 */
const VI_CHARS =
  /[ăâêôơưđĂÂÊÔƠƯĐảãạẢÃẠắằẳẵặấầẩẫậẻẽẹếềểễệỉĩịỏõọốồổỗộớờởỡợủũụứừửữựỷỹỵ]/;

/** Từ khoá tiếng Việt không dấu hay gặp trên tiêu đề/tên kênh. */
const VI_WORDS =
  /\b(vietsub|thuyet minh|thuyết minh|tieng viet|tiếng việt|long tieng|lồng tiếng|truyen tranh|truyện tranh|review phim|tap \d|tập \d)\b/i;

export function looksVietnamese(...texts: (string | undefined)[]): boolean {
  const s = texts.filter(Boolean).join(" ");
  if (!s) return false;
  // Một hai ký tự lạc lõng có thể là tên riêng; từ 2 ký tự trở lên mới chắc.
  const hits = (s.match(new RegExp(VI_CHARS, "g")) ?? []).length;
  return hits >= 2 || VI_WORDS.test(s);
}

// ── Bước 1: Gemini sinh truy vấn ────────────────────────────────────────────

export interface SearchQuery {
  q: string;
  lang: string; // mã ngôn ngữ, dùng cho relevanceLanguage
  note: string; // giải thích ngắn để người dùng biết vì sao có truy vấn này
  region?: string; // mã quốc gia 2 chữ cho regionCode, "" = không ghim nước
}

const QUERY_SCHEMA = {
  type: "object",
  properties: {
    queries: {
      type: "array",
      items: {
        type: "object",
        properties: {
          q: { type: "string" },
          lang: { type: "string" },
          note: { type: "string" },
        },
        required: ["q", "lang", "note"],
      },
    },
  },
  required: ["queries"],
};

export async function buildQueries(opts: {
  keyword: string;
  includeVietnam: boolean;
  count: number;
  /** Id trong MARKETS. Rỗng = để Gemini tự chọn ngôn ngữ như trước. */
  markets?: string[];
}): Promise<SearchQuery[]> {
  const { keyword, includeVietnam } = opts;
  const markets: Market[] = (opts.markets ?? [])
    .map((id) => MARKET_BY_ID.get(id))
    .filter((m): m is Market => Boolean(m))
    // Chưa tick "Bao gồm Việt Nam" mà vẫn chọn thị trường VN là mâu thuẫn — ô tick
    // thắng, vì nó là bộ lọc chặn ở đầu ra; để lọt thì truy vấn tiếng Việt ra kênh
    // Việt rồi lại bị chính bộ lọc đó vứt đi, phí 100 units mỗi truy vấn.
    .filter((m) => includeVietnam || m.id !== "vi");
  // Mỗi thị trường phải có ít nhất 1 truy vấn, không thì chọn mà như không.
  const count = Math.min(20, Math.max(opts.count, markets.length));

  const system =
    "Bạn là chuyên gia nghiên cứu kênh YouTube. Bạn sinh ra các truy vấn tìm kiếm " +
    "thực chiến — đúng cách người xem thật gõ vào ô tìm kiếm YouTube, không phải " +
    "câu văn mô tả. Truy vấn ngắn (2–6 từ), không dùng dấu ngoặc kép hay toán tử.";

  const langRule = markets.length
    ? `CHỈ viết truy vấn cho đúng các thị trường sau, chia đều số truy vấn giữa chúng ` +
      `(mỗi thị trường ít nhất 1): ` +
      markets.map((m) => `"${m.id}" = ${m.langName}`).join("; ") +
      `. Truy vấn của thị trường nào thì viết bằng ngôn ngữ của thị trường đó, đúng chữ ` +
      `viết bản địa, không phiên âm sang latin. Ghi id thị trường vào trường "market".`
    : includeVietnam
    ? "Trộn nhiều thị trường: tiếng Việt, tiếng Anh, và các ngôn ngữ khác phù hợp với chủ đề " +
      "(Hàn, Nhật, Trung phồn thể, Thái, Indonesia, Tây Ban Nha, Bồ Đào Nha, Ả Rập…)."
    : "TUYỆT ĐỐI KHÔNG sinh truy vấn tiếng Việt và không dùng bất kỳ từ tiếng Việt nào " +
      "(kể cả không dấu). Mục tiêu là tìm kênh NƯỚC NGOÀI. Hãy trải đều qua các ngôn " +
      "ngữ phù hợp với chủ đề: tiếng Anh, Hàn, Nhật, Trung, Thái, Indonesia, Tây Ban Nha, " +
      "Bồ Đào Nha, Ả Rập, Nga, Hindi… Dùng đúng chữ viết bản địa (한국어, 日本語, ไทย, العربية…), " +
      "không phiên âm sang latin.";

  const prompt = `Chủ đề người dùng muốn tìm kênh YouTube: "${keyword}"

Hãy sinh ĐÚNG ${count} truy vấn tìm kiếm YouTube để tìm ra các KÊNH làm nội dung này.

Quy tắc:
- Mỗi truy vấn nhắm một góc/biến thể khác nhau (tên gốc của tác phẩm, tên bản địa, biệt danh fan hay dùng, dạng nội dung như tóm tắt/giải thích/xếp hạng/phản ứng…). Không lặp ý.
- ${langRule}
- ${markets.length ? `"market" là id thị trường của truy vấn (một trong: ${markets.map((m) => m.id).join(", ")}). "lang" để trống cũng được.` : `"lang" là mã ISO-639-1 của ngôn ngữ truy vấn (en, ko, ja, zh, th, id, es, pt, ar, ru, hi, vi…).`}
- "note" viết bằng tiếng Việt, tối đa 8 từ, nói rõ truy vấn đó nhắm góc nào.

Trả JSON đúng schema.`;

  const schema = markets.length
    ? {
        ...QUERY_SCHEMA,
        properties: {
          queries: {
            type: "array",
            items: {
              type: "object",
              properties: {
                q: { type: "string" },
                market: { type: "string", enum: markets.map((m) => m.id) },
                note: { type: "string" },
              },
              required: ["q", "market", "note"],
            },
          },
        },
      }
    : QUERY_SCHEMA;

  const out = await generateJson<{ queries?: (SearchQuery & { market?: string })[] }>({
    prompt,
    system,
    schema,
  });

  const seen = new Set<string>();
  const queries: SearchQuery[] = [];
  for (const item of out.queries ?? []) {
    const q = (item?.q ?? "").trim();
    if (!q) continue;
    const key = q.toLowerCase();
    if (seen.has(key)) continue;
    // Có thị trường thì ngôn ngữ/quốc gia lấy từ bảng MARKETS, không tin chữ
    // model tự ghi — enum đã ép "market" nằm trong danh sách đã chọn.
    const market = item.market ? MARKET_BY_ID.get(item.market) : undefined;
    if (markets.length && !market) continue;
    const lang = market ? market.lang : (item.lang ?? "").trim().slice(0, 7);
    // Chốt chặn cuối: model đôi khi vẫn lọt một truy vấn tiếng Việt.
    if (!includeVietnam && (looksVietnamese(q) || lang.startsWith("vi"))) continue;
    seen.add(key);
    queries.push({
      q,
      lang,
      region: market?.region ?? "",
      note: (item.note ?? "").trim(),
    });
    if (queries.length >= count) break;
  }
  return queries;
}

// ── Bước 2: tìm video → gom kênh → lấy thống kê ─────────────────────────────

export interface ChannelRow {
  channelId: string;
  title: string;
  url: string;
  description: string;
  thumbnail: string;
  country: string;
  createdAt: string; // YYYY-MM-DD
  subscribers: number;
  subscribersHidden: boolean;
  subscribersLabel: string;
  totalViews: number;
  totalViewsLabel: string;
  videoCount: number;
  avgViews: number; // tổng view / số video
  avgViewsLabel: string;
  viewsPerSub: number; // avgViews / subscribers — "ít sub mà nhiều view"
  matchCount: number; // số video khớp truy vấn (độ liên quan chủ đề)
  matchedQueries: string[];
  sampleTitle: string;
  sampleUrl: string;
  sampleDurationLabel: string; // "" khi không bật lọc thời lượng video khớp
  latestUploadAt: string; // ISO, "" nếu không lấy
  latestUploadRelative: string;
  latestUploadDays: number; // -1 nếu không lấy
  /** Đo trên N video gần nhất, KHÔNG phải cả kênh — xem `recentSampled`. */
  avgDurationSec: number;
  avgDurationLabel: string;
  longRatio: number; // % video gần nhất đạt ngưỡng "dài"
  recentSampled: number; // số video đã soi (0 = chưa soi được)
  isVietnamese: boolean;
}

export interface DiscoverParams {
  queries: SearchQuery[];
  apiKeys: PoolKey[];
  includeVietnam: boolean;
  pagesPerQuery: number;
  /** 0 = bỏ qua bộ lọc. */
  maxSubs: number;
  minSubs: number;
  minAvgViews: number;
  minVideos: number;
  /** Chỉ lấy video đăng trong N ngày (0 = không giới hạn). */
  publishedWithinDays: number;
  /** Khoảng thời lượng của VIDEO KHỚP, giây. 0 = không giới hạn đầu đó. */
  matchMinSec: number;
  matchMaxSec: number;
  /**
   * Độ dài video ở NGUỒN tìm. YouTube chỉ nhận MỘT giá trị mỗi lần gọi, nên chọn
   * nhiều giá trị = chạy nhiều lượt search và nhân quota lên bấy nhiêu lần. Đây là
   * cách duy nhất để vừa lấy video 4–20 phút vừa lấy video >20 phút mà bỏ Shorts.
   */
  videoDurations: ("any" | "short" | "medium" | "long")[];
  order: "viewCount" | "relevance" | "date";
  /**
   * Số kênh đi soi video gần nhất (1 unit/kênh + 1 unit/50 video). Bước này vừa
   * cho ra "đăng gần nhất" vừa cho ra thời lượng thật — thứ duy nhất phân biệt
   * được kênh làm video dài với kênh chỉ đăng Shorts. 0 = bỏ qua.
   */
  inspectLimit: number;
  /** Chỉ giữ kênh mà phần lớn video gần nhất là video dài. */
  longFormOnly: boolean;
  /** Video được tính là "dài" khi ≥ số giây này. Shorts hiện tối đa 3 phút. */
  longMinSec: number;
  /** Tỉ lệ % video dài tối thiểu trong các video gần nhất. */
  longRatioMin: number;
  limit: number;
}

export interface DiscoverResult {
  channels: ChannelRow[];
  videosScanned: number;
  channelsFound: number;
  channelsAfterFilter: number;
  vietnameseDropped: number;
  /** Số kênh bị loại vì không còn video khớp nào trong khoảng thời lượng. */
  matchDurationDropped: number;
  /** Số kênh đã soi video gần nhất (trần `inspectLimit`). */
  inspected: number;
  /** Số kênh bị loại vì chủ yếu đăng Shorts / video ngắn. */
  shortFormDropped: number;
  usage: Record<string, number>;
  quotaSpent: number;
}

interface SearchItem {
  id?: { videoId?: string };
  snippet?: {
    channelId?: string;
    channelTitle?: string;
    title?: string;
    publishedAt?: string;
  };
}

interface ChannelItem {
  id: string;
  snippet?: {
    title?: string;
    description?: string;
    publishedAt?: string;
    country?: string;
    customUrl?: string;
    thumbnails?: { default?: { url?: string }; medium?: { url?: string } };
  };
  statistics?: {
    subscriberCount?: string;
    viewCount?: string;
    videoCount?: string;
    hiddenSubscriberCount?: boolean;
  };
  contentDetails?: { relatedPlaylists?: { uploads?: string } };
}

/** Gom video khớp theo kênh. */
interface Hit {
  /** videoId → tiêu đề. Map chứ không phải bộ đếm: một video hay khớp nhiều
   *  truy vấn cùng lúc, đếm theo lượt xuất hiện là thổi phồng cột "Khớp". */
  videos: Map<string, string>;
  queries: Set<string>;
  viTitles: number;
}

/** Thời lượng (giây) của các video, 1 unit / 50 video. Lô lỗi thì bỏ qua lô đó. */
async function fetchDurations(
  client: YouTubeClient,
  ids: string[]
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += 50) chunks.push(ids.slice(i, i + 50));
  const CONC = 4;
  for (let i = 0; i < chunks.length; i += CONC) {
    await Promise.all(
      chunks.slice(i, i + CONC).map(async (chunk) => {
        try {
          const data = await client.call<{
            items?: { id: string; contentDetails?: { duration?: string } }[];
          }>("videos", { part: "contentDetails", id: chunk.join(",") });
          for (const it of data.items ?? [])
            out.set(it.id, parseIsoDuration(it.contentDetails?.duration ?? "PT0S"));
        } catch {
          /* lô lỗi thì các video trong lô coi như không đo được */
        }
      })
    );
  }
  return out;
}

/** YouTube nhận "zh-Hant"/"zh-Hans" nhưng các ngôn ngữ khác chỉ 2 chữ cái. */
const relevanceLang = (lang: string) =>
  /^zh-Han[st]$/.test(lang) ? lang : lang.slice(0, 2).toLowerCase();

const decode = (s: string) =>
  s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");

export async function discoverChannels(params: DiscoverParams): Promise<DiscoverResult> {
  const client = new YouTubeClient(params.apiKeys);
  const now = Date.now();

  const publishedAfter =
    params.publishedWithinDays > 0
      ? new Date(now - params.publishedWithinDays * 86_400_000).toISOString()
      : undefined;

  // ── tìm video ─────────────────────────────────────────────────────────────
  const hits = new Map<string, Hit>();
  const channelTitles = new Map<string, string>();
  let videosScanned = 0;

  // Mỗi (truy vấn × độ dài) là một lượt search riêng. Chạy 3 lượt song song: chọn
  // 2 độ dài × 10 truy vấn là 20 lượt, đi tuần tự sẽ mất ~20s và ăn gần hết trần
  // 60s của route trước khi kịp soi kênh.
  const durations = params.videoDurations.length ? params.videoDurations : ["any"];
  const combos = params.queries.flatMap((query) =>
    durations.map((duration) => ({ query, duration }))
  );

  const runCombo = async ({
    query,
    duration,
  }: {
    query: SearchQuery;
    duration: string;
  }) => {
    let pageToken: string | undefined;
    for (let page = 0; page < Math.max(1, params.pagesPerQuery); page++) {
      const data = await client.call<{ items?: SearchItem[]; nextPageToken?: string }>(
        "search",
        {
          part: "snippet",
          type: "video",
          maxResults: "50",
          order: params.order,
          q: query.q,
          ...(query.lang ? { relevanceLanguage: relevanceLang(query.lang) } : {}),
          ...(query.region ? { regionCode: query.region } : {}),
          ...(duration !== "any" ? { videoDuration: duration } : {}),
          ...(publishedAfter ? { publishedAfter } : {}),
          ...(pageToken ? { pageToken } : {}),
        }
      );

      for (const it of data.items ?? []) {
        const cid = it.snippet?.channelId;
        if (!cid) continue;
        videosScanned++;
        const title = decode(it.snippet?.title ?? "");
        const vid = it.id?.videoId ?? "";
        const hit = hits.get(cid) ?? {
          videos: new Map<string, string>(),
          queries: new Set<string>(),
          viTitles: 0,
        };
        hit.queries.add(query.q);
        if (vid && !hit.videos.has(vid)) {
          hit.videos.set(vid, title);
          if (looksVietnamese(title)) hit.viTitles++;
        }
        hits.set(cid, hit);
        channelTitles.set(cid, decode(it.snippet?.channelTitle ?? ""));
      }

      pageToken = data.nextPageToken;
      if (!pageToken) break;
      // Nghỉ giữa các trang: bắn search liên tục rất dễ dính 429 tạm thời.
      await new Promise((r) => setTimeout(r, 250));
    }
  };

  const SEARCH_CONC = 3;
  for (let i = 0; i < combos.length; i += SEARCH_CONC) {
    await Promise.all(combos.slice(i, i + SEARCH_CONC).map(runCombo));
  }

  // ── lọc theo thời lượng VIDEO KHỚP ────────────────────────────────────────
  // Chip "Độ dài video khi tìm" chỉ có 3 nấc cố định của YouTube (<4', 4–20',
  // >20'); muốn "video khớp 8–15 phút" thì phải đo thật từng video. Kênh không còn
  // video khớp nào trong khoảng thì bị loại luôn — nó chỉ lọt vào nhờ video ngoài
  // khoảng mà người dùng vừa bảo không muốn.
  const channelsFound = hits.size;
  let matchDurationDropped = 0;
  const matchDurations = new Map<string, number>();
  const durationFilterOn = params.matchMinSec > 0 || params.matchMaxSec > 0;
  if (durationFilterOn && hits.size > 0) {
    const allVids = [...new Set([...hits.values()].flatMap((h) => [...h.videos.keys()]))];
    for (const [id, sec] of await fetchDurations(client, allVids)) matchDurations.set(id, sec);

    for (const [cid, hit] of hits) {
      for (const vid of [...hit.videos.keys()]) {
        const sec = matchDurations.get(vid);
        const ok =
          sec !== undefined &&
          (params.matchMinSec <= 0 || sec >= params.matchMinSec) &&
          (params.matchMaxSec <= 0 || sec <= params.matchMaxSec);
        if (!ok) hit.videos.delete(vid);
      }
      if (hit.videos.size === 0) {
        hits.delete(cid);
        matchDurationDropped++;
      }
    }
  }

  if (hits.size === 0) {
    return {
      channels: [],
      videosScanned,
      channelsFound,
      channelsAfterFilter: 0,
      vietnameseDropped: 0,
      matchDurationDropped,
      inspected: 0,
      shortFormDropped: 0,
      usage: client.usage,
      quotaSpent: Object.values(client.usage).reduce((a, b) => a + b, 0),
    };
  }

  // ── thống kê kênh (1 unit / 50 kênh) ──────────────────────────────────────
  const ids = [...hits.keys()];
  const channels: ChannelItem[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const data = await client.call<{ items?: ChannelItem[] }>("channels", {
      part: "snippet,statistics,contentDetails",
      id: ids.slice(i, i + 50).join(","),
      maxResults: "50",
    });
    channels.push(...(data.items ?? []));
  }

  let vietnameseDropped = 0;
  const rows: ChannelRow[] = [];

  for (const c of channels) {
    const hit = hits.get(c.id);
    if (!hit) continue;
    const sample = [...hit.videos.entries()][0];

    const title = decode(c.snippet?.title ?? channelTitles.get(c.id) ?? "");
    const description = c.snippet?.description ?? "";
    const country = c.snippet?.country ?? "";

    // Ba tầng nhận diện: quốc gia khai báo · chữ trên tên/mô tả kênh · tiêu đề
    // video khớp. Tầng 3 quan trọng nhất — kênh Việt rất hay để trống country.
    const isVietnamese =
      country === "VN" || looksVietnamese(title, description) || hit.viTitles >= 2;
    if (!params.includeVietnam && isVietnamese) {
      vietnameseDropped++;
      continue;
    }

    const subscribers = Number(c.statistics?.subscriberCount ?? 0);
    const totalViews = Number(c.statistics?.viewCount ?? 0);
    const videoCount = Number(c.statistics?.videoCount ?? 0);
    const avgViews = videoCount > 0 ? Math.round(totalViews / videoCount) : 0;

    if (params.minSubs > 0 && subscribers < params.minSubs) continue;
    if (params.maxSubs > 0 && subscribers > params.maxSubs) continue;
    if (params.minAvgViews > 0 && avgViews < params.minAvgViews) continue;
    if (params.minVideos > 0 && videoCount < params.minVideos) continue;

    const publishedAt = c.snippet?.publishedAt ?? "";
    rows.push({
      channelId: c.id,
      title,
      url: c.snippet?.customUrl
        ? `https://www.youtube.com/${c.snippet.customUrl}`
        : `https://www.youtube.com/channel/${c.id}`,
      description: description.slice(0, 200),
      thumbnail: c.snippet?.thumbnails?.default?.url ?? "",
      country,
      createdAt: publishedAt ? publishedAt.slice(0, 10) : "",
      subscribers,
      subscribersHidden: Boolean(c.statistics?.hiddenSubscriberCount),
      subscribersLabel: c.statistics?.hiddenSubscriberCount
        ? "ẩn"
        : formatViews(subscribers),
      totalViews,
      totalViewsLabel: formatViews(totalViews),
      videoCount,
      avgViews,
      avgViewsLabel: formatViews(avgViews),
      viewsPerSub: subscribers > 0 ? Math.round((avgViews / subscribers) * 100) / 100 : 0,
      matchCount: hit.videos.size,
      matchedQueries: [...hit.queries],
      sampleTitle: sample?.[1] ?? "",
      sampleUrl: sample ? `https://www.youtube.com/watch?v=${sample[0]}` : "",
      sampleDurationLabel:
        sample && matchDurations.has(sample[0])
          ? formatDuration(matchDurations.get(sample[0])!)
          : "",
      latestUploadAt: "",
      latestUploadRelative: "",
      latestUploadDays: -1,
      avgDurationSec: 0,
      avgDurationLabel: "",
      longRatio: 0,
      recentSampled: 0,
      isVietnamese,
    });
  }

  // Xếp theo tỉ lệ view/sub (mục tiêu "ít sub nhiều view"), kênh nào cùng tỉ lệ
  // thì kênh khớp nhiều video hơn đứng trước.
  rows.sort(
    (a, b) => b.viewsPerSub - a.viewsPerSub || b.matchCount - a.matchCount
  );

  const channelsAfterFilter = rows.length;

  // ── soi N video gần nhất của từng kênh ────────────────────────────────────
  // Một playlistItems lấy được 10 video cũng chỉ tốn 1 unit y như lấy 1 video, nên
  // đây là cách rẻ nhất để biết kênh THỰC SỰ đăng gì: thời lượng thật của video
  // gần nhất. Không có bước này thì không phân biệt được kênh làm video 20 phút
  // với kênh chỉ đăng Shorts — cả hai đều "có video khớp truy vấn".
  const RECENT = 10;
  const inspectTargets = params.inspectLimit > 0 ? rows.slice(0, params.inspectLimit) : [];
  const byId = new Map(channels.map((c) => [c.id, c]));
  const recentIds = new Map<ChannelRow, string[]>();

  const CONC = 8;
  for (let i = 0; i < inspectTargets.length; i += CONC) {
    await Promise.all(
      inspectTargets.slice(i, i + CONC).map(async (row) => {
        const uploads = byId.get(row.channelId)?.contentDetails?.relatedPlaylists?.uploads;
        if (!uploads) return;
        try {
          const data = await client.call<{
            items?: { contentDetails?: { videoId?: string; videoPublishedAt?: string } }[];
          }>("playlistItems", {
            part: "contentDetails",
            playlistId: uploads,
            maxResults: String(RECENT),
          });
          const items = data.items ?? [];
          const at = items[0]?.contentDetails?.videoPublishedAt ?? "";
          if (at) {
            row.latestUploadAt = at;
            row.latestUploadRelative = relativeVi(at, now);
            row.latestUploadDays = Math.floor((now - new Date(at).getTime()) / 86_400_000);
          }
          const ids = items
            .map((x) => x.contentDetails?.videoId)
            .filter((x): x is string => Boolean(x));
          if (ids.length) recentIds.set(row, ids);
        } catch {
          /* kênh khoá uploads / lỗi lẻ — bỏ qua, đừng làm hỏng cả lần chạy */
        }
      })
    );
  }

  // Thời lượng: 1 unit cho mỗi 50 video, nên 100 kênh × 10 video chỉ tốn ~20 units.
  if (recentIds.size > 0) {
    const allIds = [...new Set([...recentIds.values()].flat())];
    const durations = await fetchDurations(client, allIds);

    for (const [row, ids] of recentIds) {
      const secs = ids.map((id) => durations.get(id)).filter((x): x is number => x !== undefined);
      if (secs.length === 0) continue;
      const long = secs.filter((x) => x >= params.longMinSec).length;
      row.recentSampled = secs.length;
      row.avgDurationSec = Math.round(secs.reduce((a, b) => a + b, 0) / secs.length);
      row.avgDurationLabel = formatDuration(row.avgDurationSec);
      row.longRatio = Math.round((long / secs.length) * 100);
    }
  }

  // ── lọc kênh video dài ────────────────────────────────────────────────────
  // Kênh không soi được (uploads bị khoá, hoặc nằm ngoài trần inspectLimit) bị
  // loại luôn: giữ lại là trả về đúng thứ người dùng vừa bảo không muốn.
  let kept = params.inspectLimit > 0 ? inspectTargets : rows;
  let shortFormDropped = 0;
  if (params.longFormOnly) {
    const before = kept.length;
    kept = kept.filter(
      (r) => r.recentSampled > 0 && r.longRatio >= params.longRatioMin
    );
    shortFormDropped = before - kept.length;
  }

  const top = kept.slice(0, params.limit);

  return {
    channels: top,
    videosScanned,
    channelsFound,
    matchDurationDropped,
    channelsAfterFilter,
    vietnameseDropped,
    inspected: inspectTargets.length,
    shortFormDropped,
    usage: client.usage,
    quotaSpent: Object.values(client.usage).reduce((a, b) => a + b, 0),
  };
}
