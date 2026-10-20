"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { inviteSignUpSchema, signInSchema, signUpSchema } from "@/lib/utils/validation";
import { appUrl, safeNextPath } from "@/lib/app-url";

export type AuthState = {
  error: string | null;
  /** Set after sign-up: the address the confirmation email went to. */
  sentTo?: string | null;
};

function firstIssue(error: { issues: { message: string }[] }): string {
  return error.issues[0]?.message ?? "Please check the form";
}

export async function signIn(
  _prev: AuthState,
  formData: FormData
): Promise<AuthState> {
  const raw = {
    email: formData.get("email") as string,
    password: formData.get("password") as string,
  };

  const parsed = signInSchema.safeParse(raw);
  if (!parsed.success) {
    return { error: firstIssue(parsed.error) };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);

  if (error) {
    return { error: error.message };
  }

  // "/" decides between workspace pages and the tenant area from the
  // memberships table (never from user_metadata).
  redirect(safeNextPath(formData.get("next")) ?? "/");
}

/**
 * Landlord / property-manager sign-up. The workspace is created only after
 * the email is confirmed (/auth/confirm), by the create_workspace RPC, with
 * the user as its admin. The chosen name and kind ride along in
 * user_metadata; they never grant a role by themselves.
 */
export async function signUp(
  _prev: AuthState,
  formData: FormData
): Promise<AuthState> {
  const inviteToken = formData.get("invite");
  const isInvite = typeof inviteToken === "string" && inviteToken.length > 0;

  const base = {
    email: formData.get("email"),
    password: formData.get("password"),
    full_name: formData.get("full_name"),
    accept_terms: formData.get("accept_terms") ?? undefined,
  };

  let metadata: Record<string, string>;
  let email: string;
  let password: string;
  if (isInvite) {
    const parsed = inviteSignUpSchema.safeParse(base);
    if (!parsed.success) return { error: firstIssue(parsed.error) };
    ({ email, password } = parsed.data);
    metadata = { full_name: parsed.data.full_name };
  } else {
    const parsed = signUpSchema.safeParse({
      ...base,
      workspace_kind: formData.get("workspace_kind"),
      workspace_name: formData.get("workspace_name"),
    });
    if (!parsed.success) return { error: firstIssue(parsed.error) };
    ({ email, password } = parsed.data);
    metadata = {
      full_name: parsed.data.full_name,
      signup_workspace_name: parsed.data.workspace_name,
      signup_workspace_kind: parsed.data.workspace_kind,
    };
  }

  const next = isInvite ? `/invite/${encodeURIComponent(inviteToken)}` : "/homes?welcome=1";
  const supabase = await createClient();
  const { error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: metadata,
      emailRedirectTo: appUrl(`/auth/confirm?next=${encodeURIComponent(next)}`),
    },
  });

  if (error) {
    return { error: error.message };
  }

  // Same answer whether or not the address already has an account, so the
  // form can't be used to discover who is registered.
  return { error: null, sentTo: email };
}

export async function signOut(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
