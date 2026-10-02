/**
 * YouTube Data API v3 client (plain fetch, no SDK).
 *
 * - Cheap endpoints only (playlistItems/videos = 1 unit); `search.list` (100)
 *   is a last-resort channel resolver.
 * - Stops paging the uploads playlist once past the date window.
 * - Key rotation with per-key quota accounting: the client is given keys ordered
 *   least-used-first; on a quota/rate error it advances to the next key. It
 *   tracks how many units it spent per key so the caller can persist that.
 */

const API = "https://www.googleapis.com/youtube/v3";

export interface VideoRow {
  videoId: string;
  title: string;
  url: string;
  viewCount: number;
  viewsLabel: string;
  likeCount: number;
  commentCount: number;
  durationSec: number;
  durationLabel: string;
  publishedAt: string;
  publishedRelative: string;
  publishedDate: string; // YYYY-MM-DD
  channelTitle: string;
  categoryId: string;
  categoryName: string;
  viewsPerDay: number;
  engagementRate: number; // percent
}

export class YouTubeError extends Error {}
export class QuotaExhaustedError extends YouTubeError {}

// ── Formatting helpers ──────────────────────────────────────────────────────

export function formatViews(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) {
    const k = n / 1000;
    return k < 10 ? `${Math.floor(k * 10) / 10}K` : `${Math.floor(k)}K`;
  }
  const m = n / 1_000_000;
  return m < 10 ? `${Math.floor(m * 10) / 10}M` : `${Math.floor(m)}M`;
}

const pad = (x: number) => String(x).padStart(2, "0");

