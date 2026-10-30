/**
 * POST /api/triage/chat — one tenant message
 * GET  /api/triage/chat?ticket_id=… — resume: messages, media and state
 *
 * The conversation itself is the assistant's (src/assistant, `turn()`):
 * this route owns everything about the tenant and the ticket. It loads the
 * ticket, sends the assistant the message (contact details removed), the
 * stored conversation state and the home's non-sensitive profile, then
 * stores what comes back, alerts the manager on emergencies and emails the
 * manager when the report is submitted.
 *
 * POST body: { message?, ticket_id?, tenancy_id?, media_action?, confirm_summary? }
 * POST response: { ticket_id, reply, triage_state, is_complete, is_emergency? }
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { demoChatTurnLimit, isDemoMode } from "@/lib/demo/config";
import { logError, logTriageStep } from "@/lib/logger";
import { sendTicketSummaryEmail, getManagerEmailForTicket } from "@/lib/email/send-ticket-email";
import { escalateEmergency, setPrivilegedTicketFields } from "@/lib/tickets/escalate-emergency";
import { callAssistant, propertyContext, stateFromTicket } from "@/lib/assistant-client";
import { photoStepAction } from "@/lib/assistant-request";
import { emergencyNotice, type TurnRequest, type TurnResponse } from "@/assistant";
import { detectEmergency, type EmergencyKind } from "@/assistant/triage/emergency";
import { triageChatRequestSchema } from "@/lib/utils/validation";
import { triageChatLimiter } from "@/lib/rate-limit";
import type { Json, Database } from "@/lib/supabase/database-generated";

type Supabase = Awaited<ReturnType<typeof createClient>>;
type Ticket = { id: string; trace_id: string | null; description: string; triage_state: string; classification: Json | null; unit_id: string | null };

// ── GET — resume an in-progress conversation ──

export async function GET(request: NextRequest) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();
    if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const ticketId = request.nextUrl.searchParams.get("ticket_id");
    if (!ticketId) return NextResponse.json({ error: "ticket_id query param is required" }, { status: 400 });

    // RLS: tenants only see their own tickets.
    const { data: ticket, error: ticketErr } = await supabase
      .from("tickets")
      .select("id, triage_state, classification")
      .eq("id", ticketId)
      .eq("tenant_id", user.id)
      .single();
    if (ticketErr || !ticket) {
      logError("chat_get_ticket_load", ticketErr, { ticketId });
      return NextResponse.json({ error: "Ticket not found" }, { status: 404 });
    }

    const { data: messages, error: msgErr } = await supabase
      .from("messages")
      .select("id, body, is_bot_reply, created_at")
      .eq("ticket_id", ticketId)
      .order("created_at", { ascending: true });
    if (msgErr) logError("chat_get_messages_load", msgErr);

    const { data: mediaRecords } = await supabase
      .from("ticket_media")
      .select("id, file_path, file_type, mime_type, created_at")
      .eq("ticket_id", ticketId)
      .order("created_at", { ascending: true });
    const media = (
      await Promise.all(
        (mediaRecords ?? []).map(async (m) => {
          const { data } = await supabase.storage.from("ticket-media").createSignedUrl(m.file_path, 3600);
          return { id: m.id, file_type: m.file_type, mime_type: m.mime_type, signed_url: data?.signedUrl ?? "", created_at: m.created_at };
        })
      )
    ).filter((m) => m.signed_url);

    return NextResponse.json({
      ticket_id: ticket.id,
      triage_state: ticket.triage_state,
      is_complete: ticket.triage_state === "DONE",
      is_guided: ticket.triage_state === "GUIDED_TROUBLESHOOTING",
      messages: messages ?? [],
      media,
      classification: ticket.classification ?? null,
    });
  } catch (err: unknown) {
    logError("chat_get_fatal", err);
    return NextResponse.json({ error: "triage_chat_resume_failed" }, { status: 500 });
  }
}

// ── POST — one tenant message ──

export async function POST(request: NextRequest) {
  const start = Date.now();
  try {
    const supabase = await createClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();
    if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
    const parsed = triageChatRequestSchema.safeParse(rawBody);
    if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid request" }, { status: 400 });
    const body = parsed.data;
    const message = body.message?.trim() ?? "";

    // Per-user rate limit (each message can trigger model calls). Emergencies are never throttled.
    const isEmergencyMessage = !!message && detectEmergency(message) !== null;
    if (!isEmergencyMessage) {
      const limit = triageChatLimiter.check(user.id);
      if (!limit.allowed) {
        return NextResponse.json(
          { error: "Too many messages. Please wait a moment and try again." },
          { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } }
        );
      }
    }
    // Try-mode sandboxes share a small budget of chat turns (model cost). Real workspaces are unaffected.
    if (isDemoMode() && !isEmergencyMessage) {
      const { data: turnLeft } = await createServiceClient().rpc("demo_take_chat_turn", { p_user: user.id, p_limit: demoChatTurnLimit() });
      if (turnLeft === "limit" || turnLeft === "expired") {
        return NextResponse.json(
          {
            error:
              turnLeft === "limit"
                ? "This demo has used its chat messages. Switch to the Manager view to see what happens next, or start a new demo tomorrow."
                : "This demo has expired. Start a new one at /try.",
          },
          { status: 429 }
        );
      }
    }

    if (!message && !body.media_action && !body.confirm_summary) return NextResponse.json({ error: "message is required" }, { status: 400 });
    if (!body.ticket_id) {
      if (!message) return NextResponse.json({ error: "message is required" }, { status: 400 });
      return firstMessage(supabase, user.id, message, start, body.tenancy_id);
    }
    return followUp(supabase, user.id, body.ticket_id, message, body.media_action, body.confirm_summary, start);
  } catch (err: unknown) {
    logError("chat_post_fatal", err);
    return NextResponse.json({ error: "triage_chat_failed" }, { status: 500 });
  }
}

/**
 * The tenancy a new ticket is filed under: the one the client names, or the
 * caller's most recent one. RLS only returns tenancies the caller holds or
 * confirmed through the unit's (still active) link, and re-checks on insert.
 */
