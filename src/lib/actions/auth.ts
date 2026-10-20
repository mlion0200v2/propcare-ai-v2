"use server";

import { redirect } from "next/navigation";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { signInSchema, signUpSchema } from "@/lib/utils/validation";

export type AuthState = {
  error: string | null;
};

/** Only same-site relative paths are allowed as a post-sign-in destination. */
function safeNextPath(value: FormDataEntryValue | null): string | null {
  if (typeof value !== "string") return null;
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return null;
  return value;
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
    return { error: parsed.error.message };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);

  if (error) {
    return { error: error.message };
  }

  // Workspace members go to their requests, everyone else to the tenant
  // area. The role comes from memberships (RLS), never user_metadata.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { count } = await supabase
    .from("memberships")
    .select("workspace_id", { count: "exact", head: true })
    .eq("user_id", user?.id ?? "");

  redirect(safeNextPath(formData.get("next")) ?? ((count ?? 0) > 0 ? "/dashboard" : "/submit"));
}

export async function signUp(
  _prev: AuthState,
  formData: FormData
): Promise<AuthState> {
  const raw = {
    email: formData.get("email") as string,
    password: formData.get("password") as string,
    full_name: formData.get("full_name") as string,
    role: formData.get("role") as string,
  };

  const parsed = signUpSchema.safeParse(raw);
  if (!parsed.success) {
    return { error: parsed.error.message };
  }

  const supabase = await createClient();
  const { data: authData, error: authError } = await supabase.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
    options: {
      data: {
        full_name: parsed.data.full_name,
        role: parsed.data.role,
      },
    },
  });

  if (authError) {
    return { error: authError.message };
  }

  if (!authData.user) {
    return { error: "Sign-up failed. Please try again." };
  }

  // Create profile via service client (no INSERT RLS policy on profiles).
  // Use upsert so duplicate signups (same auth user) don't fail on the
  // unique PK constraint — the profile is simply updated to match.
  const serviceClient = await createServiceClient();
  const { error: profileError } = await serviceClient
    .from("profiles")
    .upsert(
      {
        id: authData.user.id,
        email: parsed.data.email,
        full_name: parsed.data.full_name,
        role: parsed.data.role as "tenant" | "manager",
      },
      { onConflict: "id" }
    );

  if (profileError) {
    console.error("Profile upsert failed:", {
      message: profileError.message,
      code: profileError.code,
      details: profileError.details,
      hint: profileError.hint,
    });

    if (profileError.code === "23505") {
      if (profileError.message?.includes("profiles_email_key")) {
        return { error: "An account with this email already exists. Please sign in or reset your password." };
      }
      if (profileError.message?.includes("profiles_pkey")) {
        return { error: "This account is already registered. Please sign in." };
      }
    }

    return { error: "Account created but profile setup failed. Please contact support." };
  }

  redirect("/");
}

export async function signOut(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