export function parseIsoDuration(iso: string): number {
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

export function formatDuration(totalSec: number): string {
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function relativeVi(publishedAtIso: string, now = Date.now()): string {
  const diff = Math.max(0, now - new Date(publishedAtIso).getTime());
  const min = Math.floor(diff / 60000);
  if (min < 1) return "vua xong";
  if (min < 60) return `${min} phut truoc`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} gio truoc`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} ngay truoc`;
  if (days < 35) return `${Math.floor(days / 7)} tuan truoc`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} thang truoc`;
  return `${Math.floor(days / 365)} nam truoc`;
}

// ── Rotating client with quota accounting ───────────────────────────────────

const QUOTA_REASONS = new Set([
  "quotaExceeded",
  "dailyLimitExceeded",
  "rateLimitExceeded",
  "userRateLimitExceeded",
]);

/**
 * Hết lượt TẠM THỜI (giây), khác hẳn hết quota NGÀY. YouTube trả 429
 * rateLimitExceeded rất hay gặp khi bắn nhiều `search.list` liền nhau — nghỉ vài
 * trăm ms rồi thử lại CHÍNH key đó là qua. Coi nó là "key hết quota" mà xoay key
 * là đốt sạch pool: một lần chạy quét nhiều từ khoá sẽ rụng hết 4 key trong vài
 * giây rồi báo "hết quota hôm nay" oan.
 */
const TRANSIENT_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded"]);
const MAX_TRANSIENT_RETRIES = 3;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BAD_KEY_REASONS = new Set(["keyInvalid", "keyExpired", "ipRefererBlocked"]);

export interface PoolKey {
  id: string;
  value: string;
}

const COST: Record<string, number> = {
  channels: 1,
  playlistItems: 1,
  videos: 1,
  videoCategories: 1,
  search: 100,
};

export class YouTubeClient {
  private idx = 0;
  usage: Record<string, number> = {};
  constructor(private keys: PoolKey[]) {
    if (keys.length === 0) throw new YouTubeError("Chưa cấu hình YouTube API key nào.");
  }

  private charge(path: string) {
    const id = this.keys[this.idx].id;
    this.usage[id] = (this.usage[id] ?? 0) + (COST[path] ?? 1);
  }

  async call<T>(path: string, params: Record<string, string>): Promise<T> {
    let transient = 0;
    for (
      let attempt = 0;
      attempt < this.keys.length + MAX_TRANSIENT_RETRIES;
      attempt++
    ) {
      const key = this.keys[this.idx];
      const qs = new URLSearchParams({ ...params, key: key.value }).toString();
      const res = await fetch(`${API}/${path}?${qs}`);
      if (res.ok) {
        this.charge(path);
        return res.json() as Promise<T>;
      }

      let reason = "";
      let message = "";
      try {
        const j = await res.json();
        reason = j?.error?.errors?.[0]?.reason ?? "";
        message = j?.error?.message ?? "";
      } catch {
        /* ignore */
      }

      // 503/500 không có reason cũng là lỗi thoáng qua — thử lại cùng key.
      const isTransient =
        TRANSIENT_REASONS.has(reason) || (!reason && (res.status === 429 || res.status >= 500));
      if (isTransient && transient < MAX_TRANSIENT_RETRIES) {
        transient++;
        await sleep(400 * transient);
        continue;
      }

      const rotate = QUOTA_REASONS.has(reason) || BAD_KEY_REASONS.has(reason);
      if (rotate && this.idx < this.keys.length - 1) {
        this.idx++;
        continue;
      }
      if (QUOTA_REASONS.has(reason)) {
        throw new QuotaExhaustedError(
          "Tất cả YouTube API key đã hết quota hôm nay. Thêm key mới trong Settings."
        );
      }
      throw new YouTubeError(
        `YouTube API ${path} lỗi (${res.status})${
          message ? `: ${message}` : reason ? `: ${reason}` : ""
        }`
      );
    }
    throw new QuotaExhaustedError("Đã thử hết mọi API key nhưng đều thất bại.");
  }
}

// ── Channel resolution ─────────────────────────────────────────────────────

export async function resolveChannelId(client: YouTubeClient, input: string): Promise<string> {
  const raw = input.trim();
  if (/\/channel\//.test(raw)) {
    const m = raw.match(/UC[0-9A-Za-z_-]{22}/);
    if (m) return m[0];
  }
  if (/^UC[0-9A-Za-z_-]{22}$/.test(raw)) return raw;

  let handle: string | null = null;
  let username: string | null = null;
  const atMatch = raw.match(/@([^/?\s]+)/);
  if (atMatch) handle = atMatch[1];
  const userMatch = raw.match(/\/user\/([^/?\s]+)/);
  if (userMatch) username = userMatch[1];
  const cMatch = raw.match(/\/c\/([^/?\s]+)/);
  if (!handle && cMatch) handle = cMatch[1];
  if (!handle && !username && !/[/@]/.test(raw)) handle = raw;

  if (handle) {
    try {
      const data = await client.call<{ items?: { id: string }[] }>("channels", {
        part: "id",
        forHandle: handle.startsWith("@") ? handle : `@${handle}`,
      });
      if (data.items?.[0]?.id) return data.items[0].id;
    } catch {
      /* fall through */
    }
  }
  if (username) {
    const data = await client.call<{ items?: { id: string }[] }>("channels", {
      part: "id",
      forUsername: username,
    });
    if (data.items?.[0]?.id) return data.items[0].id;
  }
  const q = handle ?? username ?? raw;
  const search = await client.call<{ items?: { snippet?: { channelId?: string } }[] }>("search", {
    part: "snippet",
    type: "channel",
    maxResults: "1",
    q,
  });
  const found = search.items?.[0]?.snippet?.channelId;
  if (found) return found;
  throw new YouTubeError(`Không resolve được kênh từ "${input}".`);
}

async function getUploadsPlaylistId(
  client: YouTubeClient,
  channelId: string
): Promise<{ uploads: string; channelTitle: string }> {
  const data = await client.call<{
    items?: {
      snippet?: { title?: string };
      contentDetails?: { relatedPlaylists?: { uploads?: string } };
    }[];
  }>("channels", { part: "contentDetails,snippet", id: channelId });
  const item = data.items?.[0];
  const uploads = item?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploads) throw new YouTubeError("Kênh không hợp lệ hoặc không có video.");
  return { uploads, channelTitle: item?.snippet?.title ?? "" };
}

interface PlaylistPage {
  nextPageToken?: string;
  items?: { contentDetails?: { videoId?: string; videoPublishedAt?: string } }[];
}

async function windowedVideoIds(
  client: YouTubeClient,
  playlistId: string,
  olderBound: number,
  newerBound: number,
  hardCap = 1000
): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  while (ids.length < hardCap) {
    const page: PlaylistPage = await client.call<PlaylistPage>("playlistItems", {
      part: "contentDetails",
      playlistId,
      maxResults: "50",
      ...(pageToken ? { pageToken } : {}),
    });
    let crossed = false;
    for (const item of page.items ?? []) {
      const vid = item.contentDetails?.videoId;
      const pub = item.contentDetails?.videoPublishedAt;
      if (!vid || !pub) continue;
      const t = new Date(pub).getTime();
      if (t < olderBound) {
        crossed = true;
        break;
      }
      if (t > newerBound) continue; // newer than the range — skip, keep paging
      ids.push(vid);
    }
    if (crossed || !page.nextPageToken) break;
    pageToken = page.nextPageToken;
  }
  return ids;
}

async function categoryMap(client: YouTubeClient): Promise<Record<string, string>> {
  try {
    const data = await client.call<{ items?: { id: string; snippet?: { title?: string } }[] }>(
      "videoCategories",
      { part: "snippet", regionCode: "US" }
    );
    const map: Record<string, string> = {};
    for (const it of data.items ?? []) map[it.id] = it.snippet?.title ?? "";
    return map;
  } catch {
    return {};
  }
}

interface VideoItem {
  id: string;
  snippet?: {
    title?: string;
    publishedAt?: string;
    channelTitle?: string;
    categoryId?: string;
  };
  statistics?: { viewCount?: string; likeCount?: string; commentCount?: string };
  contentDetails?: { duration?: string };
}

async function hydrate(
  client: YouTubeClient,
  videoIds: string[],
  cats: Record<string, string>,
  now = Date.now()
): Promise<VideoRow[]> {
  const rows: VideoRow[] = [];
  for (let i = 0; i < videoIds.length; i += 50) {
    const chunk = videoIds.slice(i, i + 50);
    const data = await client.call<{ items?: VideoItem[] }>("videos", {
      part: "snippet,statistics,contentDetails",
      id: chunk.join(","),
    });
    for (const it of data.items ?? []) {
      const viewCount = Number(it.statistics?.viewCount ?? 0);
      const likeCount = Number(it.statistics?.likeCount ?? 0);
      const commentCount = Number(it.statistics?.commentCount ?? 0);
      const durationSec = parseIsoDuration(it.contentDetails?.duration ?? "PT0S");
      const publishedAt = it.snippet?.publishedAt ?? "";
      const ageDays = publishedAt
        ? Math.max(1, (now - new Date(publishedAt).getTime()) / 86_400_000)
        : 1;
      const categoryId = it.snippet?.categoryId ?? "";
      rows.push({
        videoId: it.id,
        title: it.snippet?.title ?? "",
        url: `https://www.youtube.com/watch?v=${it.id}`,
        viewCount,
        viewsLabel: formatViews(viewCount),
        likeCount,
        commentCount,
        durationSec,
        durationLabel: formatDuration(durationSec),
        publishedAt,
        publishedRelative: publishedAt ? relativeVi(publishedAt, now) : "",
        publishedDate: publishedAt ? publishedAt.slice(0, 10) : "",
        channelTitle: it.snippet?.channelTitle ?? "",
        categoryId,
        categoryName: cats[categoryId] ?? "",
        viewsPerDay: Math.round(viewCount / ageDays),
        engagementRate:
          viewCount > 0 ? Math.round(((likeCount + commentCount) / viewCount) * 1000) / 10 : 0,
      });
    }
  }
  return rows;
}

