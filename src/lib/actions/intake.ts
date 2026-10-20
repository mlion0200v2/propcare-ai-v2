"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { appUrl } from "@/lib/app-url";
import { clientIp } from "@/lib/request-ip";
import {
  intakeCodeDestinationLimiter,
  intakeCodeIpLimiter,
  intakeCodeLinkLimiter,
  intakeVerifyLimiter,
  magicLinkLimiter,
} from "@/lib/rate-limit";
import {
  CODE_TTL_MS,
  MAX_CODE_ATTEMPTS,
  codeMatches,
  generateCode,
  hashCode,
  maskDestination,
  parseContact,
} from "@/lib/intake/codes";
import { getCodeSender } from "@/lib/intake/senders";
import { isDemoWorkspace } from "@/lib/delivery";
import { buildIntakeCodeEmail } from "@/lib/email/templates";
import { findUnitByToken, unitLabel } from "@/lib/intake/server";
import { logError } from "@/lib/triage/logger";

export type IntakeState = {
  step: "details" | "code";
  error: string | null;
  name?: string;
  contact?: string;
  masked?: string;
  /** Demo workspace: the message that would have been sent. */
  demoPreview?: string;
};

export type SimpleState = { error: string | null; ok?: string | null };

const nameSchema = z.string().trim().min(1, "Please enter your name").max(100);
const emailSchema = z.string().trim().toLowerCase().email("Please enter a valid email").max(254);

const TOO_MANY = "Too many attempts. Please wait a few minutes and try again.";

/** Step 1 on /r/<token>: name + contact → send a 6-digit code. */
export async function requestIntakeCode(_prev: IntakeState, formData: FormData): Promise<IntakeState> {
  const token = String(formData.get("token") ?? "");
  const nameParsed = nameSchema.safeParse(formData.get("name"));
  const rawContact = String(formData.get("contact") ?? "");
  const back = { step: "details" as const, name: String(formData.get("name") ?? ""), contact: rawContact };
  if (!nameParsed.success) return { ...back, error: nameParsed.error.issues[0].message };

  const contact = parseContact(rawContact);
  if (!contact) return { ...back, error: "Enter a mobile number or an email address" };
  const sender = getCodeSender(contact.channel);
  if (!sender.available) {
    return { ...back, error: "We can't text codes yet. Please enter your email address instead." };
  }

  const ip = await clientIp();
  if (
    !intakeCodeIpLimiter.check(ip).allowed ||
    !intakeCodeLinkLimiter.check(token).allowed ||
    !intakeCodeDestinationLimiter.check(contact.destination).allowed
  ) {
    return { ...back, error: TOO_MANY };
  }

  const unit = await findUnitByToken(token);
  if (!unit) return { ...back, error: "This link is no longer active. Ask your landlord for a new one." };

  const code = generateCode();
  const service = createServiceClient();
  const { error } = await service.from("intake_codes").insert({
    unit_id: unit.unit_id,
    channel: contact.channel,
    destination: contact.destination,
    name: nameParsed.data,
    code_hash: hashCode(code, unit.unit_id, contact.destination),
    expires_at: new Date(Date.now() + CODE_TTL_MS).toISOString(),
  });
  if (error) {
    logError("intake_code_insert", error);
    return { ...back, error: "Something went wrong. Please try again." };
  }

  const message = { code, workspaceName: unit.workspace_name, address: unitLabel(unit) };
  if (await isDemoWorkspace(unit.workspace_id)) {
    // Demo homes never send anything: show the message instead.
    const mail = buildIntakeCodeEmail(message);
    return {
      step: "code",
      error: null,
      name: nameParsed.data,
      contact: rawContact,
      masked: maskDestination(contact.channel, contact.destination),
      demoPreview: `${mail.subject}\n\n${mail.text}`,
    };
  }
  const sent = await sender.send(contact.destination, message);
  if (!sent.success) return { ...back, error: "We couldn't send the code. Please check the address and try again." };

  return {
    step: "code",
    error: null,
    name: nameParsed.data,
    contact: rawContact,
    masked: maskDestination(contact.channel, contact.destination),
  };
}

/**
 * Step 2: check the code, then start a guest session (Supabase anonymous
 * sign-in) unless the tenant is already signed in, link it to the unit's
 * tenancy, and open the chat.
 */
