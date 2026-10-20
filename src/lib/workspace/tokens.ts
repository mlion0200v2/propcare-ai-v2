import { createHash, randomBytes } from "node:crypto";

/** URL-safe random token (default 192 bits) for invitation links. */
export function generateToken(bytes = 24): string {
  return randomBytes(bytes).toString("base64url");
}

/** New unit link token: 128 random bits, hex (same shape as the DB default). */
export function generateIntakeToken(): string {
  return randomBytes(16).toString("hex");
}

/** sha256 hex — matches `encode(sha256(convert_to(token, 'UTF8')), 'hex')` in SQL. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Dollars entered in a form → integer cents (null when invalid). */
export function dollarsToCents(input: string): number | null {
  const cleaned = input.replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const cents = Math.round(Number(cleaned) * 100);
  return Number.isSafeInteger(cents) ? cents : null;
}

export function formatCents(cents: number): string {
  return (cents / 100).toLocaleString("en-CA", { style: "currency", currency: "CAD", maximumFractionDigits: cents % 100 === 0 ? 0 : 2 });
}
