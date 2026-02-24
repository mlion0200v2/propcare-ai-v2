"use server";

import { redirect } from "next/navigation";
import { createClient, createServiceClient } from "@/lib/supabase/server";
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
    return { error: parsed.error.message };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);

  if (error) {
    return { error: error.message };
  }

  // Get user role for redirect
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const role = user?.user_metadata?.role as string | undefined;

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

  // Create profile via service client (no INSERT RLS policy on profiles)
  const serviceClient = await createServiceClient();
  const { error: profileError } = await serviceClient
    .from("profiles")
    .insert({
      id: authData.user.id,
      email: parsed.data.email,
      full_name: parsed.data.full_name,
      role: parsed.data.role as "tenant" | "manager",
    });

  if (profileError) {
    return { error: "Account created but profile setup failed. Contact support." };
  }

  redirect(parsed.data.role === "manager" ? "/dashboard" : "/submit");
}

export async function signOut(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
