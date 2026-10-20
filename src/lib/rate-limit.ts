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

// ── Tenant link (/r/<token>) — keyed by client IP, destination or token ──

/** Opening tenant links, per IP (also slows token guessing). */
export const intakeLinkLimiter = createRateLimiter([
  { limit: 60, windowMs: 10 * MINUTE },
  { limit: 300, windowMs: 24 * HOUR },
]);

/** Code sends per destination (one inbox or phone). */
export const intakeCodeDestinationLimiter = createRateLimiter([
  { limit: 3, windowMs: 10 * MINUTE },
  { limit: 10, windowMs: 24 * HOUR },
]);

/** Code sends per IP and per unit link, so one link can't flood anyone. */
export const intakeCodeIpLimiter = createRateLimiter([
  { limit: 10, windowMs: HOUR },
  { limit: 30, windowMs: 24 * HOUR },
]);
export const intakeCodeLinkLimiter = createRateLimiter([
  { limit: 20, windowMs: HOUR },
  { limit: 60, windowMs: 24 * HOUR },
]);

/** Code verification attempts per IP. */
export const intakeVerifyLimiter = createRateLimiter([{ limit: 20, windowMs: 10 * MINUTE }]);

/** Tenant sign-in / account links, per IP. */
export const magicLinkLimiter = createRateLimiter([
  { limit: 5, windowMs: 10 * MINUTE },
  { limit: 20, windowMs: 24 * HOUR },
]);

/** Ticket comments and replies, per user (each "to tenant" comment sends an email). */
export const commentLimiter = createRateLimiter([
  { limit: 30, windowMs: 10 * MINUTE },
  { limit: 200, windowMs: 24 * HOUR },
]);

/** Try-mode sandboxes created per IP (each creates 4 demo users and sample data). */
export const demoCreateLimiter = createRateLimiter([
  { limit: 5, windowMs: HOUR },
  { limit: 20, windowMs: 24 * HOUR },
]);

/** Vendor quote submissions per IP. */
export const vendorQuoteLimiter = createRateLimiter([{ limit: 10, windowMs: HOUR }]);
