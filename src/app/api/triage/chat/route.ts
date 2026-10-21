/**
 * POST /api/triage/chat — advance the triage state machine
 * GET  /api/triage/chat?ticket_id=... — resume: load messages + state
 *
 * POST Request body:
 *   { message: string, ticket_id?: string, confirm_profile?: string, media_action?: string }
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
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { demoChatTurnLimit, isDemoMode } from "@/lib/demo/config";
import {
  buildInitialGathered,
  buildInitialTenantInfo,
  stepTenantInfo,
  getNextMissingTenantInfo,
  validateTenantInfo,
  TENANT_INFO_QUESTIONS,
} from "@/lib/triage/state-machine";
import { extractLocation, extractTiming, extractCurrentStatus, extractEntryPoint, extractEquipment, detectEquipmentCorrection, inferLocationFromEquipment, getEquipmentCategory } from "@/lib/triage/extract-details";
import { logTriageStep, logError, logWarn } from "@/lib/triage/logger";
import { sendTicketSummaryEmail, getManagerEmailForTicket } from "@/lib/email/send-ticket-email";
import {
  parseCategoryCorrection,
} from "@/lib/triage/classify-issue";
import {
  checkPestEscalation,
} from "@/lib/triage/detect-safety";
import { querySnippets } from "@/lib/retrieval/pinecone";
import { generateGroundedSteps, generateWebSearchSteps, convertToGuidedSteps, shouldUseGuidedTroubleshooting, filterStepsByEquipment, enforceStepSafety } from "@/lib/triage/grounding";
import { generateTicketSummary, generateTenantSummary } from "@/lib/triage/summary";
import { validateGroundedResult } from "@/lib/triage/validate";
import { getFallbackSOP } from "@/lib/triage/sop-fallback";
import {
  determineNextAction,
  findNextEligibleStep,
  getTerminalGuidance,
  buildStepMessage,
  buildFeedbackReply,
  buildClarifyReply,
  buildHelpReply,
} from "@/lib/triage/step-feedback";
import { classifyStepHybrid } from "@/lib/triage/interpret-step-response";
import { generateStepHelp } from "@/lib/triage/step-help";
import {
  detectEmergency,
  buildEmergencyReply,
  buildEmergencyFollowUpReply,
  type EmergencyMatch,
} from "@/lib/triage/emergency";
import { escalateEmergency, setPrivilegedTicketFields } from "@/lib/triage/escalate-emergency";
import { isSummaryConfirmation } from "@/lib/triage/confirmation";
import { advanceGather, afterGather, getNextGatherQuestion, openConversation, turnEmergency, updateIssueFrame } from "@/lib/triage/conversation";
import { openAIUnderstander } from "@/lib/understanding";
import { classifyWithModel } from "@/lib/triage/classify-model";
import { buildMediaPrompt, managerOnlyReply } from "@/lib/triage/guidance";
import { readUnitProfile } from "@/lib/units/profile";
import { triageChatRequestSchema } from "@/lib/utils/validation";
import { triageChatLimiter } from "@/lib/rate-limit";
import type {
  TriageClassification,
  ValidationResult,
  GuidedTroubleshootingState,
  TroubleshootingLogEntry,
} from "@/lib/triage/types";
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
      logError("chat_get_ticket_load", ticketErr, { ticketId });
      return NextResponse.json({ error: "Ticket not found" }, { status: 404 });
    }

    // Load messages in chronological order
    const { data: messages, error: msgErr } = await supabase
      .from("messages")
      .select("id, body, is_bot_reply, created_at")
      .eq("ticket_id", ticketId)
      .order("created_at", { ascending: true });

    if (msgErr) {
      logError("chat_get_messages_load", msgErr);
    }

    // Load uploaded media and generate signed URLs for display
    const { data: mediaRecords } = await supabase
      .from("ticket_media")
      .select("id, file_path, file_type, mime_type, created_at")
      .eq("ticket_id", ticketId)
      .order("created_at", { ascending: true });

    let media: Array<{ id: string; file_type: string; mime_type: string; signed_url: string; created_at: string }> = [];
    if (mediaRecords && mediaRecords.length > 0) {
      const urls = await Promise.all(
        mediaRecords.map(async (m) => {
          const { data } = await supabase.storage
            .from("ticket-media")
            .createSignedUrl(m.file_path, 3600);
          return {
            id: m.id,
            file_type: m.file_type,
            mime_type: m.mime_type,
            signed_url: data?.signedUrl ?? "",
            created_at: m.created_at,
          };
        })
      );
      media = urls.filter((m) => m.signed_url);
    }

    const classification = ticket.classification as unknown as TriageClassification | null;

    return NextResponse.json({
      ticket_id: ticket.id,
      triage_state: ticket.triage_state,
      is_complete: ticket.triage_state === "DONE",
      is_guided: ticket.triage_state === "GUIDED_TROUBLESHOOTING",
      messages: messages ?? [],
      media,
      classification: classification ?? null,
    });
  } catch (err: unknown) {
    logError("chat_get_fatal", err);
    return NextResponse.json(
      { error: "triage_chat_resume_failed" },
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

    // ── Parse + validate body ──
    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
    const parsedBody = triageChatRequestSchema.safeParse(rawBody);
    if (!parsedBody.success) {
      return NextResponse.json(
        { error: parsedBody.error.issues[0]?.message ?? "Invalid request" },
        { status: 400 }
      );
    }
    const body = parsedBody.data;

    const message = body.message?.trim();

    // ── Per-user rate limit (each message can trigger OpenAI calls) ──
    // Emergencies are never throttled: that path makes no LLM calls.
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
    // Try-mode sandboxes share a small budget of chat turns (OpenAI cost).
    // Real workspaces are unaffected ('not_demo').
    if (isDemoMode() && !isEmergencyMessage) {
      const { data: turn } = await createServiceClient().rpc("demo_take_chat_turn", {
        p_user: user.id,
        p_limit: demoChatTurnLimit(),
      });
      if (turn === "limit" || turn === "expired") {
        return NextResponse.json(
          {
            error:
              turn === "limit"
                ? "This demo has used its chat messages. Switch to the Manager view to see what happens next, or start a new demo tomorrow."
                : "This demo has expired. Start a new one at /try.",
          },
          { status: 429 }
        );
      }
    }

    // message is required unless this is a confirm_profile, media_action, or confirm_summary
    if (!message && !body.confirm_profile && !body.media_action && !body.confirm_summary) {
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
      return handleFirstMessage(supabase, user.id, message, start, body.tenancy_id);
    }

    // ── Subsequent message — advance state machine ──
    return handleFollowUp(
      supabase,
      user.id,
      body.ticket_id,
      message ?? "",
      body.confirm_profile,
      body.media_action,
      body.confirm_summary,
      start
    );
  } catch (err: unknown) {
    logError("chat_post_fatal", err);
    return NextResponse.json(
      { error: "triage_chat_failed" },
      { status: 500 }
    );
  }
}

// ────────────────────────────────────────────────────────────


/**
 * The tenancy a new ticket is filed under: the one the client names, or the
 * caller's most recent one. RLS only returns tenancies the caller holds or
 * confirmed with a one-time code through the unit's (still active) link, and
 * re-checks the same on insert.
 */
async function resolveTenancy(
  supabase: Awaited<ReturnType<typeof createClient>>,
  tenancyId: string | undefined
): Promise<{ id: string; unit_id: string } | null> {
  let query = supabase
    .from("tenancies")
    .select("id, unit_id")
    .is("ended_at", null)
    .order("created_at", { ascending: false })
    .limit(1);
  if (tenancyId) query = query.eq("id", tenancyId);
  const { data } = await query.maybeSingle();
  return data ?? null;
}

