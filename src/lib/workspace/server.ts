import "server-only";

import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { Database } from "@/lib/supabase/database-generated";

export type MembershipRole = Database["public"]["Enums"]["membership_role"];
export type WorkspaceKind = Database["public"]["Enums"]["workspace_kind"];

export interface WorkspaceMembership {
  workspaceId: string;
  workspaceName: string;
  kind: WorkspaceKind;
  approvalLimitCents: number;
  role: MembershipRole;
}

/** Cookie holding the workspace the user last opened (validated on every read). */
export const ACTIVE_WORKSPACE_COOKIE = "pc_ws";

export const TEAM_ROLES: readonly MembershipRole[] = ["admin", "manager"];

export function isTeamRole(role: MembershipRole): boolean {
  return TEAM_ROLES.includes(role);
}

/** The signed-in user, verified with Supabase Auth (not just the cookie). */
export const getSessionUser = cache(async () => {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
});

/**
 * The caller's memberships, read through RLS. This (not user_metadata,
 * not profiles.role) is the only source of a user's role.
 */
export const getMemberships = cache(async (): Promise<WorkspaceMembership[]> => {
  const user = await getSessionUser();
  if (!user) return [];
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("memberships")
    .select("role, workspace_id, workspaces!inner(name, kind, approval_limit_cents)")
    .eq("user_id", user.id)
    .order("created_at", { ascending: true });
  if (error || !data) return [];
  return data.map((m) => ({
    workspaceId: m.workspace_id,
    workspaceName: m.workspaces.name,
    kind: m.workspaces.kind,
    approvalLimitCents: m.workspaces.approval_limit_cents,
    role: m.role,
  }));
});

/** The workspace selected by cookie, falling back to the first membership. */
export const getActiveMembership = cache(async (): Promise<WorkspaceMembership | null> => {
  const memberships = await getMemberships();
  if (memberships.length === 0) return null;
  const store = await cookies();
  const wanted = store.get(ACTIVE_WORKSPACE_COOKIE)?.value;
  return memberships.find((m) => m.workspaceId === wanted) ?? memberships[0];
});

/** Where a signed-in user belongs after sign-in. */
export async function homePathForUser(): Promise<string> {
  const membership = await getActiveMembership();
  if (membership) return "/dashboard";
  const user = await getSessionUser();
  if (!user || user.is_anonymous) return "/submit";
  // Tenants with an account hold a tenancy; anyone else confirmed their
  // email without a workspace (e.g. opened the link on another device).
  const supabase = await createClient();
  const { count } = await supabase
    .from("tenancies")
    .select("id", { count: "exact", head: true })
    .eq("tenant_user_id", user.id);
  return (count ?? 0) > 0 ? "/submit" : "/welcome";
}

/**
 * Server-side guard for workspace pages. Redirects to sign-in when signed
 * out, and to the tenant area when the user has no membership with one of
 * the allowed roles. RLS still enforces every read and write.
 */
export async function requireMembership(
  roles: readonly MembershipRole[] = ["admin", "manager", "owner"]
): Promise<WorkspaceMembership & { userId: string }> {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const membership = await getActiveMembership();
  if (!membership) redirect("/submit");
  if (!roles.includes(membership.role)) redirect("/dashboard");
  return { ...membership, userId: user.id };
}

export function requireTeam() {
  return requireMembership(TEAM_ROLES);
}

export function requireAdmin() {
  return requireMembership(["admin"]);
}
