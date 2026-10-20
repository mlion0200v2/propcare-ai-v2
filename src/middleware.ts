import { type NextRequest, NextResponse } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

// Routes that don't require authentication
const PUBLIC_ROUTES = ["/login", "/signup"];

// Routes only property managers may open. Pages under (manager) also enforce
// this in their layout, so a route missing here is still protected.
const MANAGER_ROUTES = ["/dashboard", "/tickets", "/tenants", "/analytics", "/vendors"];

function matchesRoute(pathname: string, route: string): boolean {
  return pathname === route || pathname.startsWith(`${route}/`);
}

export async function middleware(request: NextRequest) {
  // `role` is read from the profiles table, never from user_metadata.
  const { supabaseResponse, user, role } = await updateSession(request);
  const { pathname } = request.nextUrl;

  // Allow public routes
  if (PUBLIC_ROUTES.some((route) => pathname.startsWith(route))) {
    // If already logged in, redirect away from auth pages
    if (user) {
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

  // Protect manager routes
  if (MANAGER_ROUTES.some((route) => matchesRoute(pathname, route))) {
    if (role !== "manager") {
      return NextResponse.redirect(new URL("/submit", request.url));
    }
  }

  // Protect tenant routes
  if (matchesRoute(pathname, "/submit")) {
    if (role === "manager") {
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
