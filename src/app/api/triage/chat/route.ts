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
  buildConfirmProfileReply,
  stepTenantInfo,
  getNextMissingTenantInfo,
  TENANT_INFO_QUESTIONS,
} from "@/lib/triage/state-machine";
import { logTriageStep } from "@/lib/triage/logger";
import {
  isGatherComplete,
  isExtendedField,
  getNextExtendedQuestion,
  getExtendedQuestionText,
  processExtendedAnswer,
} from "@/lib/triage/gather-issue";
import { querySnippets } from "@/lib/retrieval/pinecone";
import { generateGroundedSteps } from "@/lib/triage/grounding";
import { generateTicketSummary } from "@/lib/triage/summary";
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
    let body: { message?: string; ticket_id?: string; confirm_profile?: string };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const message = body.message?.trim();
    // message is required unless this is a confirm_profile action
    if (!message && !body.confirm_profile) {
      return NextResponse.json(
        { error: "message is required" },
        { status: 400 }
      );
    }

    // ── First message — create ticket ──
    if (!body.ticket_id) {
      if (!message) {
        return NextResponse.json(
          { error: "message is required" },
          { status: 400 }
        );
      }
      return handleFirstMessage(supabase, user.id, message, start);
    }

    // ── Subsequent message — advance state machine ──
    return handleFollowUp(supabase, user.id, body.ticket_id, message ?? "", body.confirm_profile, start);
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
    // Load profile to seed tenant info from previous tickets
    const { data: profile } = await supabase
      .from("profiles")
      .select("phone, email, default_property_address, default_unit_number")
      .eq("id", userId)
      .single();

    const initialGathered = buildInitialGathered();
    const tenantInfo = {
      reported_address: profile?.default_property_address ?? null,
      reported_unit_number: profile?.default_unit_number ?? null,
      contact_phone: profile?.phone ?? null,
      contact_email: profile?.email ?? null,
    };

    const firstMissing = getNextMissingTenantInfo(tenantInfo);

    if (!firstMissing) {
      // All fields present — returning tenant, confirm stored info
      classification = {
        gathered: initialGathered,
        current_question: null,
        tenant_info: tenantInfo,
      };
      triageState = "CONFIRM_PROFILE";
      reply = buildConfirmProfileReply(tenantInfo);
    } else {
      // Some or all fields missing — collect the missing ones
      classification = {
        gathered: initialGathered,
        current_question: firstMissing,
        tenant_info: tenantInfo,
      };
      triageState = "COLLECT_TENANT_INFO";
      reply = buildTenantInfoInitialReply();
    }
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
  confirmProfile: string | undefined,
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

  // ── CONFIRM_PROFILE branch ──
  if (ticket.triage_state === "CONFIRM_PROFILE") {
    const action = confirmProfile;
    if (!action || !["yes", "change"].includes(action)) {
      return NextResponse.json(
        { error: "confirm_profile must be 'yes' or 'change'" },
        { status: 400 }
      );
    }

    let updatedClassification: TriageClassification;
    let reply: string;
    let newState: string;

    if (action === "yes") {
      // Keep stored tenant_info — use stepTenantInfo to determine next state
      // If all fields filled → GATHER_INFO; if some missing → COLLECT_TENANT_INFO
      const tiResult = stepTenantInfo(
        stored.tenant_info ?? buildInitialTenantInfo(),
        null,
        ""
      );
      updatedClassification = {
        gathered: tiResult.gathered ?? stored.gathered ?? buildInitialGathered(),
        current_question: tiResult.current_question,
        tenant_info: tiResult.tenant_info,
      };
      reply = tiResult.reply;
      newState = tiResult.next_state;
    } else {
      // "change" — clear address/unit/phone, keep email (auth-canonical)
      const clearedInfo = {
        reported_address: null as string | null,
        reported_unit_number: null as string | null,
        contact_phone: null as string | null,
        contact_email: stored.tenant_info?.contact_email ?? null,
      };
      const firstMissing = getNextMissingTenantInfo(clearedInfo);
      updatedClassification = {
        gathered: stored.gathered ?? buildInitialGathered(),
        current_question: firstMissing ?? "reported_address",
        tenant_info: clearedInfo,
      };
      reply = "No problem, let's update your info.\n\n" + TENANT_INFO_QUESTIONS[firstMissing ?? "reported_address"];
      newState = "COLLECT_TENANT_INFO";
    }

    // Persist state
    const { data: updatedTicket, error: updateErr } = await supabase
      .from("tickets")
      .update({
        triage_state: newState,
        classification: updatedClassification as unknown as Json,
      })
      .eq("id", ticket.id)
      .select("id, triage_state, classification")
      .single();

    if (updateErr || !updatedTicket) {
      console.error("triage/chat confirm_profile_update failed", {
        message: updateErr?.message,
        details: updateErr?.details,
        hint: updateErr?.hint,
        code: updateErr?.code,
        ticketId: ticket.id,
      });
      return NextResponse.json(
        { error: "Failed to update profile confirmation" },
        { status: 500 }
      );
    }

    // Insert user message (the action choice)
    const userActionText = action === "yes" ? "Looks correct" : "I'd like to update my info";
    const { error: cpUserMsgErr } = await supabase.from("messages").insert({
      ticket_id: ticket.id,
      sender_id: userId,
      body: userActionText,
      is_bot_reply: false,
    });
    if (cpUserMsgErr) {
      console.error("triage/chat confirm_profile user_msg failed", {
        message: cpUserMsgErr.message, code: cpUserMsgErr.code,
      });
    }

    // Insert bot reply
    const { error: cpBotMsgErr } = await supabase.from("messages").insert({
      ticket_id: ticket.id,
      sender_id: userId,
      body: reply,
      is_bot_reply: true,
    });
    if (cpBotMsgErr) {
      console.error("triage/chat confirm_profile bot_msg failed", {
        message: cpBotMsgErr.message, code: cpBotMsgErr.code,
      });
    }

    logTriageStep({
      trace_id: ticket.trace_id ?? ticket.id,
      ticket_id: ticket.id,
      triage_state: newState,
      action: "confirm_profile",
      latency_ms: Date.now() - start,
      timestamp: new Date().toISOString(),
      metadata: { confirm_action: action },
    });

    return NextResponse.json({
      ticket_id: ticket.id,
      reply,
      triage_state: newState,
      is_complete: false,
    });
  }

  // ── COLLECT_TENANT_INFO branch ──
  if (ticket.triage_state === "COLLECT_TENANT_INFO") {
    const tenantInfo = stored.tenant_info ?? {
      reported_address: null,
      reported_unit_number: null,
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

    // Persist tenant defaults to profile for next ticket
    if (tiResult.next_state === "GATHER_INFO") {
      const profileUpdate: Record<string, string | null> = {};
      if (tiResult.tenant_info.contact_phone) {
        profileUpdate.phone = tiResult.tenant_info.contact_phone;
      }
      if (tiResult.tenant_info.reported_address) {
        profileUpdate.default_property_address = tiResult.tenant_info.reported_address;
      }
      if (tiResult.tenant_info.reported_unit_number) {
        profileUpdate.default_unit_number = tiResult.tenant_info.reported_unit_number;
      }
      if (Object.keys(profileUpdate).length > 0) {
        const { error: profileErr } = await supabase
          .from("profiles")
          .update(profileUpdate)
          .eq("id", userId)
          .select("id")
          .single();
        if (profileErr) {
          console.error("triage/chat profile_defaults_update failed", {
            message: profileErr.message,
            code: profileErr.code,
            userId,
            fields: Object.keys(profileUpdate),
          });
          // Non-fatal: next ticket still works, just won't have CONFIRM_PROFILE
        }
      }
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

  // ── GATHER_INFO branch ──
  const traceId = ticket.trace_id ?? ticket.id;
  let gathered = stored.gathered ?? buildInitialGathered();
  let currentQuestion = stored.current_question ?? null;
  let stepReply: string | null = null;

  // 1. Process the user's answer
  if (currentQuestion && isExtendedField(currentQuestion)) {
    // Extended field — process directly
    gathered = processExtendedAnswer(gathered, currentQuestion, message);
  } else {
    // Base field — run state machine (but ignore its DONE transition;
    // we use isGatherComplete() as the sole gate)
    const context: TriageContext = {
      triage_state: ticket.triage_state as "GATHER_INFO" | "DONE",
      description: ticket.description,
      gathered,
      current_question: currentQuestion,
    };
    const result = step(context, message);
    gathered = result.gathered;
    // If step() returned a base field question, capture its reply
    if (result.next_state === "GATHER_INFO") {
      stepReply = result.reply;
      currentQuestion = result.current_question;
    } else {
      // step() said DONE (base 4 complete) — but extended fields may remain
      currentQuestion = null;
    }
  }

  // 2. Check if ALL fields (base + extended) are complete
  if (!isGatherComplete(gathered)) {
    // Determine what to ask next
    let nextQuestion: string | null;
    let botReply: string;

    if (stepReply && currentQuestion && !isExtendedField(currentQuestion)) {
      // step() already produced a reply asking a base field question
      nextQuestion = currentQuestion;
      botReply = stepReply;
    } else {
      // Need an extended question
      nextQuestion = getNextExtendedQuestion(gathered);
      botReply = nextQuestion ? getExtendedQuestionText(nextQuestion) : "";
    }

    const updatedClassification: TriageClassification = {
      gathered,
      current_question: nextQuestion,
      tenant_info: stored.tenant_info,
      retrieval: stored.retrieval,
      summary: stored.summary,
    };

    const { error: gatherUpdateErr } = await supabase
      .from("tickets")
      .update({
        triage_state: "GATHER_INFO",
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

    await supabase.from("messages").insert({
      ticket_id: ticket.id,
      sender_id: userId,
      body: message,
      is_bot_reply: false,
    });
    if (botReply) {
      await supabase.from("messages").insert({
        ticket_id: ticket.id,
        sender_id: userId,
        body: botReply,
        is_bot_reply: true,
      });
    }

    logTriageStep({
      trace_id: traceId,
      ticket_id: ticket.id,
      triage_state: "GATHER_INFO",
      action: "gather_info",
      latency_ms: Date.now() - start,
      timestamp: new Date().toISOString(),
      metadata: {
        question: nextQuestion,
        gathered_fields: Object.entries(gathered)
          .filter(([, v]) => v !== null)
          .map(([k]) => k),
      },
    });

    return NextResponse.json({
      ticket_id: ticket.id,
      reply: botReply,
      triage_state: "GATHER_INFO",
      is_complete: false,
    });
  }

  // ── All fields gathered — proceed to retrieval + grounding + summary ──
  const isEmergency = gathered.is_emergency ?? false;

  // Retrieval (with idempotency check)
  let retrievalLog = stored.retrieval ?? null;
  let snippets: import("@/lib/retrieval/types").RetrievalSnippet[] = [];
  let lowConfidence = true;

  if (!retrievalLog) {
    try {
      const result = await querySnippets(gathered, ticket.description, traceId);
      retrievalLog = result.log;
      snippets = result.snippets;
      lowConfidence = result.log.low_confidence;
    } catch (err) {
      console.error("triage/chat retrieval failed, using fallback", {
        error: err instanceof Error ? err.message : String(err),
        ticketId: ticket.id,
      });
      // Retrieval failed — proceed with fallback (snippets stays empty)
    }
  } else {
    // Already have retrieval — reconstruct snippets from log for grounding
    snippets = retrievalLog.matches.map((m) => ({
      id: m.id,
      score: m.score,
      title: String(m.metadata?.title ?? m.id),
      content: String(m.metadata?.content ?? m.metadata?.text ?? ""),
      metadata: m.metadata,
    }));
    lowConfidence = retrievalLog.low_confidence;
  }

  // Grounded steps
  let groundedResult: import("@/lib/triage/grounding").GroundedResult;
  try {
    groundedResult = await generateGroundedSteps(
      gathered,
      snippets,
      isEmergency,
      lowConfidence
    );
  } catch (err) {
    console.error("triage/chat grounding failed, using fallback", {
      error: err instanceof Error ? err.message : String(err),
      ticketId: ticket.id,
    });
    // Fall back to hardcoded SOP
    const { getFallbackSOP } = await import("@/lib/triage/sop-fallback");
    const sop = getFallbackSOP(gathered.category ?? "general", isEmergency);
    groundedResult = {
      reply: sop.display,
      steps: sop.steps,
      usedFallback: true,
    };
  }

  // Summary (with idempotency check)
  let summary = stored.summary ?? null;
  if (!summary) {
    // Count media for this ticket
    const { count: mediaCount } = await supabase
      .from("ticket_media")
      .select("id", { count: "exact", head: true })
      .eq("ticket_id", ticket.id);

    summary = generateTicketSummary({
      ticketId: ticket.id,
      traceId,
      description: ticket.description,
      gathered,
      tenantInfo: stored.tenant_info,
      steps: groundedResult.steps,
      mediaCount: mediaCount ?? 0,
      timestamp: new Date().toISOString(),
    });
  }

  // Persist DONE state with all enrichments
  const doneClassification: TriageClassification = {
    gathered,
    current_question: null,
    tenant_info: stored.tenant_info,
    retrieval: retrievalLog ?? undefined,
    summary,
  };

  const { error: doneUpdateErr } = await supabase
    .from("tickets")
    .update({
      triage_state: "DONE",
      classification: doneClassification as unknown as Json,
      category: (gathered.category ?? "general") as Database["public"]["Enums"]["ticket_category"],
      priority: isEmergency ? "emergency" : "medium",
      status: isEmergency ? "escalated" : "open",
      safety_assessment: isEmergency
        ? ({ flagged: true, reason: "emergency_detected" } as unknown as Json)
        : null,
      troubleshooting_steps: groundedResult.steps as unknown as Json,
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
    body: groundedResult.reply,
    is_bot_reply: true,
  });

  logTriageStep({
    trace_id: traceId,
    ticket_id: ticket.id,
    triage_state: "DONE",
    action: "triage_complete",
    latency_ms: Date.now() - start,
    timestamp: new Date().toISOString(),
    metadata: {
      gathered_fields: Object.entries(gathered)
        .filter(([, v]) => v !== null)
        .map(([k]) => k),
      retrieval_matches: retrievalLog?.matches.length ?? 0,
      used_fallback: groundedResult.usedFallback,
      has_summary: !!summary,
    },
  });

  return NextResponse.json({
    ticket_id: ticket.id,
    reply: groundedResult.reply,
    triage_state: "DONE",
    is_complete: true,
  });
}