async function handleFirstMessage(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  message: string,
  start: number,
  tenancyId?: string
) {
  // Every ticket belongs to a unit's tenancy, and through it to one workspace.
  const tenancy = await resolveTenancy(supabase, tenancyId);
  if (!tenancy) {
    return NextResponse.json(
      {
        error: "Please open the report link your landlord sent you to start a request.",
        code: "no_tenancy",
      },
      { status: 400 }
    );
  }
  const unit = { id: tenancy.unit_id };
  const hasUnit = true;

  // What the first message says, and the first question (src/lib/triage/conversation.ts).
  const { data: unitRow } = await supabase.from("units").select("profile").eq("id", unit.id).maybeSingle();
  const opening = await openConversation(message, {
    rooms: readUnitProfile(unitRow?.profile).rooms,
    profile: readUnitProfile(unitRow?.profile),
    classifyFallback: classifyWithModel,
    understander: openAIUnderstander(),
  });
  const classification_result = opening.classification;
  const emergency = opening.emergency;
  const emergencyDetected = emergency !== null;
  const triageClassification = opening.triageClassification;
  const triageState = "GATHER_INFO";
  const reply = opening.reply;
  const { location: extractedLocation, timing: extractedTiming, status: extractedStatus } = opening.extracted;

  // Create ticket (unit_id is null when tenant has no assigned unit)
  const insertPayload = {
    title: message.slice(0, 200),
    description: message,
    tenant_id: userId,
    unit_id: unit.id,
    tenancy_id: tenancy.id,
    triage_state: triageState,
    classification: triageClassification as unknown as Json,
  };

  const { data: ticket, error: ticketError } = await supabase
    .from("tickets")
    .insert(insertPayload)
    .select("id, trace_id")
    .single();

  if (ticketError || !ticket) {
    logError("chat_ticket_insert", ticketError, {
      code: ticketError?.code,
      hint: ticketError?.hint,
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
    logError("chat_user_message_insert", userMsgErr);
  }

  // Emergency in the very first message: reply with safety guidance now,
  // alert the manager now, and skip all questions/troubleshooting.
  if (emergency) {
    return handleEmergency(
      supabase,
      userId,
      { ...ticket, description: message, triage_state: triageState, unit_id: hasUnit ? unit.id : null },
      triageClassification,
      message,
      emergency,
      start,
      { insertUserMessage: false }
    );
  }

  // Insert bot reply
  const { error: botMsgErr } = await supabase.from("messages").insert({
    ticket_id: ticket.id,
    sender_id: userId,
    body: reply,
    is_bot_reply: true,
  });
  if (botMsgErr) {
    logError("chat_bot_message_insert", botMsgErr);
  }

  logTriageStep({
    trace_id: ticket.trace_id ?? ticket.id,
    ticket_id: ticket.id,
    triage_state: triageState,
    action: "ticket_created",
    latency_ms: Date.now() - start,
    timestamp: new Date().toISOString(),
    metadata: {
      auto_category: classification_result.category,
      auto_confidence: classification_result.confidence,
      emergency_detected: emergencyDetected,
      extracted_location: extractedLocation,
      extracted_timing: extractedTiming,
      extracted_status: extractedStatus,
    },
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
  mediaAction: string | undefined,
  confirmSummary: string | undefined,
  start: number
) {
  // Load ticket
  const { data: ticket, error: ticketError } = await supabase
    .from("tickets")
    .select("id, trace_id, description, triage_state, classification, unit_id")
    .eq("id", ticketId)
    .eq("tenant_id", userId)
    .single();

  if (ticketError || !ticket) {
    logError("chat_ticket_load", ticketError, { ticketId });
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

  // ── EMERGENCY branch: already escalated — record anything new, no troubleshooting ──
  if (ticket.triage_state === "EMERGENCY") {
    if (message) {
      await supabase.from("messages").insert({
        ticket_id: ticket.id,
        sender_id: userId,
        body: message,
        is_bot_reply: false,
      });
    }
    const followUpReply = buildEmergencyFollowUpReply();
    await supabase.from("messages").insert({
      ticket_id: ticket.id,
      sender_id: userId,
      body: followUpReply,
      is_bot_reply: true,
    });
    return NextResponse.json({
      ticket_id: ticket.id,
      reply: followUpReply,
      triage_state: "EMERGENCY",
      is_complete: false,
    });
  }

  // ── Emergency detection on EVERY turn, in every state ──
  // Runs before any state-specific handling so an emergency typed in reply to
  // any question (address, location, a troubleshooting step, the summary…)
  // gets safety guidance immediately and stops troubleshooting.
  // (Phone/email answers are format-validated and skipped: "sparks@…" is not a fire.)
  const emergency = turnEmergency(message, ticket.triage_state, stored);

  if (emergency) {
    return handleEmergency(supabase, userId, ticket, stored, message, emergency, start, {
      insertUserMessage: true,
    });
  }

  // ── CONFIRM_SUMMARY branch ──
  if (ticket.triage_state === "CONFIRM_SUMMARY") {
    const summaryAction = confirmSummary ?? message;
    // Negation-aware: "not right" / "no, that's wrong" must NOT submit.
    const isConfirm = isSummaryConfirmation(summaryAction, confirmSummary);

    // Insert user message
    const userText = isConfirm ? "Looks good, submit" : summaryAction;
    await supabase.from("messages").insert({
      ticket_id: ticket.id,
      sender_id: userId,
      body: userText,
      is_bot_reply: false,
    });

    if (isConfirm) {
      // Proceed to DONE — run the full final completion logic
      return handleFinalCompletion(supabase, userId, ticket, stored, start);
    } else {
      // Tenant typed a correction — try to extract updated fields
      const gathered = stored.gathered ?? buildInitialGathered();

      const newLocation = extractLocation(summaryAction);
      if (newLocation) gathered.location_in_unit = newLocation;

      const newTiming = extractTiming(summaryAction);
      if (newTiming) gathered.started_when = newTiming;

      const newStatus = extractCurrentStatus(summaryAction);
      if (newStatus) gathered.current_status = newStatus;

      const newEquipment = extractEquipment(summaryAction);
      if (newEquipment) gathered.equipment = newEquipment;

      // Re-classify using correction-aware parser (handles "it's X instead of Y")
      const correctedCategory = parseCategoryCorrection(summaryAction, gathered.category ?? "general");
      if (correctedCategory) {
        gathered.category = correctedCategory;
        gathered.subcategory = null; // Reset subcategory when category changes
      }

      // Re-generate tenant summary with corrections
      const { count: corrMediaCount } = await supabase
        .from("ticket_media")
        .select("id", { count: "exact", head: true })
        .eq("ticket_id", ticket.id);

      const updatedSummary = generateTenantSummary({
        description: ticket.description,
        gathered,
        mediaCount: corrMediaCount ?? 0,
        guidedOutcome: stored.guided_troubleshooting?.outcome,
      });

      const correctionClassification: TriageClassification = {
        ...stored,
        gathered,
      };

      const { error: corrUpdateErr } = await supabase
        .from("tickets")
        .update({
          triage_state: "CONFIRM_SUMMARY",
          classification: correctionClassification as unknown as Json,
        })
        .eq("id", ticket.id)
        .select("id")
        .single();
      if (corrUpdateErr) {
        logError("chat_confirm_summary_correction_update", corrUpdateErr, { ticketId: ticket.id });
      }

      const corrReply = "Got it, I've updated your report.\n\n" + updatedSummary;

      await supabase.from("messages").insert({
        ticket_id: ticket.id,
        sender_id: userId,
        body: corrReply,
        is_bot_reply: true,
      });

      logTriageStep({
        trace_id: ticket.trace_id ?? ticket.id,
        ticket_id: ticket.id,
        triage_state: "CONFIRM_SUMMARY",
        action: "summary_correction",
        latency_ms: Date.now() - start,
        timestamp: new Date().toISOString(),
      });

      return NextResponse.json({
        ticket_id: ticket.id,
        reply: corrReply,
        triage_state: "CONFIRM_SUMMARY",
        is_complete: false,
      });
    }
  }

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
      // Validate tenant info — redirect to COLLECT_TENANT_INFO if invalid fields found
      const storedTenantInfo = stored.tenant_info ?? buildInitialTenantInfo();
      const invalidFields = validateTenantInfo(storedTenantInfo);
      if (invalidFields.length > 0) {
        // Clear invalid fields and redirect to collection
        const clearedInfo = { ...storedTenantInfo };
        for (const field of invalidFields) {
          (clearedInfo as Record<string, string | null>)[field] = null;
        }
        const firstMissing = getNextMissingTenantInfo(clearedInfo);
        updatedClassification = {
          gathered: stored.gathered ?? buildInitialGathered(),
          current_question: firstMissing ?? invalidFields[0],
          tenant_info: clearedInfo,
          issue_classification: stored.issue_classification,
          issue_frame: stored.issue_frame,
        };
        reply = "Some of the info we have on file doesn't look right. Let me collect the correct details.\n\n" +
          TENANT_INFO_QUESTIONS[firstMissing ?? invalidFields[0]];
        newState = "COLLECT_TENANT_INFO";
      } else {
      const tiResult = stepTenantInfo(
        storedTenantInfo,
        null,
        ""
      );

      // When transitioning from CONFIRM_PROFILE to GATHER_INFO,
      // preserve auto-classified category and pre-extracted fields from first message
      const gatheredWithCategory = tiResult.gathered ?? stored.gathered ?? buildInitialGathered();
      if (stored.gathered?.category) {
        gatheredWithCategory.category = stored.gathered.category;
      }
      if (stored.gathered?.is_emergency) {
        gatheredWithCategory.is_emergency = stored.gathered.is_emergency;
      }
      if (stored.gathered?.location_in_unit) {
        gatheredWithCategory.location_in_unit = stored.gathered.location_in_unit;
      }
      if (stored.gathered?.started_when) {
        gatheredWithCategory.started_when = stored.gathered.started_when;
      }
      if (stored.gathered?.current_status) {
        gatheredWithCategory.current_status = stored.gathered.current_status;
      }
      if (stored.gathered?.subcategory) {
        gatheredWithCategory.subcategory = stored.gathered.subcategory;
      }
      if (stored.gathered?.entry_point) {
        gatheredWithCategory.entry_point = stored.gathered.entry_point;
      }
      if (stored.gathered?.equipment) {
        gatheredWithCategory.equipment = stored.gathered.equipment;
      }
      if (stored.gathered?.equipment_candidates) {
        gatheredWithCategory.equipment_candidates = stored.gathered.equipment_candidates;
      }
      if (stored.gathered?.sop) gatheredWithCategory.sop = stored.gathered.sop;

      // If fields were pre-extracted, find the actual next question (base or extended)
      let currentQuestion = tiResult.current_question;
      reply = tiResult.reply;

      if (tiResult.next_state === "GATHER_INFO") {
        const nextQ = getNextGatherQuestion(gatheredWithCategory);
        if (nextQ && nextQ.field !== tiResult.current_question) {
          currentQuestion = nextQ.field;
          reply = [
            "Great, thanks for providing your details!",
            "",
            "Now let's get your issue sorted out.",
            "",
            nextQ.text,
          ].join("\n");
        } else if (!nextQ) {
          currentQuestion = null;
          reply = [
            "Great, thanks for confirming your details!",
            "",
            "Thanks for all the details about your issue! Is there anything else you'd like to mention before I proceed?",
          ].join("\n");
        }
      }

      updatedClassification = {
        gathered: gatheredWithCategory,
        current_question: currentQuestion,
        tenant_info: tiResult.tenant_info,
        issue_classification: stored.issue_classification,
        issue_frame: stored.issue_frame,
      };
      newState = tiResult.next_state;
      } // end valid tenant info else
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
        issue_classification: stored.issue_classification,
        issue_frame: stored.issue_frame,
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
      logError("chat_confirm_profile_update", updateErr, { ticketId: ticket.id });
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
      logError("chat_confirm_profile_user_msg", cpUserMsgErr);
    }

    // Insert bot reply
    const { error: cpBotMsgErr } = await supabase.from("messages").insert({
      ticket_id: ticket.id,
      sender_id: userId,
      body: reply,
      is_bot_reply: true,
    });
    if (cpBotMsgErr) {
      logError("chat_confirm_profile_bot_msg", cpBotMsgErr);
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

    // Preserve auto-classified category and pre-extracted fields when transitioning to GATHER_INFO
    const gatheredWithCategory = tiResult.gathered ?? stored.gathered ?? buildInitialGathered();
    if (stored.gathered?.category) {
      gatheredWithCategory.category = stored.gathered.category;
    }
    if (stored.gathered?.is_emergency) {
      gatheredWithCategory.is_emergency = stored.gathered.is_emergency;
    }
    if (stored.gathered?.location_in_unit) {
      gatheredWithCategory.location_in_unit = stored.gathered.location_in_unit;
    }
    if (stored.gathered?.started_when) {
      gatheredWithCategory.started_when = stored.gathered.started_when;
    }
    if (stored.gathered?.current_status) {
      gatheredWithCategory.current_status = stored.gathered.current_status;
    }
    if (stored.gathered?.subcategory) {
      gatheredWithCategory.subcategory = stored.gathered.subcategory;
    }
    if (stored.gathered?.entry_point) {
      gatheredWithCategory.entry_point = stored.gathered.entry_point;
    }
    if (stored.gathered?.sop) gatheredWithCategory.sop = stored.gathered.sop;

    // If fields were pre-extracted, find the actual next question (base or extended)
    let tiCurrentQuestion = tiResult.current_question;
    let tiReply = tiResult.reply;

    if (tiResult.next_state === "GATHER_INFO") {
      const nextQ = getNextGatherQuestion(gatheredWithCategory);
      if (nextQ && nextQ.field !== tiResult.current_question) {
        tiCurrentQuestion = nextQ.field;
        tiReply = [
          "Great, thanks for providing your details!",
          "",
          "Now let's get your issue sorted out.",
          "",
          nextQ.text,
        ].join("\n");
      } else if (!nextQ) {
        tiCurrentQuestion = null;
        tiReply = [
          "Great, thanks for providing your details!",
          "",
          "Thanks for all the details about your issue! Is there anything else you'd like to mention before I proceed?",
        ].join("\n");
      }
    }

    const updatedClassification: TriageClassification = {
      gathered: gatheredWithCategory,
      current_question: tiCurrentQuestion,
      tenant_info: tiResult.tenant_info,
      issue_classification: stored.issue_classification,
      issue_frame: stored.issue_frame,
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
      logError("chat_tenant_info_update", updateErr, { ticketId: ticket.id });
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
          logError("chat_profile_defaults_update", profileErr, {
            userId,
            fields: Object.keys(profileUpdate),
          });
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
      logError("chat_tenant_info_user_msg", tiUserMsgErr);
    }

    // Insert bot reply
    const { error: tiBotMsgErr } = await supabase.from("messages").insert({
      ticket_id: ticket.id,
      sender_id: userId,
      body: tiReply,
      is_bot_reply: true,
    });
    if (tiBotMsgErr) {
      logError("chat_tenant_info_bot_msg", tiBotMsgErr);
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
        question: tiCurrentQuestion,
      },
    });

    return NextResponse.json({
      ticket_id: ticket.id,
      reply: tiReply,
      triage_state: tiResult.next_state,
      is_complete: false,
    });
  }

  // ── AWAITING_MEDIA branch ──
  if (ticket.triage_state === "AWAITING_MEDIA") {
    const action = mediaAction ?? message;
    const isSkip = /\b(skip|no|none|no thanks|later)\b/i.test(action);

    // Insert user message
    const userText = isSkip ? "Skip" : action;
    await supabase.from("messages").insert({
      ticket_id: ticket.id,
      sender_id: userId,
      body: userText,
      is_bot_reply: false,
    });

    // Proceed to retrieval + grounding
    return handleRetrievalAndCompletion(
      supabase,
      userId,
      ticket,
      stored,
      start
    );
  }

  // ── GUIDED_TROUBLESHOOTING branch ──
  if (ticket.triage_state === "GUIDED_TROUBLESHOOTING") {
    const guidedState = stored.guided_troubleshooting;
    if (!guidedState) {
      logError("chat_guided_no_state", new Error("GUIDED_TROUBLESHOOTING but no guided state"), { ticketId: ticket.id });
      return NextResponse.json(
        { error: "Missing guided troubleshooting state" },
        { status: 500 }
      );
    }

    const currentStep = guidedState.steps[guidedState.current_step_index];
    if (!currentStep) {
      logError("chat_guided_no_current_step", new Error("GUIDED_TROUBLESHOOTING but no current step"), {
        ticketId: ticket.id,
        index: guidedState.current_step_index,
        totalSteps: guidedState.steps.length,
      });
      return NextResponse.json(
        { error: "Invalid guided troubleshooting step index" },
        { status: 500 }
      );
    }

    // Insert user message
    await supabase.from("messages").insert({
      ticket_id: ticket.id,
      sender_id: userId,
      body: message,
      is_bot_reply: false,
    });

    // ── Equipment correction detection ──
    // If the tenant says "it's not a refrigerator, it's a range hood", we
    // re-enter the retrieval pipeline with the corrected equipment so the
    // guided steps match the actual appliance.
    const gatheredEarly = stored.gathered ?? buildInitialGathered();
    const correction = detectEquipmentCorrection(message, gatheredEarly.equipment);
    if (correction.detected && correction.equipment) {
      const correctedGathered = { ...gatheredEarly, equipment: correction.equipment };

      // If the corrected equipment implies a different category, update it
      const newCategory = getEquipmentCategory(correction.equipment);
      const previousCategory = correctedGathered.category;
      if (newCategory && newCategory !== correctedGathered.category) {
        correctedGathered.category = newCategory;
        correctedGathered.subcategory = null;
      }

      // Infer location from the corrected equipment if not already set
      if (!correctedGathered.location_in_unit) {
        const inferred = inferLocationFromEquipment(correction.equipment);
        if (inferred) correctedGathered.location_in_unit = inferred;
      }

      const updatedStored: TriageClassification = {
        ...stored,
        gathered: correctedGathered,
        issue_classification: newCategory && newCategory !== previousCategory
          ? { category: newCategory, confidence: "high", rationale: `equipment_correction: ${correction.equipment}` }
          : stored.issue_classification,
        retrieval: undefined,
        guided_troubleshooting: undefined,
        validation: undefined,
      };

      logTriageStep({
        trace_id: ticket.trace_id ?? ticket.id,
        ticket_id: ticket.id,
        triage_state: "GUIDED_TROUBLESHOOTING",
        action: "equipment_correction",
        latency_ms: Date.now() - start,
        timestamp: new Date().toISOString(),
        metadata: {
          previous_equipment: gatheredEarly.equipment,
          corrected_equipment: correction.equipment,
          previous_category: previousCategory,
          corrected_category: correctedGathered.category,
        },
      });

      return handleRetrievalAndCompletion(supabase, userId, ticket, updatedStored, start);
    }

    // Check for newly reported entry point during guided troubleshooting
    const gathered = stored.gathered ?? buildInitialGathered();
    if (!gathered.entry_point) {
      const ep = extractEntryPoint(message);
      if (ep) {
        gathered.entry_point = ep;
        // If pest_control + new entry point → escalate out of guided loop
        const guidedPestEsc = checkPestEscalation(gathered, message);
        if (guidedPestEsc.shouldEscalate) {
          const entryNote = ` We've noted the entry point you reported (${gathered.entry_point}) and will include that in the work order.`;
          const escReply = [
            `Thanks for that detail.${entryNote} This pest issue needs professional attention.`,
            "",
            "Your property manager has been notified and will arrange for a licensed pest control service.",
          ].join("\n");

          const finalGuidedState: GuidedTroubleshootingState = {
            ...guidedState,
            outcome: "escalated",
          };

          return handleGuidedComplete(
            supabase,
            userId,
            ticket,
            { ...stored, gathered, guided_troubleshooting: finalGuidedState },
            finalGuidedState,
            escReply,
            true,
            start
          );
        }
      }
    }

    // Classify feedback: regex fast-path → LLM for ambiguous replies → fallback
    const {
      result: feedback,
      note: extractedNote,
      source: interpretationSource,
    } = await classifyStepHybrid(
      message,
      currentStep,
      gathered.category ?? "general",
      gathered.subcategory ?? null
    );

    // Capture previous result BEFORE overwriting the log entry (for escape-hatch logic)
    const previousResult = guidedState.log.find(
      (e) => e.step_index === guidedState.current_step_index
    )?.result ?? null;

    // Update log entry
    const updatedLog = [...guidedState.log];
    const logIdx = updatedLog.findIndex(
      (e) => e.step_index === guidedState.current_step_index
    );
    if (logIdx >= 0) {
      updatedLog[logIdx] = {
        ...updatedLog[logIdx],
        responded_at: new Date().toISOString(),
        raw_response: message.slice(0, 500),
        result: feedback,
        ...(extractedNote ? { note: extractedNote } : {}),
        interpretation_source: interpretationSource,
      };
    }

    // Build state with updated log for decision-making
    const stateForDecision: GuidedTroubleshootingState = {
      ...guidedState,
      log: updatedLog,
    };

    // Unsafe reply during troubleshooting (scared, getting worse, LLM-detected
    // emergency, …) → stop troubleshooting and escalate now.
    if (feedback === "unsafe") {
      const unsafeStored: TriageClassification = {
        ...stored,
        gathered,
        guided_troubleshooting: { ...guidedState, log: updatedLog, outcome: "escalated" },
      };
      return handleEmergency(
        supabase,
        userId,
        ticket,
        unsafeStored,
        message,
        { kind: "unconfirmed_safety", phrase: message.slice(0, 120) },
        start,
        { insertUserMessage: false }
      );
    }

    // Determine next action
    const action = determineNextAction(stateForDecision, feedback, previousResult);

    const traceId = ticket.trace_id ?? ticket.id;

    // ── Clarify: re-ask without advancing ──
    if (action.type === "clarify") {
      const reply = buildClarifyReply(currentStep);

      const clarifyGuidedState: GuidedTroubleshootingState = {
        ...guidedState,
        log: updatedLog,
      };

      const clarifyClassification: TriageClassification = {
        ...stored,
        guided_troubleshooting: clarifyGuidedState,
      };

      const { error: clarifyUpdateErr } = await supabase
        .from("tickets")
        .update({
          triage_state: "GUIDED_TROUBLESHOOTING",
          classification: clarifyClassification as unknown as Json,
        })
        .eq("id", ticket.id)
        .select("id")
        .single();
      if (clarifyUpdateErr) {
        logError("chat_guided_clarify_update", clarifyUpdateErr, { ticketId: ticket.id });
      }

      await supabase.from("messages").insert({
        ticket_id: ticket.id,
        sender_id: userId,
        body: reply,
        is_bot_reply: true,
      });

      logTriageStep({
        trace_id: traceId,
        ticket_id: ticket.id,
        triage_state: "GUIDED_TROUBLESHOOTING",
        action: "guided_clarify",
        latency_ms: Date.now() - start,
        timestamp: new Date().toISOString(),
        metadata: {
          step_index: guidedState.current_step_index,
          feedback,
          interpretation_source: interpretationSource,
        },
      });

      return NextResponse.json({
        ticket_id: ticket.id,
        reply,
        triage_state: "GUIDED_TROUBLESHOOTING",
        is_complete: false,
      });
    }

    // ── Provide help: generate contextual explanation, stay on same step ──
    if (action.type === "provide_help") {
      const helpText = await generateStepHelp(
        currentStep,
        gathered.equipment ?? null,
        gathered.category ?? "general"
      );
      const reply = buildHelpReply(helpText, currentStep);

      const helpGuidedState: GuidedTroubleshootingState = {
        ...guidedState,
        log: updatedLog,
      };

      const helpClassification: TriageClassification = {
        ...stored,
        guided_troubleshooting: helpGuidedState,
      };

      const { error: helpUpdateErr } = await supabase
        .from("tickets")
        .update({
          triage_state: "GUIDED_TROUBLESHOOTING",
          classification: helpClassification as unknown as Json,
        })
        .eq("id", ticket.id)
        .select("id")
        .single();
      if (helpUpdateErr) {
        logError("chat_guided_help_update", helpUpdateErr, { ticketId: ticket.id });
      }

      await supabase.from("messages").insert({
        ticket_id: ticket.id,
        sender_id: userId,
        body: reply,
        is_bot_reply: true,
      });

      logTriageStep({
        trace_id: traceId,
        ticket_id: ticket.id,
        triage_state: "GUIDED_TROUBLESHOOTING",
        action: "guided_help",
        latency_ms: Date.now() - start,
        timestamp: new Date().toISOString(),
        metadata: {
          step_index: guidedState.current_step_index,
          feedback,
          interpretation_source: interpretationSource,
        },
      });

      return NextResponse.json({
        ticket_id: ticket.id,
        reply,
        triage_state: "GUIDED_TROUBLESHOOTING",
        is_complete: false,
      });
    }

    // ── Terminal actions → complete ──
    if (action.type === "resolved" || action.type === "escalate" || action.type === "all_steps_done") {
      const outcomeMap = {
        resolved: "resolved" as const,
        escalate: "escalated" as const,
        all_steps_done: "all_steps_done" as const,
      };

      const finalGuidedState: GuidedTroubleshootingState = {
        ...guidedState,
        log: updatedLog,
        outcome: outcomeMap[action.type],
      };

      const termGuidance = getTerminalGuidance(finalGuidedState);
      const replyOpts = { currentStepKind: currentStep.step_kind, extractedNote: extractedNote };
      const reply = buildFeedbackReply(feedback, action, undefined, termGuidance, replyOpts);

      return handleGuidedComplete(
        supabase,
        userId,
        ticket,
        stored,
        finalGuidedState,
        reply,
        action.type === "escalate",
        start
      );
    }

    // ── Continuing → find next eligible step (dependency-aware) ──
    const nextStepIndex = findNextEligibleStep(stateForDecision, guidedState.current_step_index);

    if (nextStepIndex === null) {
      // No eligible steps remain — treat as all_steps_done
      const finalGuidedState: GuidedTroubleshootingState = {
        ...guidedState,
        log: updatedLog,
        outcome: "all_steps_done",
      };

      const termGuidance = getTerminalGuidance(finalGuidedState);
      const replyOpts = { currentStepKind: currentStep.step_kind, extractedNote: extractedNote };
      const reply = buildFeedbackReply(feedback, { type: "all_steps_done" }, undefined, termGuidance, replyOpts);

      return handleGuidedComplete(
        supabase,
        userId,
        ticket,
        stored,
        finalGuidedState,
        reply,
        false,
        start
      );
    }

    const nextStep = guidedState.steps[nextStepIndex];

    // Build reply with next step embedded
    const replyOpts = { currentStepKind: currentStep.step_kind, extractedNote: extractedNote };
    const reply = buildFeedbackReply(feedback, action, nextStep, undefined, replyOpts);

    // Create log entry for the new step
    const nextLogEntry: TroubleshootingLogEntry = {
      step_index: nextStepIndex,
      presented_at: new Date().toISOString(),
      responded_at: null,
      raw_response: null,
      result: null,
    };

    const advancedGuidedState: GuidedTroubleshootingState = {
      ...guidedState,
      current_step_index: nextStepIndex,
      log: [...updatedLog, nextLogEntry],
      outcome: "in_progress",
    };

    const updatedClassification: TriageClassification = {
      ...stored,
      guided_troubleshooting: advancedGuidedState,
    };

    const { error: guidedUpdateErr } = await supabase
      .from("tickets")
      .update({
        triage_state: "GUIDED_TROUBLESHOOTING",
        classification: updatedClassification as unknown as Json,
      })
      .eq("id", ticket.id)
      .select("id")
      .single();
    if (guidedUpdateErr) {
      logError("chat_guided_step_update", guidedUpdateErr, { ticketId: ticket.id });
    }

    // Insert bot reply
    await supabase.from("messages").insert({
      ticket_id: ticket.id,
      sender_id: userId,
      body: reply,
      is_bot_reply: true,
    });

    logTriageStep({
      trace_id: traceId,
      ticket_id: ticket.id,
      triage_state: "GUIDED_TROUBLESHOOTING",
      action: "guided_step_advance",
      latency_ms: Date.now() - start,
      timestamp: new Date().toISOString(),
      metadata: {
        step_index: guidedState.current_step_index,
        feedback,
        next_step_index: nextStepIndex,
        interpretation_source: interpretationSource,
        ...(extractedNote ? { extracted_note: extractedNote } : {}),
      },
    });

    return NextResponse.json({
      ticket_id: ticket.id,
      reply,
      triage_state: "GUIDED_TROUBLESHOOTING",
      is_complete: false,
    });
  }

  // ── GATHER_INFO branch ──
  const traceId = ticket.trace_id ?? ticket.id;
  // A reply can add to (or correct) what we understood; urgency never drops.
  await updateIssueFrame(stored, ticket.description, message, openAIUnderstander());
  const gatherStep = advanceGather({
    stored,
    description: ticket.description,
    triageState: ticket.triage_state,
    message,
  });
  const gathered = gatherStep.gathered;

  // Water near an outlet/light (or "not sure") → stop and escalate now.
  if (gatherStep.kind === "emergency") {
    return handleEmergency(
      supabase,
      userId,
      ticket,
      { ...stored, gathered },
      message,
      gatherStep.emergency,
      start,
      { insertUserMessage: true }
    );
  }

  if (gatherStep.kind === "ask") {
    const nextQuestion = gatherStep.nextQuestion || null;
    const botReply = gatherStep.reply;
    const updatedClassification: TriageClassification = {
      gathered,
      current_question: nextQuestion,
      tenant_info: stored.tenant_info,
      issue_classification: stored.issue_classification,
      issue_frame: stored.issue_frame,
      safety_detection: stored.safety_detection,
      media_refs: stored.media_refs,
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
      logError("chat_gather_update", gatherUpdateErr, { ticketId: ticket.id });
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

  // ── All fields gathered — danger check before photos ──
  const next = afterGather(gathered, ticket.description, stored);
  if (next.kind === "emergency") {
    return handleEmergency(
      supabase,
      userId,
      ticket,
      { ...stored, gathered },
      message,
      next.emergency,
      start,
      { insertUserMessage: true }
    );
  }
  if (next.kind === "safety_question") {
    // Need to ask a targeted safety question
    const updatedClassification: TriageClassification = {
      gathered,
      current_question: "safety_check",
      tenant_info: stored.tenant_info,
      issue_classification: stored.issue_classification,
      issue_frame: stored.issue_frame,
      media_refs: stored.media_refs,
      retrieval: stored.retrieval,
      summary: stored.summary,
    };

    const { error: safetyUpdateErr } = await supabase
      .from("tickets")
      .update({
        triage_state: "GATHER_INFO",
        classification: updatedClassification as unknown as Json,
      })
      .eq("id", ticket.id)
      .select("id")
      .single();
    if (safetyUpdateErr) {
      logError("chat_safety_update", safetyUpdateErr, { ticketId: ticket.id });
    }

    await supabase.from("messages").insert({
      ticket_id: ticket.id,
      sender_id: userId,
      body: message,
      is_bot_reply: false,
    });
    await supabase.from("messages").insert({
      ticket_id: ticket.id,
      sender_id: userId,
      body: next.question,
      is_bot_reply: true,
    });

    logTriageStep({
      trace_id: traceId,
      ticket_id: ticket.id,
      triage_state: "GATHER_INFO",
      action: "safety_check",
      latency_ms: Date.now() - start,
      timestamp: new Date().toISOString(),
    });

    return NextResponse.json({
      ticket_id: ticket.id,
      reply: next.question,
      triage_state: "GATHER_INFO",
      is_complete: false,
    });
  }

  // ── Transition to AWAITING_MEDIA ──
  // Damage prevention first (leaks), then a shot list for this kind of issue.
  const { data: unitRow } = ticket.unit_id
    ? await supabase.from("units").select("profile").eq("id", ticket.unit_id).maybeSingle()
    : { data: null };
  const mediaPrompt = buildMediaPrompt(gathered, readUnitProfile(unitRow?.profile));

  const mediaClassification: TriageClassification = {
    gathered,
    current_question: null,
    tenant_info: stored.tenant_info,
    issue_classification: stored.issue_classification,
    issue_frame: stored.issue_frame,
    safety_detection: stored.safety_detection,
    media_refs: stored.media_refs,
    retrieval: stored.retrieval,
    summary: stored.summary,
  };

  const { error: mediaUpdateErr } = await supabase
    .from("tickets")
    .update({
      triage_state: "AWAITING_MEDIA",
      classification: mediaClassification as unknown as Json,
    })
    .eq("id", ticket.id)
    .select("id")
    .single();
  if (mediaUpdateErr) {
    logError("chat_media_update", mediaUpdateErr, { ticketId: ticket.id });
  }

  await supabase.from("messages").insert({
    ticket_id: ticket.id,
    sender_id: userId,
    body: message,
    is_bot_reply: false,
  });
  await supabase.from("messages").insert({
    ticket_id: ticket.id,
    sender_id: userId,
    body: mediaPrompt,
    is_bot_reply: true,
  });

  logTriageStep({
    trace_id: traceId,
    ticket_id: ticket.id,
    triage_state: "AWAITING_MEDIA",
    action: "awaiting_media",
    latency_ms: Date.now() - start,
    timestamp: new Date().toISOString(),
  });

  return NextResponse.json({
    ticket_id: ticket.id,
    reply: mediaPrompt,
    triage_state: "AWAITING_MEDIA",
    is_complete: false,
  });
}

// ── Retrieval + Grounding + Summary → DONE ──

async function handleRetrievalAndCompletion(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  ticket: { id: string; trace_id: string | null; description: string; triage_state: string; classification: Json | null; unit_id: string | null },
  stored: TriageClassification,
  start: number
) {
  const traceId = ticket.trace_id ?? ticket.id;
  const gathered = stored.gathered ?? buildInitialGathered();
  const isEmergency = gathered.is_emergency ?? false;

  console.log("[triage] GATHER_INFO complete — entering retrieval pipeline", {
    ticketId: ticket.id,
    category: gathered.category,
    subcategory: gathered.subcategory,
    equipment: gathered.equipment,
    isEmergency,
    hasStoredRetrieval: !!stored.retrieval,
  });

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
      console.log("[triage] retrieval completed", {
        ticketId: ticket.id,
        snippetCount: snippets.length,
        lowConfidence,
        highestScore: result.log.highest_score,
      });
    } catch (err) {
      logError("chat_retrieval", err, { ticketId: ticket.id });
    }
  } else {
    snippets = retrievalLog.matches.map((m) => ({
      id: m.id,
      score: m.score,
      title: String(m.metadata?.title ?? m.id),
      content: String(m.metadata?.content ?? m.metadata?.text ?? ""),
      metadata: m.metadata,
    }));
    lowConfidence = retrievalLog.low_confidence;
    console.log("[triage] using stored retrieval", {
      ticketId: ticket.id,
      snippetCount: snippets.length,
      lowConfidence,
    });
  }

  // ── Pest escalation check ──
  const pestEscalation = checkPestEscalation(gathered, ticket.description);
  if (pestEscalation.shouldEscalate) {
    const entryNote = gathered.entry_point
      ? ` We've noted the entry point you reported (${gathered.entry_point}) and will include that in the work order.`
      : "";
    const escalationReply = [
      `Based on what you've described, this pest issue needs professional attention.${entryNote}`,
      "",
      "Your property manager has been notified and will arrange for a licensed pest control service. They should be in touch within 1 business day.",
      "",
      "In the meantime, please keep food stored in sealed containers and avoid disturbing any areas where you've noticed activity.",
    ].join("\n");

    const escalationClassification: TriageClassification = {
      gathered,
      current_question: null,
      tenant_info: stored.tenant_info,
      issue_classification: stored.issue_classification,
      issue_frame: stored.issue_frame,
      safety_detection: stored.safety_detection,
      media_refs: stored.media_refs,
      retrieval: retrievalLog ?? undefined,
      summary: `Pest escalation: ${pestEscalation.reason}`,
    };

    const { error: escalateErr } = await supabase
      .from("tickets")
      .update({
        triage_state: "DONE",
        classification: escalationClassification as unknown as Json,
        category: (gathered.category ?? "general") as Database["public"]["Enums"]["ticket_category"],
      })
      .eq("id", ticket.id)
      .select("id")
      .single();
    if (escalateErr) {
      logError("chat_pest_escalation_update", escalateErr, { ticketId: ticket.id });
    }
    // The tenant RLS policy rejects status = 'escalated' — set server-side.
    await setPrivilegedTicketFields(ticket.id, userId, { priority: "high", status: "escalated" });

    await supabase.from("messages").insert({
      ticket_id: ticket.id,
      sender_id: userId,
      body: escalationReply,
      is_bot_reply: true,
    });

    logTriageStep({
      trace_id: traceId,
      ticket_id: ticket.id,
      triage_state: "DONE",
      action: "pest_escalation",
      latency_ms: Date.now() - start,
      timestamp: new Date().toISOString(),
      metadata: {
        reason: pestEscalation.reason,
        subcategory: gathered.subcategory,
        entry_point: gathered.entry_point,
      },
    });

    // Email PM (awaited so serverless doesn't terminate before send completes)
    const pestPmEmail = await getManagerEmailForTicket(ticket.id, ticket.unit_id, stored.tenant_info?.reported_address);
    if (pestPmEmail) {
      const emailResult = await sendTicketSummaryEmail({
        to: pestPmEmail,
        ticketId: ticket.id,
        ticketTitle: ticket.description?.slice(0, 80) ?? ticket.id,
        summary: escalationClassification.summary ?? "",
        isEmergency: true,
        category: gathered.category ?? "pest_control",
      });
      if (!emailResult.success) {
        logError("email_send_failed", emailResult.error, { ticketId: ticket.id });
      }
    }

    return NextResponse.json({
      ticket_id: ticket.id,
      reply: escalationReply,
      triage_state: "DONE",
      is_complete: true,
    });
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
    logError("chat_grounding", err, { ticketId: ticket.id });
    const sop = getFallbackSOP(gathered.category ?? "general", isEmergency, gathered.subcategory, gathered.equipment, gathered.subcategory);
    groundedResult = {
      reply: sop.display,
      steps: sop.steps,
      usedFallback: true,
    };
  }

  console.log("[triage] grounding result", {
    ticketId: ticket.id,
    usedFallback: groundedResult.usedFallback,
    usedWebSearch: groundedResult.usedWebSearch ?? false,
    stepCount: groundedResult.steps.length,
    steps: groundedResult.steps.map((s) => s.description.slice(0, 80)),
    equipment: gathered.equipment,
  });

  // ── Equipment-aware step filtering ──
  // Remove steps that mention unrelated appliances (e.g., "refrigerator" when
  // the actual equipment is a "range hood"). Applies to both grounded and fallback steps.
  const preFilterCount = groundedResult.steps.length;
  groundedResult = filterStepsByEquipment(
    groundedResult,
    gathered.equipment,
    gathered.category ?? "general",
    isEmergency,
    gathered.subcategory
  );
  if (preFilterCount !== groundedResult.steps.length) {
    console.log("[triage] equipment filter applied", {
      ticketId: ticket.id,
      equipment: gathered.equipment,
      before: preFilterCount,
      after: groundedResult.steps.length,
      usedFallbackAfterFilter: groundedResult.usedFallback,
    });
  }

  // ── Validation loop ──
  const rHighest = retrievalLog?.highest_score ?? 0;
  const rAverage = retrievalLog?.average_score ?? 0;

  let validation: ValidationResult = validateGroundedResult(
    groundedResult,
    snippets,
    gathered,
    rHighest,
    rAverage
  );

  if (!validation.is_valid) {
    if (validation.missing_safety_guidance) {
      const EMERGENCY_SAFETY_BLOCK = [
        "**SAFETY ALERT**: Your issue has been flagged as a potential emergency.",
        "",
        "**IMMEDIATE ACTIONS:**",
        "1. If you smell gas, leave the unit immediately and contact the FortisBC gas emergency line.",
        "2. If there's flooding, turn off the main water valve if it is safe to do so.",
        "3. If there's a fire or smoke, evacuate and call 911.",
        "4. Do NOT re-enter the unit until cleared by emergency services or your property manager.",
        "",
        "Your ticket has been escalated to your property manager for urgent review. The property manager should contact you within 2 hours.",
        "",
        "---",
        "",
      ].join("\n");

      groundedResult = {
        reply: EMERGENCY_SAFETY_BLOCK + groundedResult.reply,
        steps: groundedResult.steps,
        usedFallback: groundedResult.usedFallback,
      };
      validation = { ...validation, action_taken: "prepend_safety", missing_safety_guidance: false };

      const recheck = validateGroundedResult(
        groundedResult,
        snippets,
        gathered,
        rHighest,
        rAverage
      );
      validation = { ...recheck, action_taken: "prepend_safety" };
    }

    if (validation.missing_citations) {
      // Try web search before falling back to hardcoded SOP
      const webResult = await generateWebSearchSteps(gathered, isEmergency);
      if (webResult) {
        groundedResult = webResult;
        validation = { ...validation, action_taken: "web_search_fallback" };
      } else {
        const sop = getFallbackSOP(gathered.category ?? "general", isEmergency, gathered.subcategory, gathered.equipment, gathered.subcategory);
        groundedResult = {
          reply: sop.display,
          steps: sop.steps,
          usedFallback: true,
        };
        validation = { ...validation, action_taken: "fallback_sop" };
      }
    } else if (validation.domain_mismatch) {
      logWarn("chat_domain_mismatch", "Domain mismatch detected — trying web search before SOP fallback", {
        ticketId: ticket.id,
        category: gathered.category,
        reasons: validation.reasons.filter((r: string) => r.startsWith("domain_mismatch")),
      });
      // Try web search before falling back to hardcoded SOP
      const webResult = await generateWebSearchSteps(gathered, isEmergency);
      if (webResult) {
        groundedResult = webResult;
        validation = { ...validation, action_taken: "web_search_fallback" };
      } else {
        const sop = getFallbackSOP(gathered.category ?? "general", isEmergency, gathered.subcategory, gathered.equipment, gathered.subcategory);
        groundedResult = {
          reply: sop.display,
          steps: sop.steps,
          usedFallback: true,
        };
        validation = { ...validation, action_taken: "fallback_sop" };
      }
    } else if (validation.low_confidence) {
      // Don't override web search results — they're already internet-grounded
      if (groundedResult.usedWebSearch) {
        validation = { ...validation, action_taken: "none", low_confidence: false };
      } else {
        // Try web search before falling back to hardcoded SOP
        const webResult = await generateWebSearchSteps(gathered, isEmergency);
        if (webResult) {
          groundedResult = webResult;
          validation = { ...validation, action_taken: "web_search_fallback" };
        } else {
          const sop = getFallbackSOP(gathered.category ?? "general", isEmergency, gathered.subcategory, gathered.equipment, gathered.subcategory);
          const disclaimer =
            "Note: We could not find a high-confidence match in our knowledge base for your specific issue. " +
            "Here are general troubleshooting steps for this category:\n\n";
          groundedResult = {
            reply: disclaimer + sop.display,
            steps: sop.steps,
            usedFallback: true,
          };
          validation = { ...validation, action_taken: "fallback_sop_with_disclaimer" };
        }
      }
    }
  } else {
    validation = { ...validation, action_taken: "none" };
  }

  // ── Never-instruct post-filter (all sources: grounded, web, SOP) ──
  const safeResult = enforceStepSafety(groundedResult);
  if (safeResult.removedUnsafe.length > 0) {
    logWarn("chat_unsafe_steps_removed", "Removed unsafe troubleshooting steps", {
      ticketId: ticket.id,
      rules: safeResult.removedUnsafe,
    });
  }
  groundedResult = safeResult;

  // Some reports go straight to the manager (neighbour noise): no troubleshooting.
  const managerReply = managerOnlyReply(gathered);
  if (managerReply) groundedResult = { ...groundedResult, reply: managerReply, steps: [] };

  // ── Guided troubleshooting bifurcation ──
  // SOP-driven: enter guided mode when steps contain safe, actionable content
  // regardless of whether they came from retrieval or fallback SOPs.
  if (groundedResult.steps.length > 0) {
    const guidedSteps = convertToGuidedSteps(groundedResult.steps);

    if (shouldUseGuidedTroubleshooting(guidedSteps, isEmergency)) {
    const firstStep = guidedSteps[0];

    const firstLogEntry: TroubleshootingLogEntry = {
      step_index: 0,
      presented_at: new Date().toISOString(),
      responded_at: null,
      raw_response: null,
      result: null,
    };

    const guidedState: GuidedTroubleshootingState = {
      steps: guidedSteps,
      current_step_index: 0,
      log: [firstLogEntry],
      outcome: "in_progress",
    };

    const guidedReply = buildStepMessage(firstStep, true);

    const guidedClassification: TriageClassification = {
      gathered,
      current_question: null,
      tenant_info: stored.tenant_info,
      issue_classification: stored.issue_classification,
      issue_frame: stored.issue_frame,
      safety_detection: stored.safety_detection,
      media_refs: stored.media_refs,
      retrieval: retrievalLog ?? undefined,
      validation,
      guided_troubleshooting: guidedState,
    };

    const { error: guidedUpdateErr } = await supabase
      .from("tickets")
      .update({
        triage_state: "GUIDED_TROUBLESHOOTING",
        classification: guidedClassification as unknown as Json,
      })
      .eq("id", ticket.id)
      .select("id")
      .single();
    if (guidedUpdateErr) {
      logError("chat_guided_init_update", guidedUpdateErr, { ticketId: ticket.id });
    }

    // Insert bot reply with first step
    await supabase.from("messages").insert({
      ticket_id: ticket.id,
      sender_id: userId,
      body: guidedReply,
      is_bot_reply: true,
    });

    logTriageStep({
      trace_id: traceId,
      ticket_id: ticket.id,
      triage_state: "GUIDED_TROUBLESHOOTING",
      action: "guided_start",
      latency_ms: Date.now() - start,
      timestamp: new Date().toISOString(),
      metadata: {
        total_steps: guidedSteps.length,
        used_fallback: groundedResult.usedFallback,
        used_web_search: groundedResult.usedWebSearch ?? false,
        retrieval_matches: retrievalLog?.matches.length ?? 0,
      },
    });

    return NextResponse.json({
      ticket_id: ticket.id,
      reply: guidedReply,
      triage_state: "GUIDED_TROUBLESHOOTING",
      is_complete: false,
    });
    } // shouldUseGuidedTroubleshooting
  }

  // ── Transition to CONFIRM_SUMMARY instead of DONE ──
  // Store all enrichments so handleFinalCompletion can use them when tenant confirms.
  const { count: mediaCount } = await supabase
    .from("ticket_media")
    .select("id", { count: "exact", head: true })
    .eq("ticket_id", ticket.id);

  const tenantSummary = generateTenantSummary({
    description: ticket.description,
    gathered,
    mediaCount: mediaCount ?? 0,
  });

  const confirmClassification: TriageClassification = {
    gathered,
    current_question: null,
    tenant_info: stored.tenant_info,
    issue_classification: stored.issue_classification,
    issue_frame: stored.issue_frame,
    safety_detection: stored.safety_detection,
    media_refs: stored.media_refs,
    retrieval: retrievalLog ?? undefined,
    validation,
  };

  const { error: confirmUpdateErr } = await supabase
    .from("tickets")
    .update({
      triage_state: "CONFIRM_SUMMARY",
      classification: confirmClassification as unknown as Json,
      // Pre-set ticket fields so they're visible even before final DONE
      category: (gathered.category ?? "general") as Database["public"]["Enums"]["ticket_category"],
      troubleshooting_steps: groundedResult.steps as unknown as Json,
    })
    .eq("id", ticket.id)
    .select("id")
    .single();
  if (confirmUpdateErr) {
    logError("chat_confirm_summary_update", confirmUpdateErr, { ticketId: ticket.id });
  }

  // Send troubleshooting steps first, then tenant summary
  const combinedReply = groundedResult.reply + "\n\n---\n\n" + tenantSummary;

  await supabase.from("messages").insert({
    ticket_id: ticket.id,
    sender_id: userId,
    body: combinedReply,
    is_bot_reply: true,
  });

  logTriageStep({
    trace_id: traceId,
    ticket_id: ticket.id,
    triage_state: "CONFIRM_SUMMARY",
    action: "confirm_summary_shown",
    latency_ms: Date.now() - start,
    timestamp: new Date().toISOString(),
    metadata: {
      gathered_fields: Object.entries(gathered)
        .filter(([, v]) => v !== null)
        .map(([k]) => k),
      retrieval_matches: retrievalLog?.matches.length ?? 0,
      used_fallback: groundedResult.usedFallback,
      used_web_search: groundedResult.usedWebSearch ?? false,
      validation_valid: validation.is_valid,
      validation_action: validation.action_taken,
    },
  });

  return NextResponse.json({
    ticket_id: ticket.id,
    reply: combinedReply,
    triage_state: "CONFIRM_SUMMARY",
    is_complete: false,
  });
}

// ── Guided troubleshooting terminal handler ──

async function handleGuidedComplete(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  ticket: { id: string; trace_id: string | null; description: string; triage_state: string; classification: Json | null; unit_id: string | null },
  stored: TriageClassification,
  guidedState: GuidedTroubleshootingState,
  reply: string,
  isEscalated: boolean,
  start: number
) {
  const traceId = ticket.trace_id ?? ticket.id;
  const gathered = stored.gathered ?? buildInitialGathered();

  // Generate tenant-facing summary for confirmation
  const { count: mediaCount } = await supabase
    .from("ticket_media")
    .select("id", { count: "exact", head: true })
    .eq("ticket_id", ticket.id);

  const tenantSummary = generateTenantSummary({
    description: ticket.description,
    gathered,
    mediaCount: mediaCount ?? 0,
    guidedOutcome: guidedState.outcome,
  });

  const confirmClassification: TriageClassification = {
    gathered,
    current_question: null,
    tenant_info: stored.tenant_info,
    issue_classification: stored.issue_classification,
    issue_frame: stored.issue_frame,
    safety_detection: stored.safety_detection,
    media_refs: stored.media_refs,
    retrieval: stored.retrieval,
    validation: stored.validation,
    guided_troubleshooting: guidedState,
  };

  const { error: confirmUpdateErr } = await supabase
    .from("tickets")
    .update({
      triage_state: "CONFIRM_SUMMARY",
      classification: confirmClassification as unknown as Json,
      // Pre-set ticket fields
      category: (gathered.category ?? "general") as Database["public"]["Enums"]["ticket_category"],
      troubleshooting_steps: guidedState.steps.map((s) => ({
        step: s.index + 1,
        description: s.description,
        completed: guidedState.log.some(
          (l) => l.step_index === s.index && l.result !== null
        ),
      })) as unknown as Json,
    })
    .eq("id", ticket.id)
    .select("id")
    .single();
  if (confirmUpdateErr) {
    logError("chat_guided_confirm_summary_update", confirmUpdateErr, { ticketId: ticket.id });
  }

  // Send guided completion reply + tenant summary
  const combinedReply = reply + "\n\n---\n\n" + tenantSummary;

  await supabase.from("messages").insert({
    ticket_id: ticket.id,
    sender_id: userId,
    body: combinedReply,
    is_bot_reply: true,
  });

  logTriageStep({
    trace_id: traceId,
    ticket_id: ticket.id,
    triage_state: "CONFIRM_SUMMARY",
    action: "guided_confirm_summary_shown",
    latency_ms: Date.now() - start,
    timestamp: new Date().toISOString(),
    metadata: {
      outcome: guidedState.outcome,
      steps_presented: guidedState.log.length,
      total_steps: guidedState.steps.length,
      is_escalated: isEscalated,
    },
  });

  return NextResponse.json({
    ticket_id: ticket.id,
    reply: combinedReply,
    triage_state: "CONFIRM_SUMMARY",
    is_complete: false,
  });
}

// ── Final completion handler (called when tenant confirms summary) ──

async function handleFinalCompletion(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  ticket: { id: string; trace_id: string | null; description: string; triage_state: string; classification: Json | null; unit_id: string | null },
  stored: TriageClassification,
  start: number
) {
  const traceId = ticket.trace_id ?? ticket.id;
  const gathered = stored.gathered ?? buildInitialGathered();
  const isEmergency = gathered.is_emergency ?? false;
  const guidedState = stored.guided_troubleshooting;
  const isEscalated = guidedState?.outcome === "escalated";

  // Generate manager-facing summary
  const { count: mediaCount } = await supabase
    .from("ticket_media")
    .select("id", { count: "exact", head: true })
    .eq("ticket_id", ticket.id);

  let steps: import("@/lib/triage/types").TroubleshootingStep[] = [];
  if (guidedState) {
    steps = guidedState.steps.map((s) => ({
      step: s.index + 1,
      description: s.description,
      completed: guidedState.log.some(
        (l) => l.step_index === s.index && l.result !== null
      ),
    }));
  }

  const summary = stored.summary ?? generateTicketSummary({
    ticketId: ticket.id,
    traceId,
    description: ticket.description,
    gathered,
    tenantInfo: stored.tenant_info,
    steps,
    mediaCount: mediaCount ?? 0,
    timestamp: new Date().toISOString(),
    guidedState,
  });

  const doneClassification: TriageClassification = {
    ...stored,
    summary,
  };

  const effectivePriority = isEscalated || isEmergency ? "emergency" : "medium";
  const effectiveStatus = isEscalated || isEmergency ? "escalated" : "open";

  // Priority/status/safety are set server-side: the tenant RLS policy rejects
  // status = 'escalated', which silently broke this update before.
  await setPrivilegedTicketFields(ticket.id, userId, {
    priority: effectivePriority,
    safety_assessment: isEmergency
      ? ({ flagged: true, reason: "emergency_detected" } as unknown as Json)
      : null,
  });

  const { error: doneUpdateErr } = await supabase
    .from("tickets")
    .update({
      triage_state: "DONE",
      classification: doneClassification as unknown as Json,
      category: (gathered.category ?? "general") as Database["public"]["Enums"]["ticket_category"],
    })
    .eq("id", ticket.id)
    .select("id")
    .single();
  if (doneUpdateErr) {
    logError("chat_final_completion_update", doneUpdateErr, { ticketId: ticket.id });
  }

  if (effectiveStatus !== "open") {
    await setPrivilegedTicketFields(ticket.id, userId, { status: effectiveStatus });
  }

  const confirmReply = "Your report has been submitted. Your property manager has been notified and will follow up with you.";

  await supabase.from("messages").insert({
    ticket_id: ticket.id,
    sender_id: userId,
    body: confirmReply,
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
      confirmed_by_tenant: true,
    },
  });

  // Email PM
  const pmEmail = await getManagerEmailForTicket(ticket.id, ticket.unit_id, stored.tenant_info?.reported_address);
  if (pmEmail) {
    const emailResult = await sendTicketSummaryEmail({
      to: pmEmail,
      ticketId: ticket.id,
      ticketTitle: ticket.description?.slice(0, 80) ?? ticket.id,
      summary: summary ?? "",
      isEmergency: isEmergency || !!isEscalated,
      category: gathered.category ?? "general",
    });
    if (!emailResult.success) {
      logError("email_send_failed", emailResult.error, { ticketId: ticket.id });
    }
  }

  return NextResponse.json({
    ticket_id: ticket.id,
    reply: confirmReply,
    triage_state: "DONE",
    is_complete: true,
  });
}

// ── Emergency handler (any state, any turn) ──

/**
 * Stop triage and escalate: reply at once with leave-now guidance (FortisBC /
 * 911), mark the ticket priority=emergency / status=escalated, alert the
 * manager immediately, and move to the EMERGENCY state (no more questions or
 * troubleshooting steps).
 */
async function handleEmergency(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  ticket: { id: string; trace_id: string | null; description: string; triage_state: string; unit_id: string | null },
  stored: TriageClassification,
  message: string,
  emergency: EmergencyMatch,
  start: number,
  opts: { insertUserMessage: boolean }
) {
  if (opts.insertUserMessage && message) {
    await supabase.from("messages").insert({
      ticket_id: ticket.id,
      sender_id: userId,
      body: message,
      is_bot_reply: false,
    });
  }

  const gathered = { ...(stored.gathered ?? buildInitialGathered()), is_emergency: true };
  const emergencyClassification: TriageClassification = {
    ...stored,
    gathered,
    current_question: null,
    safety_detection: stored.safety_detection?.detected
      ? stored.safety_detection
      : { detected: true, method: "auto", rationale: `${emergency.kind}: "${emergency.phrase}"` },
    emergency: {
      kind: emergency.kind,
      phrase: emergency.phrase,
      detected_at: new Date().toISOString(),
      previous_state: ticket.triage_state,
      manager_notified: false,
    },
  };

  const result = await escalateEmergency({
    ticketId: ticket.id,
    tenantId: userId,
    unitId: ticket.unit_id,
    description: ticket.description,
    latestMessage: message,
    emergency,
    classification: emergencyClassification,
  });

  if (!result.escalated) {
    // Service role unavailable: still stop troubleshooting via the tenant's
    // own client (priority/status could not be set — logged in escalateEmergency).
    const { error } = await supabase
      .from("tickets")
      .update({
        triage_state: "EMERGENCY",
        classification: emergencyClassification as unknown as Json,
      })
      .eq("id", ticket.id);
    if (error) logError("chat_emergency_state_update", error, { ticketId: ticket.id });
  }

  const reply = buildEmergencyReply(emergency.kind, result.managerNotified);
  await supabase.from("messages").insert({
    ticket_id: ticket.id,
    sender_id: userId,
    body: reply,
    is_bot_reply: true,
  });

  logTriageStep({
    trace_id: ticket.trace_id ?? ticket.id,
    ticket_id: ticket.id,
    triage_state: "EMERGENCY",
    action: "emergency_detected",
    latency_ms: Date.now() - start,
    timestamp: new Date().toISOString(),
    metadata: {
      kind: emergency.kind,
      previous_state: ticket.triage_state,
      escalated: result.escalated,
      manager_notified: result.managerNotified,
    },
  });

  return NextResponse.json({
    ticket_id: ticket.id,
    reply,
    triage_state: "EMERGENCY",
    is_complete: false,
    is_emergency: true,
  });
}