export interface FetchParams {
  channelUrl: string;
  apiKeys: PoolKey[];
  /** Date window. dateFrom/dateTo (YYYY-MM-DD) win; else last `maxDays`. */
  maxDays: number;
  dateFrom?: string;
  dateTo?: string;
  // Numeric filters (0/empty = off).
  minViews: number;
  minLikes: number;
  minComments: number;
  minDurationSec: number;
  maxDurationSec: number;
  minEngagement: number; // percent
  minViewsPerDay: number;
}

export interface FetchResult {
  channelId: string;
  channelTitle: string;
  scanned: number;
  videos: VideoRow[];
  usage: Record<string, number>;
}

export async function fetchChannelVideos(params: FetchParams): Promise<FetchResult> {
  const client = new YouTubeClient(params.apiKeys);
  const now = Date.now();

  const olderBound = params.dateFrom
    ? new Date(`${params.dateFrom}T00:00:00Z`).getTime()
    : now - params.maxDays * 86_400_000;
  const newerBound = params.dateTo
    ? new Date(`${params.dateTo}T23:59:59Z`).getTime()
    : now;

  const channelId = await resolveChannelId(client, params.channelUrl);
  const { uploads, channelTitle } = await getUploadsPlaylistId(client, channelId);
  const ids = await windowedVideoIds(client, uploads, olderBound, newerBound);
  const cats = await categoryMap(client);
  const hydrated = await hydrate(client, ids, cats, now);

  const videos = hydrated
    .filter((v) => v.viewCount >= params.minViews)
    .filter((v) => v.likeCount >= params.minLikes)
    .filter((v) => v.commentCount >= params.minComments)
    .filter((v) => (params.minDurationSec ? v.durationSec >= params.minDurationSec : true))
    .filter((v) => (params.maxDurationSec ? v.durationSec <= params.maxDurationSec : true))
    .filter((v) => (params.minEngagement ? v.engagementRate >= params.minEngagement : true))
    .filter((v) => (params.minViewsPerDay ? v.viewsPerDay >= params.minViewsPerDay : true))
    .sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1));

  return {
    channelId,
    channelTitle: channelTitle || hydrated[0]?.channelTitle || "",
    scanned: ids.length,
    videos,
    usage: client.usage,
  };
}
