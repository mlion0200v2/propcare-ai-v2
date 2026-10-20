/**
 * Public base URL of the app, used in emails, tenant links and QR posters.
 * Tenant links live on the app's own domain (NEXT_PUBLIC_APP_URL), e.g.
 * https://propcare.birchwoodcorp.com.
 */
export function appUrl(path = ""): string {
  const base = (process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000").replace(/\/+$/, "");
  return `${base}${path.startsWith("/") || path === "" ? path : `/${path}`}`;
}

/** Only same-site relative paths are allowed as a redirect target. */
export function safeNextPath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return null;
  return value;
}
