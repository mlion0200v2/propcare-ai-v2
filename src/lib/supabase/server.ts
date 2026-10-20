import "server-only";

import { createServerClient } from "@supabase/ssr";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import type { Database } from "./types";

export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // setAll is called from Server Components where cookies
            // cannot be set — this is expected and safe to ignore.
          }
        },
      },
    }
  );
}

/**
 * Admin client using the service role key — bypasses RLS. Use sparingly.
 *
 * Built with plain supabase-js and no cookie adapter: it must never pick up
 * (or write) the signed-in user's session, otherwise requests could run with
 * the user's JWT instead of the service role, or the service session could
 * leak into the user's cookies. The "server-only" import above makes any
 * attempt to bundle this module into client code a build error.
 */
export function createServiceClient() {
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set — cannot create service client");
  }

  return createSupabaseClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    serviceRoleKey,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    }
  );
}

/**
 * Read the signed-in user's role from `profiles` (server-side, RLS-scoped to
 * their own row). Never trust `user_metadata.role` — users can edit their own
 * metadata with `supabase.auth.updateUser()`.
 */
export async function getProfileRole(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string
): Promise<"tenant" | "manager" | null> {
  const { data } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", userId)
    .maybeSingle();
  return data?.role ?? null;
}
