/**
 * GET /api/demo/cleanup — delete try-mode sandboxes older than 24 hours
 * (workspace + all its rows + the demo auth users).
 *
 * Call hourly from a scheduler (Cloud Scheduler on Cloud Run) with
 * `Authorization: Bearer $CRON_SECRET`. Without CRON_SECRET the route
 * refuses to run.
 */
import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { cleanupExpiredSandboxes } from "@/lib/demo/server";
import { logError } from "@/lib/logger";

export const dynamic = "force-dynamic";

function authorized(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 16) return false;
  const given = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export async function GET(request: NextRequest) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const removed = await cleanupExpiredSandboxes();
    return NextResponse.json({ removed });
  } catch (err) {
    logError("demo_cleanup", err);
    return NextResponse.json({ error: "cleanup_failed" }, { status: 500 });
  }
}
