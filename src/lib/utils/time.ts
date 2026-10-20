/**
 * Times are entered and shown in the workspace's local time. One zone for
 * now (APP_TIME_ZONE, default America/Vancouver); per-workspace zones can
 * come later.
 */
export function appTimeZone(): string {
  return process.env.APP_TIME_ZONE || "America/Vancouver";
}

function offsetMs(timestamp: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(timestamp));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - timestamp;
}

/** "2026-10-21T09:00" in `timeZone` → the instant (UTC). Null if malformed. */
export function zonedLocalToUtc(local: string, timeZone: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!m) return null;
  const naive = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  let utc = naive - offsetMs(naive, timeZone);
  const second = offsetMs(utc, timeZone);
  if (naive - second !== utc) utc = naive - second; // across a DST change
  return new Date(utc);
}

/** Instant → "YYYY-MM-DDTHH:mm" in `timeZone` (for datetime-local inputs). */
export function utcToZonedLocal(iso: string, timeZone: string): string {
  const t = new Date(iso).getTime();
  const local = new Date(t + offsetMs(t, timeZone));
  return local.toISOString().slice(0, 16);
}

export function formatDateTime(iso: string, timeZone = appTimeZone()): string {
  return new Date(iso).toLocaleString("en-CA", { timeZone, dateStyle: "medium", timeStyle: "short" });
}
