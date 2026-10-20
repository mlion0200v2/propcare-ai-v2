"use server";

import { revalidatePath } from "next/cache";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { requireMembership, requireTeam, getSessionUser } from "@/lib/workspace/server";
import {
  approvalRequestSchema,
  ticketCommentSchema,
  ticketStageSchema,
  ticketVendorSchema,
} from "@/lib/utils/validation";
import { STAGE_LABELS } from "@/lib/utils/constants";
import { dollarsToCents, formatCents } from "@/lib/workspace/tokens";
import { appTimeZone, zonedLocalToUtc } from "@/lib/utils/time";
import { commentLimiter } from "@/lib/rate-limit";
import { appUrl } from "@/lib/app-url";
import { deliver } from "@/lib/delivery";
import { buildVendorWorkOrderMessage } from "@/lib/messages";
import { buildTenantReplyEmail } from "@/lib/email/templates";
import { logError } from "@/lib/triage/logger";

export type TicketFormState = { error: string | null; ok?: string | null };

function firstIssue(error: { issues: { message: string }[] }): string {
  return error.issues[0]?.message ?? "Please check the form";
}

/** Activity entry written by the system (team and owner can see it). */
async function logActivity(ticketId: string, body: string) {
  const service = createServiceClient();
  const { data: ticket } = await service.from("tickets").select("workspace_id").eq("id", ticketId).maybeSingle();
  if (!ticket?.workspace_id) return;
  const { error } = await service.from("ticket_comments").insert({
    ticket_id: ticketId,
    workspace_id: ticket.workspace_id,
    author_id: null,
    author_name: "PropCare",
    author_role: "system",
    visibility: "team_owner",
    body,
  });
  if (error) logError("ticket_activity", error, { ticketId });
}

async function actorName(): Promise<string> {
  const user = await getSessionUser();
  return (typeof user?.user_metadata?.full_name === "string" && user.user_metadata.full_name) || "A team member";
}

export async function updateTicketStage(formData: FormData): Promise<void> {
  await requireTeam();
  const parsed = ticketStageSchema.safeParse({ ticket_id: formData.get("ticket_id"), stage: formData.get("stage") });
  if (!parsed.success) return;
  const supabase = await createClient();
  // RLS + trigger: only the ticket's workspace team can change the stage.
  const { data, error } = await supabase
    .from("tickets")
    .update({
      stage: parsed.data.stage,
      resolved_at: parsed.data.stage === "fixed" || parsed.data.stage === "closed" ? new Date().toISOString() : null,
    })
    .eq("id", parsed.data.ticket_id)
    .select("id");
  if (!error && data?.length) {
    await logActivity(parsed.data.ticket_id, `${await actorName()} set the status to ${STAGE_LABELS[parsed.data.stage]}.`);
  }
  revalidatePath(`/tickets/${parsed.data.ticket_id}`);
}

