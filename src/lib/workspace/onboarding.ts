import "server-only";

import type { User } from "@supabase/supabase-js";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { logError } from "@/lib/triage/logger";

/** Profiles have no insert policy: create the row with the service role. */
export async function ensureProfile(user: User): Promise<void> {
  const fullName =
    (typeof user.user_metadata?.full_name === "string" && user.user_metadata.full_name.trim()) ||
    user.email?.split("@")[0] ||
    "Guest";
  const { error } = await createServiceClient()
    .from("profiles")
    .upsert(
      { id: user.id, email: user.email ? user.email.toLowerCase() : null, full_name: fullName.slice(0, 100) },
      { onConflict: "id", ignoreDuplicates: true }
    );
  if (error) logError("ensure_profile", error, { userId: user.id });
}

/**
 * After email confirmation: create the workspace chosen at sign-up, unless
 * the user already belongs to one. Runs as the user (create_workspace checks
 * the email is confirmed and the session is not a guest).
 */
export async function createPendingWorkspace(user: User): Promise<string | null> {
  const name = user.user_metadata?.signup_workspace_name;
  const kind = user.user_metadata?.signup_workspace_kind;
  if (typeof name !== "string" || (kind !== "individual" && kind !== "company")) return null;

  const supabase = await createClient();
  const { count } = await supabase
    .from("memberships")
    .select("workspace_id", { count: "exact", head: true })
    .eq("user_id", user.id);
  if ((count ?? 0) > 0) return null;

  const { data: workspaceId, error } = await supabase.rpc("create_workspace", {
    p_name: name,
    p_kind: kind,
    p_display_name: typeof user.user_metadata?.full_name === "string" ? user.user_metadata.full_name : undefined,
  });
  if (error) {
    logError("create_pending_workspace", error, { userId: user.id });
    return null;
  }
  await supabase.auth.updateUser({ data: { signup_workspace_name: null, signup_workspace_kind: null } });
  return workspaceId;
}