async function resolveTenancy(supabase: Supabase, tenancyId: string | undefined): Promise<{ id: string; unit_id: string } | null> {
  let query = supabase.from("tenancies").select("id, unit_id").is("ended_at", null).order("created_at", { ascending: false }).limit(1);
  if (tenancyId) query = query.eq("id", tenancyId);
  const { data } = await query.maybeSingle();
  return data ?? null;
}

async function unitProfile(supabase: Supabase, unitId: string | null) {
  if (!unitId) return null;
  const { data } = await supabase.from("units").select("profile").eq("id", unitId).maybeSingle();
  return data?.profile ?? null;
}

async function mediaCount(supabase: Supabase, ticketId: string): Promise<number> {
  const { count } = await supabase.from("ticket_media").select("id", { count: "exact", head: true }).eq("ticket_id", ticketId);
  return count ?? 0;
}

async function addMessage(supabase: Supabase, ticketId: string, userId: string, body: string, isBot: boolean) {
  if (!body) return;
  const { error } = await supabase.from("messages").insert({ ticket_id: ticketId, sender_id: userId, body, is_bot_reply: isBot });
  if (error) logError(isBot ? "chat_bot_message_insert" : "chat_user_message_insert", error, { ticketId });
}

async function firstMessage(supabase: Supabase, userId: string, message: string, start: number, tenancyId?: string) {
  // Every ticket belongs to a unit's tenancy, and through it to one workspace.
  const tenancy = await resolveTenancy(supabase, tenancyId);
  if (!tenancy) {
    return NextResponse.json({ error: "Please open the report link your landlord sent you to start a request.", code: "no_tenancy" }, { status: 400 });
  }

  const { data: inserted, error } = await supabase
    .from("tickets")
    .insert({
      title: message.slice(0, 200),
      description: message,
      tenant_id: userId,
      unit_id: tenancy.unit_id,
      tenancy_id: tenancy.id,
      triage_state: "GATHER_INFO",
    })
    .select("id, trace_id, description, triage_state, classification, unit_id")
    .single();
  if (error || !inserted) {
    logError("chat_ticket_insert", error, { code: error?.code, hint: error?.hint });
    return NextResponse.json({ error: "Failed to create ticket" }, { status: 500 });
  }

  const response = await callAssistant({
    conversation: inserted.trace_id ?? inserted.id,
    message,
    state: null,
    property: propertyContext(await unitProfile(supabase, tenancy.unit_id)),
    media: { count: 0 },
    channel: "web",
  });
  return applyTurn(supabase, userId, inserted, message, message, response, start);
}

async function followUp(
  supabase: Supabase,
  userId: string,
  ticketId: string,
  message: string,
  mediaAction: string | undefined,
  confirmSummary: string | undefined,
  start: number
) {
  const { data: ticket, error } = await supabase
    .from("tickets")
    .select("id, trace_id, description, triage_state, classification, unit_id")
    .eq("id", ticketId)
    .eq("tenant_id", userId)
    .single();
  if (error || !ticket) {
    logError("chat_ticket_load", error, { ticketId });
    return NextResponse.json({ error: "Ticket not found" }, { status: 404 });
  }
  if (ticket.triage_state === "DONE") return NextResponse.json({ error: "Triage already complete for this ticket" }, { status: 400 });

  const state = stateFromTicket(ticket);
  if (!state) return NextResponse.json({ error: "This report can't be continued here. Please start a new one." }, { status: 409 });

  // Buttons: photos skipped/added, summary confirmed. The tenant's own words otherwise.
  let action: TurnRequest["action"];
  let shown = message;
  const media = await mediaCount(supabase, ticket.id);
  if (ticket.triage_state === "AWAITING_MEDIA") {
    // Typed words while the photo buttons show are an answer, not "photos added".
    ({ action, shown } = photoStepAction(mediaAction, mediaAction ? "" : message, media));
  } else if (ticket.triage_state === "CONFIRM_SUMMARY" && confirmSummary) {
    action = "confirm_summary";
    shown = "Looks good, submit";
  }

  const response = await callAssistant({
    conversation: ticket.trace_id ?? ticket.id,
    message: action === "confirm_summary" || mediaAction ? "" : message,
    action,
    state,
    property: propertyContext(await unitProfile(supabase, ticket.unit_id)),
    media: { count: media },
    channel: "web",
  });
  return applyTurn(supabase, userId, ticket, shown, message, response, start);
}

