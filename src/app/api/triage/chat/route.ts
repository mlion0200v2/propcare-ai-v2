/**
 * POST /api/triage/chat — advance the triage state machine
 * GET  /api/triage/chat?ticket_id=... — resume: load messages + state
 *
 * POST Request body:
 *   { message: string, ticket_id?: string }
 *
 * - First call (no ticket_id): creates ticket + first bot reply
 * - Subsequent calls (with ticket_id): advances the state machine
 *
 * POST Response:
 *   { ticket_id, reply, triage_state, is_complete }
 *
 * GET Response:
 *   { ticket_id, triage_state, is_complete, messages[], classification }
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  step,
  buildInitialReply,
  buildInitialGathered,
  buildInitialTenantInfo,
  buildTenantInfoInitialReply,
  stepTenantInfo,
} from "@/lib/triage/state-machine";
import { logTriageStep } from "@/lib/triage/logger";
import type { TriageContext, TriageClassification } from "@/lib/triage/types";
import type { Json, Database } from "@/lib/supabase/database-generated";

// ── GET — Resume an in-progress triage ──

export async function GET(request: NextRequest) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const ticketId = request.nextUrl.searchParams.get("ticket_id");
    if (!ticketId) {
      return NextResponse.json(
        { error: "ticket_id query param is required" },
        { status: 400 }
      );
    }

    // Load ticket (RLS ensures tenant can only see own tickets)
    const { data: ticket, error: ticketErr } = await supabase
      .from("tickets")
      .select("id, triage_state, classification")
      .eq("id", ticketId)
      .eq("tenant_id", user.id)
      .single();

    if (ticketErr || !ticket) {
      console.error("triage/chat GET ticket_load failed", {
        message: ticketErr?.message,
        code: ticketErr?.code,
        ticketId,
      });
      return NextResponse.json({ error: "Ticket not found" }, { status: 404 });
    }

    // Load messages in chronological order
    const { data: messages, error: msgErr } = await supabase
      .from("messages")
      .select("id, body, is_bot_reply, created_at")
      .eq("ticket_id", ticketId)
      .order("created_at", { ascending: true });

    if (msgErr) {
      console.error("triage/chat GET messages_load failed", {
        message: msgErr.message,
        code: msgErr.code,
      });
    }

    const classification = ticket.classification as unknown as TriageClassification | null;

    return NextResponse.json({
      ticket_id: ticket.id,
      triage_state: ticket.triage_state,
      is_complete: ticket.triage_state === "DONE",
      messages: messages ?? [],
      classification: classification ?? null,
    });
  } catch (err: unknown) {
    console.error("triage/chat GET fatal", {
      err,
      stack: err instanceof Error ? err.stack : undefined,
    });
    return NextResponse.json(
      { error: "triage_chat_resume_failed", details: String(err) },
      { status: 500 }
    );
  }
}

// ── POST — Advance the triage state machine ──

export async function POST(request: NextRequest) {
  const start = Date.now();

  try {
    // ── Auth ──
    const supabase = await createClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // ── Parse body ──
    let body: { message?: string; ticket_id?: string };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const message = body.message?.trim();
    if (!message) {
      return NextResponse.json(
        { error: "message is required" },
        { status: 400 }
      );
    }

    // ── First message — create ticket ──
    if (!body.ticket_id) {
      return handleFirstMessage(supabase, user.id, message, start);
    }

    // ── Subsequent message — advance state machine ──
    return handleFollowUp(supabase, user.id, body.ticket_id, message, start);
  } catch (err: unknown) {
    console.error("triage/chat fatal", {
      err,
      stack: err instanceof Error ? err.stack : undefined,
    });
    return NextResponse.json(
      { error: "triage_chat_failed", details: String(err) },
      { status: 500 }
    );
  }
}

// ────────────────────────────────────────────────────────────

async function handleFirstMessage(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  message: string,
  start: number
) {
  // Look up tenant's unit
  const { data: unit } = await supabase
    .from("units")
    .select("id")
    .eq("tenant_id", userId)
    .limit(1)
    .single();

  const hasUnit = !!unit;

  // Build classification and determine initial state/reply
  let classification: TriageClassification;
  let triageState: string;
  let reply: string;

  if (hasUnit) {
    const initialGathered = buildInitialGathered();
    classification = {
      gathered: initialGathered,
      current_question: "category",
    };
    triageState = "GATHER_INFO";
    reply = buildInitialReply();
  } else {
    const initialGathered = buildInitialGathered();
    const tenantInfo = buildInitialTenantInfo();
    classification = {
      gathered: initialGathered,
      current_question: "reported_address",
      tenant_info: tenantInfo,
    };
    triageState = "COLLECT_TENANT_INFO";
    reply = buildTenantInfoInitialReply();
  }

  // Create ticket (unit_id is null when tenant has no assigned unit)
  const insertPayload = {
    title: message.slice(0, 200),
    description: message,
    tenant_id: userId,
    unit_id: hasUnit ? unit.id : null,
    triage_state: triageState,
    classification: classification as unknown as Json,
  };

  const { data: ticket, error: ticketError } = await supabase
    .from("tickets")
    .insert(insertPayload)
    .select("id, trace_id")
    .single();

  if (ticketError || !ticket) {
    console.error("triage/chat ticket_insert failed", {
      message: ticketError?.message,
      details: ticketError?.details,
      hint: ticketError?.hint,
      code: ticketError?.code,
      payload: { ...insertPayload, classification: "[omitted]" },
    });
    return NextResponse.json(
      { error: "Failed to create ticket" },
      { status: 500 }
    );
  }

  // Insert user message
  const { error: userMsgErr } = await supabase.from("messages").insert({
    ticket_id: ticket.id,
    sender_id: userId,
    body: message,
    is_bot_reply: false,
  });
  if (userMsgErr) {
    console.error("triage/chat user_message_insert failed", {
      message: userMsgErr.message,
      details: userMsgErr.details,
      hint: userMsgErr.hint,
      code: userMsgErr.code,
    });
  }

  // Insert bot reply
  const { error: botMsgErr } = await supabase.from("messages").insert({
    ticket_id: ticket.id,
    sender_id: userId,
    body: reply,
    is_bot_reply: true,
  });
  if (botMsgErr) {
    console.error("triage/chat bot_message_insert failed", {
      message: botMsgErr.message,
      details: botMsgErr.details,
      hint: botMsgErr.hint,
      code: botMsgErr.code,
    });
  }

  logTriageStep({
    trace_id: ticket.trace_id ?? ticket.id,
    ticket_id: ticket.id,
    triage_state: triageState,
    action: "ticket_created",
    latency_ms: Date.now() - start,
    timestamp: new Date().toISOString(),
  });

  return NextResponse.json({
    ticket_id: ticket.id,
    reply,
    triage_state: triageState,
    is_complete: false,
  });
}

async function handleFollowUp(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  ticketId: string,
  message: string,
  start: number
) {
  // Load ticket
  const { data: ticket, error: ticketError } = await supabase
    .from("tickets")
    .select("id, trace_id, description, triage_state, classification")
    .eq("id", ticketId)
    .eq("tenant_id", userId)
    .single();

  if (ticketError || !ticket) {
    console.error("triage/chat ticket_load failed", {
      message: ticketError?.message,
      details: ticketError?.details,
      hint: ticketError?.hint,
      code: ticketError?.code,
      ticketId,
    });
    return NextResponse.json(
      { error: "Ticket not found" },
      { status: 404 }
    );
  }

  // Ticket already completed triage
  if (ticket.triage_state === "DONE") {
    return NextResponse.json(
      { error: "Triage already complete for this ticket" },
      { status: 400 }
    );
  }

  const stored = (ticket.classification ?? {}) as unknown as TriageClassification;

  // ── COLLECT_TENANT_INFO branch ──
  if (ticket.triage_state === "COLLECT_TENANT_INFO") {
    const tenantInfo = stored.tenant_info ?? {
      reported_address: null,
      contact_phone: null,
      contact_email: null,
    };

    const tiResult = stepTenantInfo(
      tenantInfo,
      stored.current_question ?? null,
      message
    );

    const updatedClassification: TriageClassification = {
      gathered: tiResult.gathered ?? stored.gathered ?? buildInitialGathered(),
      current_question: tiResult.current_question,
      tenant_info: tiResult.tenant_info,
    };

    // Persist state BEFORE inserting messages (so refresh always has latest state)
    const { data: updatedTicket, error: updateErr } = await supabase
      .from("tickets")
      .update({
        triage_state: tiResult.next_state,
        classification: updatedClassification as unknown as Json,
      })
      .eq("id", ticket.id)
      .select("id, triage_state, classification")
      .single();

    if (updateErr || !updatedTicket) {
      console.error("triage/chat tenant_info_update failed", {
        message: updateErr?.message,
        details: updateErr?.details,
        hint: updateErr?.hint,
        code: updateErr?.code,
        ticketId: ticket.id,
      });
      return NextResponse.json(
        { error: "Failed to save tenant info" },
        { status: 500 }
      );
    }

    // Insert user message
    const { error: tiUserMsgErr } = await supabase.from("messages").insert({
      ticket_id: ticket.id,
      sender_id: userId,
      body: message,
      is_bot_reply: false,
    });
    if (tiUserMsgErr) {
      console.error("triage/chat tenant_info user_msg failed", {
        message: tiUserMsgErr.message, code: tiUserMsgErr.code,
      });
    }

    // Insert bot reply
    const { error: tiBotMsgErr } = await supabase.from("messages").insert({
      ticket_id: ticket.id,
      sender_id: userId,
      body: tiResult.reply,
      is_bot_reply: true,
    });
    if (tiBotMsgErr) {
      console.error("triage/chat tenant_info bot_msg failed", {
        message: tiBotMsgErr.message, code: tiBotMsgErr.code,
      });
    }

    logTriageStep({
      trace_id: ticket.trace_id ?? ticket.id,
      ticket_id: ticket.id,
      triage_state: tiResult.next_state,
      action:
        tiResult.next_state === "GATHER_INFO"
          ? "tenant_info_complete"
          : "collect_tenant_info",
      latency_ms: Date.now() - start,
      timestamp: new Date().toISOString(),
      metadata: {
        question: tiResult.current_question,
      },
    });

    return NextResponse.json({
      ticket_id: ticket.id,
      reply: tiResult.reply,
      triage_state: tiResult.next_state,
      is_complete: false,
    });
  }

  // ── GATHER_INFO branch (existing flow) ──
  const context: TriageContext = {
    triage_state: ticket.triage_state as "GATHER_INFO" | "DONE",
    description: ticket.description,
    gathered: stored.gathered ?? buildInitialGathered(),
    current_question: stored.current_question ?? null,
  };

  // Run state machine
  const result = step(context, message);

  // Persist state BEFORE messages (so refresh always has latest state)
  const updatedClassification: TriageClassification = {
    gathered: result.gathered,
    current_question: result.current_question,
    tenant_info: stored.tenant_info,
  };

  if (result.next_state === "DONE") {
    const gathered = result.gathered;
    const { error: doneUpdateErr } = await supabase
      .from("tickets")
      .update({
        triage_state: result.next_state,
        classification: updatedClassification as unknown as Json,
        category: (gathered.category ?? "general") as Database["public"]["Enums"]["ticket_category"],
        priority: gathered.is_emergency ? "emergency" : "medium",
        status: gathered.is_emergency ? "escalated" : "open",
        safety_assessment: gathered.is_emergency
          ? ({ flagged: true, reason: "emergency_detected" } as unknown as Json)
          : null,
        troubleshooting_steps: result.troubleshooting_steps
          ? (result.troubleshooting_steps as unknown as Json)
          : null,
      })
      .eq("id", ticket.id)
      .select("id")
      .single();
    if (doneUpdateErr) {
      console.error("triage/chat done_update failed", {
        message: doneUpdateErr.message, details: doneUpdateErr.details,
        hint: doneUpdateErr.hint, code: doneUpdateErr.code,
      });
    }
  } else {
    const { error: gatherUpdateErr } = await supabase
      .from("tickets")
      .update({
        triage_state: result.next_state,
        classification: updatedClassification as unknown as Json,
      })
      .eq("id", ticket.id)
      .select("id")
      .single();
    if (gatherUpdateErr) {
      console.error("triage/chat gather_update failed", {
        message: gatherUpdateErr.message, details: gatherUpdateErr.details,
        hint: gatherUpdateErr.hint, code: gatherUpdateErr.code,
      });
    }
  }

  // Insert messages AFTER state is persisted
  await supabase.from("messages").insert({
    ticket_id: ticket.id,
    sender_id: userId,
    body: message,
    is_bot_reply: false,
  });
  await supabase.from("messages").insert({
    ticket_id: ticket.id,
    sender_id: userId,
    body: result.reply,
    is_bot_reply: true,
  });

  logTriageStep({
    trace_id: ticket.trace_id ?? ticket.id,
    ticket_id: ticket.id,
    triage_state: result.next_state,
    action: result.next_state === "DONE" ? "triage_complete" : "gather_info",
    latency_ms: Date.now() - start,
    timestamp: new Date().toISOString(),
    metadata: {
      question: result.current_question,
      gathered_fields: Object.entries(result.gathered)
        .filter(([, v]) => v !== null)
        .map(([k]) => k),
    },
  });

  return NextResponse.json({
    ticket_id: ticket.id,
    reply: result.reply,
    triage_state: result.next_state,
    is_complete: result.next_state === "DONE",
  });
}
