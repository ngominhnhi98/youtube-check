"use client";

import { useCallback, useEffect, useState } from "react";

interface ApiKeyDTO {
  id: string;
  label: string;
  masked: string;
  addedAt: string;
  quotaUsed: number;
  quotaLimit: number;
}

export default function SettingsModal({ onClose }: { onClose: () => void }) {
  const [keys, setKeys] = useState<ApiKeyDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [value, setValue] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/settings", { cache: "no-store" });
      const data = await res.json();
      if (res.ok) setKeys(data.apiKeys ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: value.trim(), label: label.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Thêm key thất bại");
        return;
      }
      setKeys(data.apiKeys ?? []);
      setValue("");
      setLabel("");
    } catch {
      setError("Lỗi kết nối");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    const res = await fetch(`/api/settings?id=${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    const data = await res.json();
    if (res.ok) setKeys(data.apiKeys ?? []);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[90vh] w-full overflow-y-auto rounded-t-2xl border bg-card p-6 shadow-xl sm:max-w-lg sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">⚙️ Cài đặt</h2>
            <p className="text-sm text-muted">
              Quản lý YouTube API key — hệ thống tự xoay vòng khi chạy.
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-md px-2 py-1 text-muted hover:bg-black/5 dark:hover:bg-white/5"
          >
            ✕
          </button>
        </div>

        {/* Existing keys */}
        <div className="mb-5">
          <h3 className="mb-2 text-sm font-medium">
            Danh sách key {keys.length > 0 && `(${keys.length})`}
          </h3>
          {loading ? (
            <p className="text-sm text-muted">Đang tải…</p>
          ) : keys.length === 0 ? (
            <p className="rounded-lg border border-dashed bg-background px-3 py-4 text-center text-sm text-muted">
              Chưa có key nào. Thêm ít nhất một key để chạy.
            </p>
          ) : (
            <ul className="space-y-2">
              {keys.map((k) => (
                <li
                  key={k.id}
                  className="flex items-center justify-between gap-3 rounded-lg border bg-background px-3 py-2"
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">
                      {k.label || "Không nhãn"}
                    </div>
                    <div className="truncate font-mono text-xs text-muted">{k.masked}</div>
                    <div className="text-xs text-muted">
                      Quota hôm nay: {k.quotaUsed.toLocaleString()}/{k.quotaLimit.toLocaleString()}
                    </div>
                  </div>
                  <button
                    onClick={() => remove(k.id)}
                    className="shrink-0 rounded-md border border-red-300 px-2 py-1 text-xs text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40"
                  >
                    Xóa
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Add key */}
        <form onSubmit={add} className="space-y-2 border-t pt-4">
          <h3 className="text-sm font-medium">Thêm key mới</h3>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Nhãn (tùy chọn) — vd: Project A"
            className="w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500/40"
          />
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="AIza…"
            className="w-full rounded-lg border bg-background px-3 py-2 font-mono text-sm outline-none focus:ring-2 focus:ring-blue-500/40"
          />
          {error && (
            <p className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={busy || !value.trim()}
            className="w-full rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {busy ? "Đang thêm…" : "＋ Thêm key"}
          </button>
        </form>
      </div>
    </div>
  );
}
