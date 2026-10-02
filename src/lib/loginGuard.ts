import type { NextRequest } from "next/server";
import { LoginAttempt } from "@/lib/models/LoginAttempt";

/** Failures tolerated inside one window before the IP is locked out. */
export const MAX_FAILURES = 5;
/** Failures inside the window are counted for this long. */
const WINDOW_MS = 15 * 60 * 1000;
const LOCK_MS = 15 * 60 * 1000;
/** A persistent guesser gets a much longer lock. */
const PERSISTENT_AFTER = 10;
const LONG_LOCK_MS = 60 * 60 * 1000;

export interface LockState {
  locked: boolean;
  retryAfterSec: number;
  failures: number;
}

/** Best-effort client IP. On Vercel `x-forwarded-for` is set by the edge proxy. */
export function clientIp(req: NextRequest): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return req.headers.get("x-real-ip")?.trim() || "unknown";
}

function lockStateFrom(lockedUntil: Date | null, failures: number, now: number): LockState {
  const remaining = lockedUntil ? lockedUntil.getTime() - now : 0;
  return {
    locked: remaining > 0,
    retryAfterSec: remaining > 0 ? Math.ceil(remaining / 1000) : 0,
    failures,
  };
}

/** Is this IP currently locked out? Called before the password is even checked. */
export async function loginLockState(ip: string, now = Date.now()): Promise<LockState> {
  const doc = await LoginAttempt.findOne({ ip });
  if (!doc) return { locked: false, retryAfterSec: 0, failures: 0 };
  return lockStateFrom(doc.lockedUntil ?? null, doc.failures ?? 0, now);
}

/** Record a wrong password and return the resulting lock state. */
export async function recordLoginFailure(ip: string, now = Date.now()): Promise<LockState> {
  const doc = await LoginAttempt.findOne({ ip });

  // Failures older than the window start a fresh count.
  const windowOpen =
    doc && now - (doc.firstFailureAt?.getTime() ?? 0) < WINDOW_MS;
  const failures = windowOpen ? (doc.failures ?? 0) + 1 : 1;

  const lockMs =
    failures >= PERSISTENT_AFTER
      ? LONG_LOCK_MS
      : failures >= MAX_FAILURES
        ? LOCK_MS
        : 0;
  const lockedUntil = lockMs > 0 ? new Date(now + lockMs) : null;

  await LoginAttempt.updateOne(
    { ip },
    {
      $set: {
        failures,
        lastFailureAt: new Date(now),
        lockedUntil,
        ...(windowOpen ? {} : { firstFailureAt: new Date(now) }),
      },
    },
    { upsert: true }
  );

  return lockStateFrom(lockedUntil, failures, now);
}

/** A correct password clears the record for that IP. */
export async function clearLoginFailures(ip: string): Promise<void> {
  await LoginAttempt.deleteOne({ ip });
}
