/**
 * One-time codes for the tenant link (/r/<token>). Pure helpers; the secret
 * comes from INTAKE_CODE_SECRET.
 */
import { createHmac, randomInt, timingSafeEqual } from "node:crypto";

export type CodeChannel = "email" | "sms";

export const CODE_TTL_MS = 10 * 60_000;
export const MAX_CODE_ATTEMPTS = 5;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** "jamie@example.com" → email; "604-555-0142" → sms (E.164, North America default). */
export function parseContact(input: string): { channel: CodeChannel; destination: string } | null {
  const value = input.trim();
  if (value.length === 0 || value.length > 254) return null;
  if (value.includes("@")) {
    const email = value.toLowerCase();
    return EMAIL_RE.test(email) ? { channel: "email", destination: email } : null;
  }
  const digits = value.replace(/[\s\-().]/g, "");
  if (!/^\+?\d{10,15}$/.test(digits)) return null;
  if (digits.startsWith("+")) return { channel: "sms", destination: digits };
  if (digits.length === 10) return { channel: "sms", destination: `+1${digits}` };
  if (digits.length === 11 && digits.startsWith("1")) return { channel: "sms", destination: `+${digits}` };
  return null;
}

export function maskDestination(channel: CodeChannel, destination: string): string {
  if (channel === "email") {
    const [local, domain] = destination.split("@");
    return `${local.slice(0, 1)}${"•".repeat(Math.max(local.length - 1, 2))}@${domain}`;
  }
  return `•••-•••-${destination.slice(-4)}`;
}

export function generateCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

function secret(): string {
  const value = process.env.INTAKE_CODE_SECRET;
  if (value && value.length >= 32) return value;
  if (process.env.NODE_ENV === "production") {
    throw new Error("INTAKE_CODE_SECRET must be set (32+ characters)");
  }
  return "dev-only-intake-code-secret-do-not-use-in-prod";
}

/** Bound to the unit and destination, so a code can't be replayed elsewhere. */
export function hashCode(code: string, unitId: string, destination: string): string {
  return createHmac("sha256", secret()).update(`${unitId}|${destination}|${code}`).digest("hex");
}

export function codeMatches(code: string, unitId: string, destination: string, storedHash: string): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const a = Buffer.from(hashCode(code, unitId, destination), "hex");
  const b = Buffer.from(storedHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
