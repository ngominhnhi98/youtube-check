import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";

export const AUTH_COOKIE = "yc_auth";

/** Sessions stop working after this long even if the cookie survives. */
export const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Auth is only enforced when an admin password is configured. */
export function authEnabled(): boolean {
  return Boolean(process.env.ADMIN_PASSWORD && process.env.ADMIN_PASSWORD.length > 0);
}

/**
 * Fail closed in production. Without a password every caller would be treated
 * as an admin, so one missing env var would silently open the whole app.
 * Locally we keep it open so `npm run dev` needs no setup.
 */
export function authMisconfigured(): boolean {
  return !authEnabled() && process.env.NODE_ENV === "production";
}

/**
 * Key used to sign session cookies. `SESSION_SECRET` keeps sessions independent
 * of the password; without it we derive a key from the password so the app
 * still runs with no extra config.
 */
function sessionKey(): Buffer {
  const explicit = process.env.SESSION_SECRET;
  if (explicit && explicit.length > 0) return Buffer.from(explicit, "utf8");
  return crypto
    .createHash("sha256")
    .update(`yc-session|${process.env.ADMIN_PASSWORD ?? ""}`)
    .digest();
}

function sign(payload: string): string {
  return crypto.createHmac("sha256", sessionKey()).update(payload).digest("hex");
}

/** Constant-time password check. Both sides are hashed first so the comparison
 *  is fixed-length and leaks nothing about the password's length. */
export function passwordMatches(password: string): boolean {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) return false;
  const a = crypto.createHash("sha256").update(password).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

/** Mint a session token: `v1.<issuedAt>.<nonce>.<hmac>`. */
export function issueSessionToken(now: number = Date.now()): string {
  const payload = `v1.${now}.${crypto.randomBytes(12).toString("hex")}`;
  return `${payload}.${sign(payload)}`;
}

export function isValidToken(
  token: string | undefined | null,
  now: number = Date.now()
): boolean {
  if (!authEnabled()) return !authMisconfigured();
  if (!token) return false;

  const cut = token.lastIndexOf(".");
  if (cut <= 0) return false;
  const payload = token.slice(0, cut);
  const tag = Buffer.from(token.slice(cut + 1), "hex");
  const expected = Buffer.from(sign(payload), "hex");
  if (tag.length !== expected.length || !crypto.timingSafeEqual(tag, expected)) {
    return false;
  }

  const [version, issuedAtRaw] = payload.split(".");
  if (version !== "v1") return false;
  const issuedAt = Number(issuedAtRaw);
  if (!Number.isFinite(issuedAt)) return false;
  // Allow a minute of clock skew, then enforce the max age.
  if (issuedAt > now + 60_000) return false;
  return now - issuedAt < SESSION_MAX_AGE_MS;
}

/** Whether the incoming request carries a valid session cookie. */
export function isAuthed(req: NextRequest): boolean {
  if (authMisconfigured()) return false;
  if (!authEnabled()) return true;
  return isValidToken(req.cookies.get(AUTH_COOKIE)?.value);
}

/**
 * Defence in depth against CSRF on top of the SameSite=Lax cookie: a browser
 * always sends `Origin` on POST/PATCH/DELETE, so a mismatch means the call came
 * from another site.
 */
export function rejectCrossSite(req: NextRequest): NextResponse | null {
  const origin = req.headers.get("origin");
  if (!origin) return null;
  const host = req.headers.get("host") ?? req.nextUrl.host;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return NextResponse.json({ error: "Bad Origin header" }, { status: 403 });
  }
  if (originHost !== host) {
    return NextResponse.json({ error: "Cross-site request rejected" }, { status: 403 });
  }
  return null;
}

export function misconfiguredResponse(): NextResponse {
  return NextResponse.json(
    { error: "Server misconfigured: ADMIN_PASSWORD is not set" },
    { status: 503 }
  );
}

/**
 * Guard for mutating route handlers. Returns a response when the caller must be
 * turned away, or null when the request may proceed.
 */
export function requireAuth(req: NextRequest): NextResponse | null {
  if (authMisconfigured()) return misconfiguredResponse();
  const crossSite = rejectCrossSite(req);
  if (crossSite) return crossSite;
  if (isAuthed(req)) return null;
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

/** Should the auth cookie be marked Secure? Only on HTTPS (so http://localhost works). */
export function useSecureCookie(req: NextRequest): boolean {
  const proto =
    req.headers.get("x-forwarded-proto") ?? req.nextUrl.protocol.replace(":", "");
  return proto === "https";
}
