import { NextRequest, NextResponse } from "next/server";
import { connectToDatabase } from "@/lib/mongodb";
import {
  AUTH_COOKIE,
  authEnabled,
  authMisconfigured,
  isAuthed,
  issueSessionToken,
  misconfiguredResponse,
  passwordMatches,
  rejectCrossSite,
  useSecureCookie,
} from "@/lib/auth";
import {
  clearLoginFailures,
  clientIp,
  loginLockState,
  recordLoginFailure,
} from "@/lib/loginGuard";
import { noStore } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/auth — session status (used by the client to decide locked vs unlocked)
export async function GET(req: NextRequest) {
  return noStore(
    NextResponse.json({
      authRequired: authEnabled() || authMisconfigured(),
      authed: isAuthed(req),
      misconfigured: authMisconfigured(),
    })
  );
}

function lockedResponse(retryAfterSec: number) {
  const minutes = Math.max(1, Math.ceil(retryAfterSec / 60));
  return NextResponse.json(
    { error: `Too many failed attempts. Try again in ${minutes} minute(s).` },
    { status: 429, headers: { "Retry-After": String(retryAfterSec) } }
  );
}

// POST /api/auth — exchange the admin password for a signed session cookie
export async function POST(req: NextRequest) {
  if (authMisconfigured()) return misconfiguredResponse();

  const crossSite = rejectCrossSite(req);
  if (crossSite) return crossSite;

  if (!authEnabled()) {
    return NextResponse.json({ ok: true, authRequired: false, authed: true });
  }

  const ip = clientIp(req);
  await connectToDatabase();

  // Check the lockout before looking at the password at all.
  const before = await loginLockState(ip);
  if (before.locked) return lockedResponse(before.retryAfterSec);

  let body: { password?: string } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!passwordMatches(body.password ?? "")) {
    const after = await recordLoginFailure(ip);
    if (after.locked) return lockedResponse(after.retryAfterSec);
    return NextResponse.json({ error: "Incorrect password" }, { status: 401 });
  }

  await clearLoginFailures(ip);

  const res = NextResponse.json({ ok: true, authRequired: true, authed: true });
  res.cookies.set(AUTH_COOKIE, issueSessionToken(), {
    httpOnly: true,
    sameSite: "lax",
    secure: useSecureCookie(req),
    path: "/",
    // Persist so the session survives a browser restart (the token itself also
    // carries a hard 7-day expiry enforced server-side).
    maxAge: 7 * 24 * 60 * 60,
  });
  return res;
}

// DELETE /api/auth — lock again (log out)
export async function DELETE(req: NextRequest) {
  const res = NextResponse.json({ ok: true, authed: false });
  res.cookies.set(AUTH_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: useSecureCookie(req),
    path: "/",
    maxAge: 0,
  });
  return res;
}
