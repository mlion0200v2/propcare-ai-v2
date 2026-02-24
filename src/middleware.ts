import { type NextRequest, NextResponse } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

// Routes that don't require authentication
const PUBLIC_ROUTES = ["/login", "/signup"];

export async function middleware(request: NextRequest) {
  const { supabaseResponse, user } = await updateSession(request);
  const { pathname } = request.nextUrl;

  // Allow public routes
  if (PUBLIC_ROUTES.some((route) => pathname.startsWith(route))) {
    // If already logged in, redirect away from auth pages
    if (user) {
      const role = user.user_metadata?.role as string | undefined;
      const redirect = role === "manager" ? "/dashboard" : "/submit";
      return NextResponse.redirect(new URL(redirect, request.url));
    }
    return supabaseResponse;
  }

  // All other routes require authentication
  if (!user) {
    const redirectUrl = new URL("/login", request.url);
    redirectUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(redirectUrl);
  }

  const role = user.user_metadata?.role as string | undefined;

  // Protect manager routes
  if (pathname.startsWith("/dashboard") || pathname.startsWith("/tickets") || pathname.startsWith("/analytics") || pathname.startsWith("/vendors")) {
    if (role !== "manager") {
      return NextResponse.redirect(new URL("/submit", request.url));
    }
  }

  // Protect tenant routes
  if (pathname.startsWith("/submit")) {
    if (role !== "tenant") {
      return NextResponse.redirect(new URL("/dashboard", request.url));
    }
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
