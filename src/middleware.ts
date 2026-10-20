import { type NextRequest, NextResponse } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

// Sign-in pages: signed-in users are sent home instead.
const AUTH_ROUTES = ["/login", "/signup"];

// Reachable without signing in. /r/<token> is the tenant link, /auth/* the
// email-confirmation callback, /invite/<token> an invitation landing page,
// /v/<token> a vendor's work order, /try the demo (DEMO_MODE=1).
const PUBLIC_PREFIXES = ["/r/", "/auth/", "/invite/", "/v/", "/try"];

/**
 * Middleware only answers "is anyone signed in?". Which workspace and role a
 * user has is checked server-side in the layouts and pages (memberships
 * table, via RLS); user_metadata is user-editable and never trusted for that.
 */
export async function middleware(request: NextRequest) {
  const { supabaseResponse, user } = await updateSession(request);
  const { pathname } = request.nextUrl;

  if (AUTH_ROUTES.some((route) => pathname.startsWith(route))) {
    // Guest (anonymous) tenant sessions may still sign in or sign up properly.
    if (user && !user.is_anonymous) {
      return NextResponse.redirect(new URL("/", request.url));
    }
    return supabaseResponse;
  }

  if (PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    return supabaseResponse;
  }

  if (!user) {
    const redirectUrl = new URL("/login", request.url);
    redirectUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(redirectUrl);
  }

  return supabaseResponse;
}

export const config = {
  matcher: [
    /*
     * Match all routes except:
     * - _next/static (static files)
     * - _next/image (image optimization)
     * - favicon.ico, sitemap, robots
     * - API routes (handled by their own auth)
     */
    "/((?!_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt|api/).*)",
  ],
};
