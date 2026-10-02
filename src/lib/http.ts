import { NextResponse } from "next/server";

/**
 * Mark a response as private and uncacheable. Endpoints whose body depends on
 * the session cookie must never be stored by a shared cache.
 */
export function noStore<T>(res: NextResponse<T>): NextResponse<T> {
  res.headers.set("Cache-Control", "private, no-store, max-age=0, must-revalidate");
  res.headers.set("Vary", "Cookie");
  return res;
}
