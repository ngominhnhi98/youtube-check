import mongoose, { Schema, InferSchemaType, Model } from "mongoose";

/**
 * Global app settings (singleton, keyed by a fixed `key`). Holds the pool of
 * YouTube Data API keys, each with per-day quota accounting so we can pick the
 * least-used key that still has quota left (like YoutubeAutoReply).
 *
 * NOTE: no Google credentials live here. Each user's Google access token is
 * held client-side in their browser (localStorage) for privacy — see
 * components/useGoogleAuth.ts.
 */
const ApiKeySchema = new Schema(
  {
    label: { type: String, default: "" },
    value: { type: String, required: true },
    addedAt: { type: Date, default: Date.now },
    /** Units spent on the current quota day (Pacific). */
    quotaUsed: { type: Number, default: 0 },
    /** The Pacific date (YYYY-MM-DD) `quotaUsed` refers to. */
    quotaDate: { type: String, default: "" },
    /** Daily quota (YouTube default is 10,000 units). */
    quotaLimit: { type: Number, default: 10000 },
    lastUsedAt: { type: Date, default: null },
  },
  { _id: true }
);

const SettingsSchema = new Schema(
  {
    key: { type: String, required: true, unique: true, default: "global" },
    youtubeApiKeys: { type: [ApiKeySchema], default: [] },
  },
  { timestamps: true }
);

export type SettingsDoc = InferSchemaType<typeof SettingsSchema> & {
  _id: mongoose.Types.ObjectId;
};

export const Settings: Model<SettingsDoc> =
  (mongoose.models.Settings as Model<SettingsDoc>) ||
  mongoose.model<SettingsDoc>("Settings", SettingsSchema);

export async function getSettings(): Promise<SettingsDoc> {
  const existing = await Settings.findOne({ key: "global" });
  if (existing) return existing;
  return Settings.create({ key: "global" });
}

/** YouTube resets quota at midnight Pacific — bucket usage by that date. */
export function pacificDate(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function maskKey(value: string): string {
  if (value.length <= 12) return "••••";
  return `${value.slice(0, 6)}••••${value.slice(-4)}`;
}

interface ApiKeySub {
  _id: mongoose.Types.ObjectId;
  label?: string;
  value: string;
  addedAt?: Date;
  quotaUsed?: number;
  quotaDate?: string;
  quotaLimit?: number;
  lastUsedAt?: Date | null;
}

export interface ApiKeyDTO {
  id: string;
  label: string;
  masked: string;
  addedAt: string;
  quotaUsed: number;
  quotaLimit: number;
  lastUsedAt: string | null;
}

export function toApiKeyDTOs(doc: SettingsDoc): ApiKeyDTO[] {
  const today = pacificDate();
  return (doc.youtubeApiKeys ?? []).map((k) => {
    const s = k as unknown as ApiKeySub;
    const used = s.quotaDate === today ? s.quotaUsed ?? 0 : 0;
    return {
      id: s._id.toString(),
      label: s.label ?? "",
      masked: maskKey(s.value),
      addedAt: (s.addedAt ?? new Date()).toISOString(),
      quotaUsed: used,
      quotaLimit: s.quotaLimit ?? 10000,
      lastUsedAt: s.lastUsedAt ? s.lastUsedAt.toISOString() : null,
    };
  });
}

export interface PoolKey {
  id: string;
  value: string;
}

/**
 * Return usable API keys ordered by least-used-today first (LRU-ish), dropping
 * any that have already hit their daily quota. Falls back to YOUTUBE_API_KEY.
 */
export async function getPoolKeys(): Promise<PoolKey[]> {
  const doc = await getSettings();
  const today = pacificDate();
  const subs = (doc.youtubeApiKeys ?? []).map((k) => k as unknown as ApiKeySub);

  if (subs.length === 0) {
    const envKey = process.env.YOUTUBE_API_KEY;
    return envKey ? [{ id: "env", value: envKey }] : [];
  }

  return subs
    .map((s) => ({
      id: s._id.toString(),
      value: s.value,
      used: s.quotaDate === today ? s.quotaUsed ?? 0 : 0,
      limit: s.quotaLimit ?? 10000,
    }))
    .filter((k) => k.used < k.limit)
    .sort((a, b) => a.used - b.used)
    .map((k) => ({ id: k.id, value: k.value }));
}

/** Add spent quota units to the given keys (called after a run). */
export async function recordKeyQuota(usage: Record<string, number>): Promise<void> {
  const ids = Object.keys(usage).filter((id) => id !== "env" && usage[id] > 0);
  if (ids.length === 0) return;
  const doc = await getSettings();
  const today = pacificDate();
  let changed = false;
  for (const k of doc.youtubeApiKeys ?? []) {
    const s = k as unknown as ApiKeySub;
    const id = s._id.toString();
    if (usage[id] > 0) {
      const base = s.quotaDate === today ? s.quotaUsed ?? 0 : 0;
      s.quotaUsed = base + usage[id];
      s.quotaDate = today;
      s.lastUsedAt = new Date();
      changed = true;
    }
  }
  if (changed) await (doc as unknown as { save: () => Promise<unknown> }).save();
}