export async function verifyIntakeCode(prev: IntakeState, formData: FormData): Promise<IntakeState> {
  const token = String(formData.get("token") ?? "");
  const code = String(formData.get("code") ?? "").replace(/\s/g, "");
  const contact = parseContact(String(formData.get("contact") ?? ""));
  const name = nameSchema.safeParse(formData.get("name"));
  const back: IntakeState = { ...prev, step: "code" };
  if (!contact || !name.success) return { step: "details", error: "Please start again." };

  if (!intakeVerifyLimiter.check(await clientIp()).allowed) return { ...back, error: TOO_MANY };

  const unit = await findUnitByToken(token);
  if (!unit) return { step: "details", error: "This link is no longer active. Ask your landlord for a new one." };

  const service = createServiceClient();
  const { data: row } = await service
    .from("intake_codes")
    .select("id, code_hash, attempts, expires_at, consumed_at")
    .eq("unit_id", unit.unit_id)
    .eq("destination", contact.destination)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!row || row.consumed_at || new Date(row.expires_at).getTime() < Date.now() || row.attempts >= MAX_CODE_ATTEMPTS) {
    return { ...back, error: "That code has expired. Go back and ask for a new one." };
  }
  if (!codeMatches(code, unit.unit_id, contact.destination, row.code_hash)) {
    await service.from("intake_codes").update({ attempts: row.attempts + 1 }).eq("id", row.id);
    return { ...back, error: "That code isn't right. Check the latest email and try again." };
  }
  // Single use: only the request that flips consumed_at proceeds.
  const { data: consumed } = await service
    .from("intake_codes")
    .update({ consumed_at: new Date().toISOString() })
    .eq("id", row.id)
    .is("consumed_at", null)
    .select("id");
  if (!consumed || consumed.length === 0) return { ...back, error: "That code was already used." };

  // Session: reuse a signed-in user, else a guest (anonymous) session.
  const supabase = await createClient();
  let {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    const { data, error } = await supabase.auth.signInAnonymously({ options: { data: { full_name: name.data } } });
    if (error || !data.user) {
      logError("intake_anonymous_sign_in", error);
      return { ...back, error: "We couldn't start your session. Please try again." };
    }
    user = data.user;
  }

  await service
    .from("profiles")
    .upsert(
      { id: user.id, full_name: name.data, email: user.email ? user.email.toLowerCase() : null },
      { onConflict: "id", ignoreDuplicates: true }
    );

  // One tenancy per person per unit, matched on the confirmed contact.
  const contactColumn = contact.channel === "email" ? "email" : "phone";
  const { data: existing } = await service
    .from("tenancies")
    .select("id")
    .eq("unit_id", unit.unit_id)
    .eq(contactColumn, contact.destination)
    .is("ended_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  let tenancyId = existing?.id ?? null;
  const now = new Date().toISOString();
  if (tenancyId) {
    await service.from("tenancies").update({ verified_at: now }).eq("id", tenancyId);
  } else {
    const { data: created, error } = await service
      .from("tenancies")
      .insert({ unit_id: unit.unit_id, name: name.data, [contactColumn]: contact.destination, verified_at: now })
      .select("id")
      .single();
    if (error || !created) {
      logError("intake_tenancy_insert", error);
      return { ...back, error: "Something went wrong. Please try again." };
    }
    tenancyId = created.id;
  }

  const { error: verifyErr } = await service
    .from("tenancy_verifications")
    .upsert({ tenancy_id: tenancyId, user_id: user.id, channel: contact.channel, verified_at: now }, { onConflict: "tenancy_id,user_id" });
  if (verifyErr) {
    logError("intake_verification_insert", verifyErr);
    return { ...back, error: "Something went wrong. Please try again." };
  }

  redirect(`/r/${token}/chat?t=${tenancyId}`);
}

/**
 * After a request: keep an account. Turns the guest session into a
 * passwordless account by adding an email (Supabase sends a confirmation
 * link); if the email already has an account, sends a sign-in link instead.
 * Either way the tenancy is attached on confirmation (/auth/confirm).
 */
export async function saveTenantAccount(_prev: SimpleState, formData: FormData): Promise<SimpleState> {
  const email = emailSchema.safeParse(formData.get("email"));
  if (!email.success) return { error: email.error.issues[0].message };
  if (!magicLinkLimiter.check(await clientIp()).allowed) return { error: TOO_MANY };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Your session ended. Open your landlord's link again." };

  const done = { error: null, ok: `Check ${email.data} for a link to finish. No password needed.` };
  const redirectTo = appUrl("/auth/confirm?next=/my-requests");
  if (!user.is_anonymous) return { error: null, ok: "You already have an account. See your requests anytime." };

  const { error } = await supabase.auth.updateUser({ email: email.data }, { emailRedirectTo: redirectTo });
  if (error) {
    // Most likely the address already has an account: send a sign-in link.
    await supabase.auth.signInWithOtp({
      email: email.data,
      options: { shouldCreateUser: false, emailRedirectTo: redirectTo },
    });
  }
  return done;
}

/** Tenant sign-in by email link (no password). Same reply whether or not the account exists. */
export async function requestTenantSignInLink(_prev: SimpleState, formData: FormData): Promise<SimpleState> {
  const email = emailSchema.safeParse(formData.get("email"));
  if (!email.success) return { error: email.error.issues[0].message };
  if (!magicLinkLimiter.check(await clientIp()).allowed) return { error: TOO_MANY };

  const supabase = await createClient();
  await supabase.auth.signInWithOtp({
    email: email.data,
    options: { shouldCreateUser: false, emailRedirectTo: appUrl("/auth/confirm?next=/my-requests") },
  });
  return { error: null, ok: `If ${email.data} has a tenant account, a sign-in link is on its way.` };
}