export async function updateTicketVendor(_prev: TicketFormState, formData: FormData): Promise<TicketFormState> {
  await requireTeam();
  const parsed = ticketVendorSchema.safeParse({
    ticket_id: formData.get("ticket_id"),
    vendor_name: formData.get("vendor_name") ?? "",
    vendor_booked_for: formData.get("vendor_booked_for") ?? "",
    entry_notice: formData.get("entry_notice") ?? "",
  });
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  let bookedFor: string | null = null;
  if (parsed.data.vendor_booked_for) {
    const date = zonedLocalToUtc(parsed.data.vendor_booked_for, appTimeZone());
    if (!date) return { error: "Choose a valid date and time" };
    bookedFor = date.toISOString();
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("tickets")
    .update({
      vendor_name: parsed.data.vendor_name || null,
      vendor_booked_for: bookedFor,
      entry_notice: parsed.data.entry_notice || null,
    })
    .eq("id", parsed.data.ticket_id)
    .select("id");
  if (error || !data?.length) return { error: "Could not save the vendor" };
  revalidatePath(`/tickets/${parsed.data.ticket_id}`);
  return { error: null, ok: "Saved" };
}

export async function requestOwnerApproval(_prev: TicketFormState, formData: FormData): Promise<TicketFormState> {
  const membership = await requireTeam();
  const parsed = approvalRequestSchema.safeParse({
    ticket_id: formData.get("ticket_id"),
    amount: formData.get("amount"),
    description: formData.get("description") ?? "",
  });
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const cents = dollarsToCents(parsed.data.amount);
  if (!cents) return { error: "Enter the quote in dollars, e.g. 340" };

  const supabase = await createClient();
  const { error } = await supabase.from("approvals").insert({
    ticket_id: parsed.data.ticket_id,
    amount_cents: cents,
    limit_cents: membership.approvalLimitCents, // replaced by the DB with the workspace setting
    description: parsed.data.description || null,
  });
  if (error) return { error: "Could not request approval" };
  await supabase.from("tickets").update({ stage: "waiting_for_owner" }).eq("id", parsed.data.ticket_id);
  await logActivity(parsed.data.ticket_id, `${await actorName()} asked the owner to approve a ${formatCents(cents)} quote.`);
  revalidatePath(`/tickets/${parsed.data.ticket_id}`);
  return { error: null, ok: "Sent to the owner" };
}

export async function decideApproval(formData: FormData): Promise<void> {
  await requireMembership(["admin", "owner"]);
  const decision = formData.get("decision");
  if (decision !== "approved" && decision !== "declined") return;
  const ticketId = String(formData.get("ticket_id"));
  const supabase = await createClient();
  // decide_approval checks: owner of the property, or a workspace admin.
  const { error } = await supabase.rpc("decide_approval", {
    p_approval: String(formData.get("approval_id")),
    p_decision: decision,
    p_note: String(formData.get("note") ?? "").slice(0, 1000) || undefined,
  });
  if (error) {
    logError("decide_approval", error, { ticketId });
  } else {
    await logActivity(ticketId, `${await actorName()} ${decision} the quote.`);
  }
  revalidatePath(`/tickets/${ticketId}`);
}

/**
 * Team or owner comment. "To tenant" comments are emailed to the tenant
 * (email on the tenancy, else on their account); delivery is recorded on
 * the comment. RLS decides who may post which visibility.
 */
export async function addTicketComment(_prev: TicketFormState, formData: FormData): Promise<TicketFormState> {
  const membership = await requireMembership();
  const parsed = ticketCommentSchema.safeParse({
    ticket_id: formData.get("ticket_id"),
    visibility: formData.get("visibility"),
    body: formData.get("body"),
  });
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  if (!commentLimiter.check(membership.userId).allowed) return { error: "Too many comments. Please wait a moment." };

  const supabase = await createClient();
  const { data: comment, error } = await supabase
    .from("ticket_comments")
    .insert({
      ticket_id: parsed.data.ticket_id,
      visibility: parsed.data.visibility,
      body: parsed.data.body,
      // Filled from the caller's membership by the DB:
      author_id: membership.userId,
      author_name: "",
      author_role: membership.role,
    })
    .select("id, author_name")
    .single();
  if (error || !comment) {
    return {
      error:
        membership.role === "owner" && parsed.data.visibility !== "team_owner"
          ? "Owners can post to the team and owner thread only"
          : "Could not post the comment",
    };
  }

  if (parsed.data.visibility === "tenant") {
    const delivery = await emailTenant(parsed.data.ticket_id, comment.author_name, parsed.data.body, membership.workspaceName);
    await createServiceClient()
      .from("ticket_comments")
      .update(delivery.sent ? { delivered_at: new Date().toISOString() } : { delivery_error: delivery.reason })
      .eq("id", comment.id);
  }
  revalidatePath(`/tickets/${parsed.data.ticket_id}`);
  return { error: null, ok: parsed.data.visibility === "tenant" ? "Sent to the tenant" : "Posted" };
}

async function emailTenant(
  ticketId: string,
  authorName: string,
  body: string,
  workspaceName: string
): Promise<{ sent: true } | { sent: false; reason: string }> {
  const service = createServiceClient();
  const { data: ticket } = await service
    .from("tickets")
    .select("title, tenant_id, workspace_id, tenancies(name, email, tenant_user_id)")
    .eq("id", ticketId)
    .maybeSingle();
  if (!ticket) return { sent: false, reason: "Ticket not found" };

  let to = ticket.tenancies?.email ?? null;
  if (!to) {
    const { data: profile } = await service.from("profiles").select("email").eq("id", ticket.tenant_id).maybeSingle();
    to = profile?.email ?? null;
  }
  if (!to) return { sent: false, reason: "No email on file for this tenant (text messages are not set up yet)" };

  const mail = buildTenantReplyEmail({
    workspaceName,
    authorName,
    ticketTitle: ticket.title,
    body,
    link: ticket.tenancies?.tenant_user_id ? appUrl(`/my-requests/${ticketId}`) : null,
  });
  const result = await deliver({
    workspaceId: ticket.workspace_id,
    ticketId,
    channel: "email",
    to,
    recipientLabel: `${ticket.tenancies?.name ?? "Tenant"} (tenant) · ${to}`,
    subject: mail.subject,
    text: mail.text,
    kind: "tenant_reply",
  });
  if (result.demo) return { sent: false, reason: "demo" };
  return result.success ? { sent: true } : { sent: false, reason: "Email could not be sent" };
}

/** Tenant reply on their own request (tenant-visible thread). */
export async function addTenantReply(_prev: TicketFormState, formData: FormData): Promise<TicketFormState> {
  const user = await getSessionUser();
  if (!user) return { error: "Please sign in again." };
  const parsed = ticketCommentSchema.safeParse({
    ticket_id: formData.get("ticket_id"),
    visibility: "tenant",
    body: formData.get("body"),
  });
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  if (!commentLimiter.check(user.id).allowed) return { error: "Too many messages. Please wait a moment." };

  const supabase = await createClient();
  const { error } = await supabase.from("ticket_comments").insert({
    ticket_id: parsed.data.ticket_id,
    visibility: "tenant",
    body: parsed.data.body,
    author_id: user.id,
    author_name: "",
    author_role: "tenant",
  });
  if (error) return { error: "Could not send your message" };
  revalidatePath(`/my-requests/${parsed.data.ticket_id}`);
  return { error: null, ok: "Sent" };
}

/**
 * "Send to vendor": a work order with a no-account link where the vendor
 * sees the job and submits a quote. Emailed to the vendor (in a demo
 * workspace: shown as a preview, not delivered).
 */
export async function sendToVendor(_prev: TicketFormState, formData: FormData): Promise<TicketFormState> {
  const membership = await requireTeam();
  const ticketId = String(formData.get("ticket_id") ?? "");
  const vendorId = String(formData.get("vendor_id") ?? "");
  const vendorNameInput = String(formData.get("vendor_name") ?? "").trim();
  const scope = String(formData.get("scope") ?? "").trim();
  if (!/^[0-9a-f-]{36}$/i.test(ticketId)) return { error: "Invalid ticket" };
  if (!scope) return { error: "Describe the job for the vendor" };

  const supabase = await createClient();
  const { data: vendor } = vendorId
    ? await supabase.from("vendors").select("id, name, email").eq("id", vendorId).maybeSingle()
    : { data: null };
  const vendorName = vendor?.name ?? vendorNameInput;
  if (!vendorName) return { error: "Choose or name a vendor" };

  const entry = formData.get("entry_permission");
  const { data: order, error } = await supabase
    .from("work_orders")
    .insert({
      ticket_id: ticketId,
      vendor_id: vendor?.id ?? null,
      vendor_name: vendorName.slice(0, 200),
      scope: scope.slice(0, 4000),
      access_window: String(formData.get("access_window") ?? "").trim().slice(0, 300) || null,
      entry_permission: entry === "yes" ? true : entry === "no" ? false : null,
      pets: String(formData.get("pets") ?? "").trim().slice(0, 300) || null,
      include_tenant_phone: formData.get("include_tenant_phone") === "on",
    })
    .select("token")
    .single();
  if (error || !order) return { error: "Could not create the work order" };

  const { data: ticket } = await supabase
    .from("tickets")
    .select("title, units(unit_number, properties(address_line1))")
    .eq("id", ticketId)
    .maybeSingle();
  const message = buildVendorWorkOrderMessage({
    workspaceName: membership.workspaceName,
    vendorName,
    title: ticket?.title ?? "Repair",
    address: `${ticket?.units?.properties?.address_line1 ?? ""}${ticket?.units?.unit_number ? `, Unit ${ticket.units.unit_number}` : ""}`,
    link: appUrl(`/v/${order.token}`),
  });

  if (vendor?.email) {
    const result = await deliver({
      workspaceId: membership.workspaceId,
      ticketId,
      channel: "email",
      to: vendor.email,
      recipientLabel: `${vendorName} · ${vendor.email}`,
      subject: message.subject,
      text: message.text,
      kind: "vendor_work_order",
    });
    await logActivity(ticketId, `${await actorName()} sent a work order to ${vendorName}${result.demo ? " (demo, not delivered)" : " by email"}.`);
  } else {
    await logActivity(ticketId, `${await actorName()} created a work order for ${vendorName}. Share the link by WhatsApp or WeChat.`);
  }
  revalidatePath(`/tickets/${ticketId}`);
  return { error: null, ok: "Work order ready" };
}
