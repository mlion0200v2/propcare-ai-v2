/**
 * GET /auth/confirm — landing for Supabase email links (sign-up
 * confirmation, tenant magic links, email changes).
 *
 * Accepts either the PKCE `code` (default Supabase templates via
 * emailRedirectTo) or `token_hash` + `type` (custom templates). After the
 * session is established it makes sure a profile exists and, for a fresh
 * landlord/manager sign-up, creates their workspace.
 */
import { NextResponse, type NextRequest } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { safeNextPath } from "@/lib/app-url";
import { createPendingWorkspace, ensureProfile } from "@/lib/workspace/onboarding";
import { claimTenancies } from "@/lib/intake/server";
import { logError } from "@/lib/logger";

const OTP_TYPES: EmailOtpType[] = ["signup", "invite", "magiclink", "recovery", "email_change", "email"];

export async function GET(request: NextRequest) {
  const url = request.nextUrl;
  const next = safeNextPath(url.searchParams.get("next")) ?? "/";
  const code = url.searchParams.get("code");
  const tokenHash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type") as EmailOtpType | null;

  const supabase = await createClient();
  let ok = false;
  if (code) {
    ok = !(await supabase.auth.exchangeCodeForSession(code)).error;
  } else if (tokenHash && type && OTP_TYPES.includes(type)) {
    ok = !(await supabase.auth.verifyOtp({ type, token_hash: tokenHash })).error;
  }

  if (!ok) {
    return NextResponse.redirect(new URL("/login?error=link", request.url));
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user) {
    try {
      await ensureProfile(user);
      // Tenant who kept an account: attach the tenancies they proved.
      await claimTenancies(user);
      if (!next.startsWith("/invite/") && next !== "/my-requests") await createPendingWorkspace(user);
    } catch (err) {
      logError("auth_confirm_onboarding", err, { userId: user.id });
    }
  }

  return NextResponse.redirect(new URL(next, request.url));
}
