"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";

interface AuthContextValue {
  loading: boolean;
  authRequired: boolean;
  authed: boolean;
  misconfigured: boolean;
  canEdit: boolean;
  lock: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);
const LS_KEY = "yc_unlocked";

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

export default function AuthProvider({ children }: { children: React.ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [authRequired, setAuthRequired] = useState(false);
  const [authed, setAuthed] = useState(false);
  const [misconfigured, setMisconfigured] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/auth", { cache: "no-store" });
      const data = await res.json();
      setAuthRequired(Boolean(data.authRequired));
      setAuthed(Boolean(data.authed));
      setMisconfigured(Boolean(data.misconfigured));
      // Keep the localStorage hint in sync with the server's truth.
      if (data.authed) localStorage.setItem(LS_KEY, "1");
      else localStorage.removeItem(LS_KEY);
    } catch {
      // leave defaults
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const lock = useCallback(async () => {
    await fetch("/api/auth", { method: "DELETE" });
    localStorage.removeItem(LS_KEY);
    setAuthed(false);
  }, []);

  const canEdit = !loading && !misconfigured && (!authRequired || authed);
  const locked = !loading && !misconfigured && authRequired && !authed;

  return (
    <AuthContext.Provider
      value={{ loading, authRequired, authed, misconfigured, canEdit, lock }}
    >
      {loading ? (
        <BootSplash />
      ) : misconfigured ? (
        <MisconfiguredScreen />
      ) : locked ? (
        <LoginGate onUnlocked={() => { localStorage.setItem(LS_KEY, "1"); setAuthed(true); }} />
      ) : (
        children
      )}
    </AuthContext.Provider>
  );
}

function BootSplash() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />
    </div>
  );
}

function MisconfiguredScreen() {
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="max-w-md rounded-xl border border-red-300 bg-red-50 p-6 text-center dark:bg-red-950/40">
        <div className="mb-2 text-3xl">⚠️</div>
        <h1 className="mb-1 text-lg font-semibold text-red-700 dark:text-red-300">
          Server chưa cấu hình
        </h1>
        <p className="text-sm text-red-700/80 dark:text-red-300/80">
          Biến <code>ADMIN_PASSWORD</code> chưa được đặt. Thêm nó vào môi trường
          rồi deploy lại.
        </p>
      </div>
    </div>
  );
}

function LoginGate({ onUnlocked }: { onUnlocked: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Sai mật khẩu");
        setSubmitting(false);
        return;
      }
      onUnlocked();
    } catch {
      setError("Lỗi kết nối");
      setSubmitting(false);
    }
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden px-4">
      {/* Ambient gradient backdrop */}
      <div className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(60%_50%_at_50%_0%,rgba(59,130,246,0.14),transparent),radial-gradient(50%_50%_at_100%_100%,rgba(239,68,68,0.10),transparent)]" />
      <div className="w-full max-w-sm rounded-2xl border bg-card p-7 shadow-xl">
        <div className="mb-5 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-red-500/10 text-2xl">
            ▶️
          </div>
          <h1 className="text-lg font-semibold">YouTube Check</h1>
          <p className="mt-1 text-sm text-muted">Nhập mật khẩu để tiếp tục</p>
        </div>
        <form onSubmit={submit} className="space-y-3">
          <input
            type="password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Mật khẩu"
            className="w-full rounded-lg border bg-background px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-blue-500/40"
          />
          {error && (
            <p className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={submitting || !password}
            className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-blue-700 disabled:opacity-50"
          >
            {submitting ? "Đang mở khóa…" : "Mở khóa"}
          </button>
        </form>
      </div>
    </div>
  );
}
