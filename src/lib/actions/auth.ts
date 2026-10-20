"use server";

import { redirect } from "next/navigation";
import { createClient, createServiceClient, getProfileRole } from "@/lib/supabase/server";
import { signInSchema, signUpSchema } from "@/lib/utils/validation";

export type AuthState = {
  error: string | null;
};

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
    return { error: parsed.error.issues[0]?.message ?? "Invalid sign-in details" };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);

  if (error) {
    return { error: error.message };
  }

  // Get user role for redirect — from profiles, never user_metadata
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const role = user ? await getProfileRole(supabase, user.id) : null;

  redirect(role === "manager" ? "/dashboard" : "/submit");
}

export async function signUp(
  _prev: AuthState,
  formData: FormData
): Promise<AuthState> {
  const raw = {
    email: formData.get("email") as string,
    password: formData.get("password") as string,
    full_name: formData.get("full_name") as string,
  };

  // Any "role" field in the submitted form is ignored: public sign-up only
  // ever creates tenants. Managers are provisioned by an admin.
  const parsed = signUpSchema.safeParse(raw);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid sign-up details" };
  }

  const supabase = await createClient();
  const { data: authData, error: authError } = await supabase.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
    options: {
      data: {
        full_name: parsed.data.full_name,
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
  // ignoreDuplicates: a repeat sign-up for an existing auth user must never
  // modify that profile (e.g. reset a manager's role or rename them).
  const serviceClient = createServiceClient();
  const { error: profileError } = await serviceClient
    .from("profiles")
    .upsert(
      {
        id: authData.user.id,
        email: parsed.data.email,
        full_name: parsed.data.full_name,
        role: "tenant",
      },
      { onConflict: "id", ignoreDuplicates: true }
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

  redirect("/submit");
}

export async function signOut(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
