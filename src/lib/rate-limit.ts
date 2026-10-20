/**
 * Per-user sliding-window rate limiter.
 *
 * In-memory: limits apply per server instance. That bounds abuse (LLM/OpenAI
 * cost, storage uploads) from a single user hammering one instance; for a
 * multi-instance deployment back it with a shared store (e.g. Redis/Upstash
 * or a Supabase table) using the same `check()` contract.
 */

export interface RateLimitRule {
  /** Maximum requests allowed within the window. */
  limit: number;
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until the next request would be allowed (0 when allowed). */
  retryAfterSeconds: number;
}

export interface RateLimiter {
  check(key: string): RateLimitResult;
}

const MAX_TRACKED_KEYS = 10_000;

export function createRateLimiter(
  rules: RateLimitRule[],
  now: () => number = () => Date.now()
): RateLimiter {
  const longestWindow = Math.max(...rules.map((r) => r.windowMs));
  const hits = new Map<string, number[]>();

  function prune(t: number) {
    for (const [key, times] of hits) {
      const recent = times.filter((x) => t - x < longestWindow);
      if (recent.length === 0) hits.delete(key);
      else hits.set(key, recent);
    }
  }

  return {
    check(key: string): RateLimitResult {
      const t = now();
      if (hits.size > MAX_TRACKED_KEYS) prune(t);

      const times = (hits.get(key) ?? []).filter((x) => t - x < longestWindow);
      let retryAfterMs = 0;
      for (const rule of rules) {
        const inWindow = times.filter((x) => t - x < rule.windowMs);
        if (inWindow.length >= rule.limit) {
          // Oldest hit in this window must expire before another is allowed.
          const oldest = inWindow[inWindow.length - rule.limit];
          retryAfterMs = Math.max(retryAfterMs, rule.windowMs - (t - oldest));
        }
      }

      if (retryAfterMs > 0) {
        hits.set(key, times);
        return { allowed: false, retryAfterSeconds: Math.ceil(retryAfterMs / 1000) };
      }

      times.push(t);
      hits.set(key, times);
      return { allowed: true, retryAfterSeconds: 0 };
    },
  };
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Triage chat: each message can trigger OpenAI calls. */
export const triageChatLimiter = createRateLimiter([
  { limit: 20, windowMs: MINUTE },
  { limit: 200, windowMs: HOUR },
]);

/** Media uploads: a ticket holds at most 5 photos + 1 video. */
export const triageMediaLimiter = createRateLimiter([
  { limit: 10, windowMs: 10 * MINUTE },
  { limit: 40, windowMs: HOUR },
]);

/** Invitation emails sent by one admin. */
export const inviteLimiter = createRateLimiter([
  { limit: 20, windowMs: HOUR },
  { limit: 60, windowMs: 24 * HOUR },
]);
