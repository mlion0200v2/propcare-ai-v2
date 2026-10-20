"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import {
  ACTIVE_WORKSPACE_COOKIE,
  getMemberships,
  getSessionUser,
  requireAdmin,
  requireTeam,
} from "@/lib/workspace/server";
import { ensureProfile } from "@/lib/workspace/onboarding";
import { dollarsToCents, generateToken, hashToken } from "@/lib/workspace/tokens";
import {
  inviteSchema,
  workspacePropertySchema,
  workspaceSettingsSchema,
  workspaceUnitSchema,
} from "@/lib/utils/validation";
import { inviteLimiter } from "@/lib/rate-limit";
import { appUrl } from "@/lib/app-url";
import { sendEmail } from "@/lib/email/mailer";
import { buildInvitationEmail } from "@/lib/email/templates";
import { logError } from "@/lib/triage/logger";

export type FormState = { error: string | null; ok?: string | null };

const INVITE_DAYS = 14;

function firstIssue(error: { issues: { message: string }[] }): string {
  return error.issues[0]?.message ?? "Please check the form";
}

async function setActiveCookie(workspaceId: string) {
  (await cookies()).set(ACTIVE_WORKSPACE_COOKIE, workspaceId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
}

// ── Workspaces ──

export async function switchWorkspace(formData: FormData): Promise<void> {
  const wanted = String(formData.get("workspace_id") ?? "");
  const memberships = await getMemberships();
  if (memberships.some((m) => m.workspaceId === wanted)) await setActiveCookie(wanted);
  redirect("/dashboard");
}

/** For a confirmed user without a workspace (e.g. confirmation link opened elsewhere). */
export async function createWorkspace(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await getSessionUser();
  if (!user || user.is_anonymous) redirect("/login");
  const name = String(formData.get("workspace_name") ?? "").trim();
  const kind = formData.get("workspace_kind");
  if (!name || name.length > 120) return { error: "Workspace name is required" };
  if (kind !== "individual" && kind !== "company") return { error: "Choose which describes you" };

  await ensureProfile(user);
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("create_workspace", { p_name: name, p_kind: kind });
  if (error || !data) return { error: error?.message ?? "Could not create the workspace" };
  await setActiveCookie(data);
  redirect("/homes?welcome=1");
}

export async function updateWorkspaceSettings(_prev: FormState, formData: FormData): Promise<FormState> {
  const membership = await requireAdmin();
  const parsed = workspaceSettingsSchema.safeParse({
    name: formData.get("name"),
    approval_limit: formData.get("approval_limit"),
  });
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const cents = dollarsToCents(parsed.data.approval_limit);
  if (cents === null) return { error: "Enter the approval limit in dollars, e.g. 300" };

  const supabase = await createClient();
  const { error } = await supabase
    .from("workspaces")
    .update({ name: parsed.data.name, approval_limit_cents: cents })
    .eq("id", membership.workspaceId);
  if (error) return { error: "Could not save settings" };
  revalidatePath("/", "layout");
  return { error: null, ok: "Saved" };
}

// ── Homes and units ──

export async function createProperty(_prev: FormState, formData: FormData): Promise<FormState> {
  const membership = await requireTeam();
  const parsed = workspacePropertySchema.safeParse({
    address_line1: formData.get("address_line1"),
    address_line2: formData.get("address_line2") || undefined,
    city: formData.get("city"),
    province: formData.get("province"),
    postal_code: formData.get("postal_code"),
    property_type: formData.get("property_type"),
  });
  if (!parsed.success) return { error: firstIssue(parsed.error) };

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("properties")
    .insert({
      workspace_id: membership.workspaceId,
      address_line1: parsed.data.address_line1,
      address_line2: parsed.data.address_line2 ?? null,
      city: parsed.data.city,
      // Legacy column names: state = province, zip = postal code.
      state: parsed.data.province,
      zip: parsed.data.postal_code.toUpperCase(),
      property_type: parsed.data.property_type,
    })
    .select("id")
    .single();
  if (error || !data) return { error: "Could not add the home" };

  // A single-family home gets its one unit straight away.
  if (parsed.data.property_type === "single_family") {
    await supabase.from("units").insert({ property_id: data.id, unit_number: null });
  }
  redirect(`/homes/${data.id}`);
}

export async function createUnit(_prev: FormState, formData: FormData): Promise<FormState> {
  await requireTeam();
  const parsed = workspaceUnitSchema.safeParse({
    property_id: formData.get("property_id"),
    unit_number: String(formData.get("unit_number") ?? "").trim() || undefined,
  });
  if (!parsed.success) return { error: firstIssue(parsed.error) };

  const supabase = await createClient();
  // RLS: the property must be in one of the caller's team workspaces.
  const { error } = await supabase
    .from("units")
    .insert({ property_id: parsed.data.property_id, unit_number: parsed.data.unit_number ?? null });
  if (error) return { error: "Could not add the unit" };
  revalidatePath(`/homes/${parsed.data.property_id}`);
  return { error: null, ok: "Unit added" };
}

// ── Team and owners ──

export async function inviteMember(_prev: FormState, formData: FormData): Promise<FormState> {
  const membership = await requireAdmin();
  const parsed = inviteSchema.safeParse({
    email: formData.get("email"),
    role: formData.get("role"),
    property_ids: formData.getAll("property_ids").map(String),
  });
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  if (parsed.data.role === "owner" && membership.kind !== "company") {
    return { error: "Owners can only be invited to a property-management workspace" };
  }
  if (parsed.data.role === "owner" && parsed.data.property_ids.length === 0) {
    return { error: "Choose the homes this owner will see" };
  }
  const limit = inviteLimiter.check(membership.userId);
  if (!limit.allowed) return { error: "Too many invitations. Please try again later." };

  const token = generateToken();
  const supabase = await createClient();
  const { error } = await supabase.from("invitations").insert({
    workspace_id: membership.workspaceId,
    email: parsed.data.email,
    role: parsed.data.role,
    property_ids: parsed.data.role === "owner" ? parsed.data.property_ids : [],
    token_hash: hashToken(token),
    expires_at: new Date(Date.now() + INVITE_DAYS * 86_400_000).toISOString(),
  });
  if (error) {
    logError("invite_insert", error, { workspaceId: membership.workspaceId });
    return { error: "Could not create the invitation" };
  }

  const user = await getSessionUser();
  const inviterName =
    (typeof user?.user_metadata?.full_name === "string" && user.user_metadata.full_name) || "Your team";
  const email = buildInvitationEmail({
    workspaceName: membership.workspaceName,
    inviterName,
    role: parsed.data.role,
    link: appUrl(`/invite/${token}`),
    expiresInDays: INVITE_DAYS,
  });
  const sent = await sendEmail({ to: parsed.data.email, ...email, kind: "invitation" });
  revalidatePath("/team");
  if (!sent.success) return { error: "Invitation saved, but the email could not be sent. Revoke it and try again." };
  return { error: null, ok: `Invitation sent to ${parsed.data.email}` };
}

export async function revokeInvitation(formData: FormData): Promise<void> {
  const membership = await requireAdmin();
  const supabase = await createClient();
  await supabase
    .from("invitations")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", String(formData.get("invitation_id")))
    .eq("workspace_id", membership.workspaceId);
  revalidatePath("/team");
}

export async function changeMemberRole(formData: FormData): Promise<void> {
  const membership = await requireAdmin();
  const role = formData.get("role");
  if (role !== "admin" && role !== "manager" && role !== "owner") return;
  const supabase = await createClient();
  const { error } = await supabase.rpc("set_member_role", {
    p_workspace: membership.workspaceId,
    p_user: String(formData.get("user_id")),
    p_role: role,
  });
  if (error) logError("set_member_role", error, { workspaceId: membership.workspaceId });
  revalidatePath("/team");
}

export async function removeMember(formData: FormData): Promise<void> {
  const membership = await requireAdmin();
  const supabase = await createClient();
  const { error } = await supabase.rpc("remove_member", {
    p_workspace: membership.workspaceId,
    p_user: String(formData.get("user_id")),
  });
  if (error) logError("remove_member", error, { workspaceId: membership.workspaceId });
  revalidatePath("/team");
}

/** Replace the set of properties an owner can see. */
export async function setOwnerProperties(formData: FormData): Promise<void> {
  const membership = await requireAdmin();
  const userId = String(formData.get("user_id"));
  const wanted = new Set(formData.getAll("property_ids").map(String));
  const supabase = await createClient();
  const { data: current } = await supabase
    .from("owner_property_access")
    .select("property_id")
    .eq("workspace_id", membership.workspaceId)
    .eq("user_id", userId);
  const have = new Set((current ?? []).map((r) => r.property_id));
  const add = [...wanted].filter((id) => !have.has(id));
  const remove = [...have].filter((id) => !wanted.has(id));
  if (add.length > 0) {
    await supabase
      .from("owner_property_access")
      .insert(add.map((property_id) => ({ workspace_id: membership.workspaceId, user_id: userId, property_id })));
  }
  if (remove.length > 0) {
    await supabase
      .from("owner_property_access")
      .delete()
      .eq("workspace_id", membership.workspaceId)
      .eq("user_id", userId)
      .in("property_id", remove);
  }
  revalidatePath("/team");
}

// ── Invitations (invitee side) ──

export async function acceptInvitation(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await getSessionUser();
  if (!user || user.is_anonymous) redirect("/login");
  await ensureProfile(user);
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("accept_invitation", {
    p_token: String(formData.get("token") ?? ""),
    p_display_name:
      typeof user.user_metadata?.full_name === "string" ? user.user_metadata.full_name : undefined,
  });
  if (error || !data) return { error: error?.message ?? "This invitation is no longer valid" };
  await setActiveCookie(data);
  redirect("/dashboard");
}