/** Store the assistant's response and act on it: messages, ticket fields, emergency alert, manager email. */
async function applyTurn(supabase: Supabase, userId: string, ticket: Ticket, shownMessage: string, rawMessage: string, response: TurnResponse, start: number) {
  const traceId = ticket.trace_id ?? ticket.id;
  const state = response.state;
  let reply = response.reply;

  await addMessage(supabase, ticket.id, userId, shownMessage, false);

  if (response.emergency) {
    // Alert the manager now (priority, status, triage_state set server-side), then say whether we reached them.
    const result = await escalateEmergency({
      ticketId: ticket.id,
      tenantId: userId,
      unitId: ticket.unit_id,
      description: ticket.description,
      latestMessage: rawMessage,
      emergency: { kind: response.emergency.kind as EmergencyKind, phrase: response.emergency.phrase },
      classification: state,
    });
    if (state.emergency) state.emergency.manager_notified = result.managerNotified;
    const { error } = await supabase
      .from("tickets")
      .update({ triage_state: "EMERGENCY", classification: state as unknown as Json })
      .eq("id", ticket.id);
    if (error) logError("chat_emergency_state_update", error, { ticketId: ticket.id });
    reply = `${reply}\n\n${emergencyNotice(result.managerNotified)}`;
    await addMessage(supabase, ticket.id, userId, reply, true);
    logTriageStep({
      trace_id: traceId,
      ticket_id: ticket.id,
      triage_state: "EMERGENCY",
      action: "emergency_detected",
      latency_ms: Date.now() - start,
      timestamp: new Date().toISOString(),
      metadata: { kind: response.emergency.kind, escalated: result.escalated, manager_notified: result.managerNotified },
    });
    return NextResponse.json({ ticket_id: ticket.id, reply, triage_state: "EMERGENCY", is_complete: false, is_emergency: true });
  }

  const t = response.ticket;
  const update: Database["public"]["Tables"]["tickets"]["Update"] = {
    triage_state: response.phase,
    classification: state as unknown as Json,
  };
  if (t.category) update.category = t.category as Database["public"]["Enums"]["ticket_category"];
  if (t.troubleshooting_steps) update.troubleshooting_steps = t.troubleshooting_steps as unknown as Json;
  const { error: updateErr } = await supabase.from("tickets").update(update).eq("id", ticket.id).select("id").single();
  if (updateErr) logError("chat_ticket_update", updateErr, { ticketId: ticket.id, phase: response.phase });

  // Priority, status and the safety flag go through the service role (the tenant's RLS rejects them).
  if (t.priority || t.escalate || t.flag_emergency) {
    await setPrivilegedTicketFields(ticket.id, userId, {
      ...(t.priority ? { priority: t.priority } : {}),
      ...(t.escalate ? { status: "escalated" as const } : {}),
      ...(t.flag_emergency ? { safety_assessment: { flagged: true, reason: "emergency_detected" } as unknown as Json } : {}),
    });
  }

  await addMessage(supabase, ticket.id, userId, reply, true);

  if (t.notify_manager && t.manager_summary) {
    const to = await getManagerEmailForTicket(ticket.id, ticket.unit_id);
    if (to) {
      const sent = await sendTicketSummaryEmail({
        to,
        ticketId: ticket.id,
        ticketTitle: ticket.description.slice(0, 80),
        summary: t.manager_summary,
        isEmergency: t.notify_manager === "urgent",
        category: t.category ?? "general",
      });
      if (!sent.success) logError("email_send_failed", sent.error, { ticketId: ticket.id });
    }
  }

  logTriageStep({
    trace_id: traceId,
    ticket_id: ticket.id,
    triage_state: response.phase,
    action: response.done ? "triage_complete" : "turn",
    latency_ms: Date.now() - start,
    timestamp: new Date().toISOString(),
    metadata: { sop: state.gathered?.sop?.issue_key ?? null, question: state.current_question },
  });
  return NextResponse.json({ ticket_id: ticket.id, reply, triage_state: response.phase, is_complete: response.done });
}
