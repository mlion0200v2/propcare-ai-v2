import "server-only";

import { headers } from "next/headers";

/** Best-effort client IP for rate limiting (first X-Forwarded-For hop). */
export async function clientIp(): Promise<string> {
  const h = await headers();
  const forwarded = h.get("x-forwarded-for");
  return forwarded?.split(",")[0]?.trim() || h.get("x-real-ip") || "unknown";
}
