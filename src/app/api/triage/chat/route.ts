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
import { createClient } from "@/lib/supabase/server";
import {
  step,
  buildInitialReply,
  buildInitialReplyWithClarification,
  buildInitialGathered,
  buildInitialTenantInfo,
  buildTenantInfoInitialReply,
  buildConfirmProfileReply,
  stepTenantInfo,
  getNextMissingTenantInfo,
  getNextMissingField,
  hasEmergencyKeywords,
  validateTenantInfo,
  TENANT_INFO_QUESTIONS,
  QUESTIONS,
} from "@/lib/triage/state-machine";
import { extractLocation, extractTiming, extractCurrentStatus, extractEntryPoint } from "@/lib/triage/extract-details";
import { logTriageStep } from "@/lib/triage/logger";
import {
  isGatherComplete,
  isExtendedField,
  getNextExtendedQuestion,
  getExtendedQuestionText,
  processExtendedAnswer,
} from "@/lib/triage/gather-issue";
import { buildAcknowledgement } from "@/lib/triage/acknowledgement";
import {
  classifyIssue,
  classifyPest,
  parseClarifyingResponse,
  buildClarifyingCategoryQuestion,
} from "@/lib/triage/classify-issue";
import {
  detectSafety,
  parseSafetyResponse,
  checkPestEscalation,
} from "@/lib/triage/detect-safety";
import { querySnippets } from "@/lib/retrieval/pinecone";
import { generateGroundedSteps, convertToGuidedSteps, shouldUseGuidedTroubleshooting } from "@/lib/triage/grounding";
import { generateTicketSummary } from "@/lib/triage/summary";
import { validateGroundedResult } from "@/lib/triage/validate";
import { getFallbackSOP } from "@/lib/triage/sop-fallback";
import {
  determineNextAction,
  findNextEligibleStep,
  getTerminalGuidance,
  buildStepMessage,
  buildFeedbackReply,
  buildClarifyReply,
} from "@/lib/triage/step-feedback";
import { classifyStepHybrid } from "@/lib/triage/interpret-step-response";
import type {
  TriageContext,
  TriageClassification,
  ValidationResult,
  IssueClassification,
  SafetyDetection,
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
      is_guided: ticket.triage_state === "GUIDED_TROUBLESHOOTING",
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
    let body: {
      message?: string;
      ticket_id?: string;
      confirm_profile?: string;
      media_action?: string;
    };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const message = body.message?.trim();
    // message is required unless this is a confirm_profile or media_action
    if (!message && !body.confirm_profile && !body.media_action) {
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
    return handleFollowUp(
      supabase,
      user.id,
      body.ticket_id,
      message ?? "",
      body.confirm_profile,
      body.media_action,
      start
    );
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

/**
 * Find the next gather question to ask (base or extended).
 * Returns null when ALL gather fields are already filled.
 */
function getNextGatherQuestion(
  gathered: import("@/lib/triage/types").GatheredInfo
): { field: string; text: string } | null {
  const nextBase = getNextMissingField(gathered);
  if (nextBase) {
    return { field: nextBase, text: QUESTIONS[nextBase] };
  }
  const nextExtended = getNextExtendedQuestion(gathered);
  if (nextExtended) {
    return { field: nextExtended, text: getExtendedQuestionText(nextExtended) };
  }
  return null;
}

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

  // ── Auto-classify issue ──
  const classification_result = classifyIssue(message);
  const issueClassification: IssueClassification = {
    category: classification_result.category,
    confidence: classification_result.confidence,
    rationale: classification_result.rationale,
  };

  // ── Auto-detect emergency keywords ──
  const emergencyDetected = hasEmergencyKeywords(message);

  // ── Extract structured details from initial description ──
  const extractedLocation = extractLocation(message);
  const extractedTiming = extractTiming(message);
  const extractedStatus = extractCurrentStatus(message);
  const extractedEntryPoint = extractEntryPoint(message);

  // ── Pest subcategory ──
  const pestResult = classification_result.category === "pest_control"
    ? classifyPest(message)
    : null;

  // ── Build acknowledgement ──
  const acknowledgement = buildAcknowledgement(message, {
    timing: extractedTiming,
    status: extractedStatus,
  });

  // Build classification and determine initial state/reply
  let triageClassification: TriageClassification;
  let triageState: string;
  let reply: string;

  if (hasUnit) {
    const initialGathered = buildInitialGathered();

    // Set category from auto-classification
    if (classification_result.confidence === "high" || classification_result.confidence === "medium") {
      initialGathered.category = classification_result.category;
    }

    // Set emergency from auto-detection
    if (emergencyDetected) {
      initialGathered.is_emergency = true;
    }

    // Set pre-extracted fields
    if (extractedLocation) {
      initialGathered.location_in_unit = extractedLocation;
    }
    if (extractedTiming) {
      initialGathered.started_when = extractedTiming;
    }
    if (extractedStatus) {
      initialGathered.current_status = extractedStatus;
    }
    if (pestResult) {
      initialGathered.subcategory = pestResult.species;
    }
    if (extractedEntryPoint) {
      initialGathered.entry_point = extractedEntryPoint;
    }

    if (classification_result.confidence === "low") {
      // Low confidence — ask a clarifying question
      const clarifyingQ = buildClarifyingCategoryQuestion(
        message,
        [classification_result.category]
      );
      triageClassification = {
        gathered: initialGathered,
        current_question: "classify_category",
        issue_classification: issueClassification,
      };
      triageState = "GATHER_INFO";
      reply = buildInitialReplyWithClarification(acknowledgement, clarifyingQ);
    } else {
      // High/medium confidence — ask the next missing field (skip any pre-extracted fields)
      const nextQ = getNextGatherQuestion(initialGathered);
      triageClassification = {
        gathered: initialGathered,
        current_question: nextQ?.field ?? null,
        issue_classification: issueClassification,
      };
      triageState = "GATHER_INFO";
      reply = buildInitialReply(
        acknowledgement,
        nextQ?.text ?? "Thanks for all the details! Is there anything else about the issue you'd like to mention before I proceed?"
      );
    }
  } else {
    // Load profile to seed tenant info from previous tickets
    const { data: profile } = await supabase
      .from("profiles")
      .select("phone, email, default_property_address, default_unit_number")
      .eq("id", userId)
      .single();

    const initialGathered = buildInitialGathered();

    // Set category from auto-classification
    if (classification_result.confidence === "high" || classification_result.confidence === "medium") {
      initialGathered.category = classification_result.category;
    }

    // Set emergency from auto-detection
    if (emergencyDetected) {
      initialGathered.is_emergency = true;
    }

    // Set pre-extracted fields
    if (extractedLocation) {
      initialGathered.location_in_unit = extractedLocation;
    }
    if (extractedTiming) {
      initialGathered.started_when = extractedTiming;
    }
    if (extractedStatus) {
      initialGathered.current_status = extractedStatus;
    }
    if (pestResult) {
      initialGathered.subcategory = pestResult.species;
    }
    if (extractedEntryPoint) {
      initialGathered.entry_point = extractedEntryPoint;
    }

    const tenantInfo = {
      reported_address: profile?.default_property_address ?? null,
      reported_unit_number: profile?.default_unit_number ?? null,
      contact_phone: profile?.phone ?? null,
      contact_email: profile?.email ?? null,
    };

    const firstMissing = getNextMissingTenantInfo(tenantInfo);

    if (!firstMissing) {
      // All fields present — returning tenant, confirm stored info
      triageClassification = {
        gathered: initialGathered,
        current_question: null,
        tenant_info: tenantInfo,
        issue_classification: issueClassification,
      };
      triageState = "CONFIRM_PROFILE";
      reply = buildConfirmProfileReply(tenantInfo);
    } else {
      // Some or all fields missing — collect the missing ones
      triageClassification = {
        gathered: initialGathered,
        current_question: firstMissing,
        tenant_info: tenantInfo,
        issue_classification: issueClassification,
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
    classification: triageClassification as unknown as Json,
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
      body: tiReply,
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
      console.error("[triage] GUIDED_TROUBLESHOOTING but no guided state", { ticketId: ticket.id });
      return NextResponse.json(
        { error: "Missing guided troubleshooting state" },
        { status: 500 }
      );
    }

    const currentStep = guidedState.steps[guidedState.current_step_index];
    if (!currentStep) {
      console.error("[triage] GUIDED_TROUBLESHOOTING but no current step", {
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
        console.error("triage/chat guided_clarify_update failed", {
          message: clarifyUpdateErr.message,
        });
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
      console.error("triage/chat guided_step_update failed", {
        message: guidedUpdateErr.message,
      });
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
  let gathered = stored.gathered ?? buildInitialGathered();
  let currentQuestion = stored.current_question ?? null;
  let stepReply: string | null = null;

  // 1. Process the user's answer
  if (currentQuestion === "classify_category") {
    // Clarifying category question — parse the response
    const prevClassification = stored.issue_classification ?? {
      category: "general" as const,
      confidence: "low" as const,
      rationale: "default",
    };
    const updated = parseClarifyingResponse(message, {
      category: prevClassification.category as import("@/lib/triage/classify-issue").IssueCategory,
      confidence: prevClassification.confidence,
      rationale: prevClassification.rationale,
    });
    gathered.category = updated.category;

    // Update issue classification
    stored.issue_classification = {
      category: updated.category,
      confidence: updated.confidence,
      rationale: updated.rationale,
    };

    currentQuestion = null; // Move to next field
  } else if (currentQuestion === "safety_check") {
    // Targeted safety question — parse the response
    const isSafe = !parseSafetyResponse(message);
    gathered.is_emergency = !isSafe;

    stored.safety_detection = {
      detected: !isSafe,
      method: !isSafe ? "user_confirmed" : "user_denied",
      rationale: `user_response: "${message.slice(0, 50)}"`,
    };

    currentQuestion = null; // Move to next field
  } else if (currentQuestion && isExtendedField(currentQuestion)) {
    // Extended field — process directly
    gathered = processExtendedAnswer(gathered, currentQuestion, message);
  } else {
    // Base field — run state machine
    const context: TriageContext = {
      triage_state: ticket.triage_state as "GATHER_INFO" | "DONE",
      description: ticket.description,
      gathered,
      current_question: currentQuestion,
    };
    const result = step(context, message);
    gathered = result.gathered;
    if (result.next_state === "GATHER_INFO") {
      stepReply = result.reply;
      currentQuestion = result.current_question;
    } else {
      currentQuestion = null;
    }
  }

  // 2. Auto-detect emergency keywords in every message
  if (hasEmergencyKeywords(message)) {
    gathered.is_emergency = true;
  }

  // 2b. Extract entry point from every GATHER_INFO message
  if (!gathered.entry_point) {
    const ep = extractEntryPoint(message);
    if (ep) gathered.entry_point = ep;
  }

  // 2c. Classify pest subcategory if pest_control and not yet classified
  if (gathered.category === "pest_control" && !gathered.subcategory) {
    const pest = classifyPest(message);
    if (pest) gathered.subcategory = pest.species;
  }

  // 3. Check if ALL fields (base + extended) are complete
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

    // Safety guard: if no next question exists, force gather complete to
    // prevent empty-reply deadlock (no question to ask but gather says incomplete)
    if (!nextQuestion && !botReply) {
      console.warn("[triage] safety guard triggered — no next question but gather incomplete", {
        ticketId: ticket.id,
        gathered_fields: Object.entries(gathered)
          .filter(([, v]) => v !== null)
          .map(([k]) => k),
        null_fields: Object.entries(gathered)
          .filter(([, v]) => v === null)
          .map(([k]) => k),
      });
      // Fall through to safety detection + completion below
    } else {
      const updatedClassification: TriageClassification = {
        gathered,
        current_question: nextQuestion,
        tenant_info: stored.tenant_info,
        issue_classification: stored.issue_classification,
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
  }

  // ── All fields gathered — run safety detection before proceeding ──
  if (gathered.is_emergency === null) {
    const safetyResult = detectSafety(ticket.description, gathered);

    if (safetyResult.detected) {
      // Auto-detected emergency
      gathered.is_emergency = true;
      stored.safety_detection = {
        detected: true,
        method: "auto",
        rationale: safetyResult.rationale,
      };
    } else if (safetyResult.needsQuestion && !stored.safety_detection) {
      // Need to ask a targeted safety question
      const updatedClassification: TriageClassification = {
        gathered,
        current_question: "safety_check",
        tenant_info: stored.tenant_info,
        issue_classification: stored.issue_classification,
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
        console.error("triage/chat safety_update failed", {
          message: safetyUpdateErr.message,
        });
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
        body: safetyResult.question!,
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
        reply: safetyResult.question!,
        triage_state: "GATHER_INFO",
        is_complete: false,
      });
    } else {
      // No safety concern
      gathered.is_emergency = false;
      stored.safety_detection = {
        detected: false,
        method: "skipped",
        rationale: safetyResult.rationale,
      };
    }
  }

  // ── Transition to AWAITING_MEDIA ──
  const mediaPrompt = "If you have any photos or videos of the issue, you can upload them now to help your property manager. Otherwise, you can skip this step.";

  const mediaClassification: TriageClassification = {
    gathered,
    current_question: null,
    tenant_info: stored.tenant_info,
    issue_classification: stored.issue_classification,
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
    console.error("triage/chat media_update failed", {
      message: mediaUpdateErr.message,
    });
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
  ticket: { id: string; trace_id: string | null; description: string; triage_state: string; classification: Json | null },
  stored: TriageClassification,
  start: number
) {
  const traceId = ticket.trace_id ?? ticket.id;
  const gathered = stored.gathered ?? buildInitialGathered();
  const isEmergency = gathered.is_emergency ?? false;

  console.log("[triage] GATHER_INFO complete — entering retrieval pipeline", {
    ticketId: ticket.id,
    category: gathered.category,
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
      console.error("[triage] retrieval FAILED, using fallback", {
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
        ticketId: ticket.id,
      });
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
        priority: "high" as Database["public"]["Enums"]["ticket_priority"],
        status: "escalated" as Database["public"]["Enums"]["ticket_status"],
      })
      .eq("id", ticket.id)
      .select("id")
      .single();
    if (escalateErr) {
      console.error("triage/chat pest_escalation_update failed", {
        message: escalateErr.message,
      });
    }

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
    console.error("[triage] grounding FAILED, using fallback", {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
      ticketId: ticket.id,
    });
    const sop = getFallbackSOP(gathered.category ?? "general", isEmergency, gathered.subcategory);
    groundedResult = {
      reply: sop.display,
      steps: sop.steps,
      usedFallback: true,
    };
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
      const sop = getFallbackSOP(gathered.category ?? "general", isEmergency, gathered.subcategory);
      groundedResult = {
        reply: sop.display,
        steps: sop.steps,
        usedFallback: true,
      };
      validation = { ...validation, action_taken: "fallback_sop" };
    } else if (validation.low_confidence) {
      const sop = getFallbackSOP(gathered.category ?? "general", isEmergency, gathered.subcategory);
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
  } else {
    validation = { ...validation, action_taken: "none" };
  }

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
      console.error("triage/chat guided_init_update failed", {
        message: guidedUpdateErr.message,
      });
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

  // Summary (with idempotency check)
  let summary = stored.summary ?? null;
  if (!summary) {
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
    issue_classification: stored.issue_classification,
    safety_detection: stored.safety_detection,
    media_refs: stored.media_refs,
    retrieval: retrievalLog ?? undefined,
    validation,
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

  // Insert bot reply AFTER state is persisted
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
      validation_valid: validation.is_valid,
      validation_action: validation.action_taken,
    },
  });

  return NextResponse.json({
    ticket_id: ticket.id,
    reply: groundedResult.reply,
    triage_state: "DONE",
    is_complete: true,
  });
}

// ── Guided troubleshooting terminal handler ──

async function handleGuidedComplete(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  ticket: { id: string; trace_id: string | null; description: string; triage_state: string; classification: Json | null },
  stored: TriageClassification,
  guidedState: GuidedTroubleshootingState,
  reply: string,
  isEscalated: boolean,
  start: number
) {
  const traceId = ticket.trace_id ?? ticket.id;
  const gathered = stored.gathered ?? buildInitialGathered();
  const isEmergency = gathered.is_emergency ?? false;

  // Generate summary
  const { count: mediaCount } = await supabase
    .from("ticket_media")
    .select("id", { count: "exact", head: true })
    .eq("ticket_id", ticket.id);

  // Collect completed steps for summary
  const completedSteps = guidedState.steps.map((s) => ({
    step: s.index + 1,
    description: s.description,
    completed: guidedState.log.some(
      (l) => l.step_index === s.index && l.result !== null
    ),
  }));

  const summary = generateTicketSummary({
    ticketId: ticket.id,
    traceId,
    description: ticket.description,
    gathered,
    tenantInfo: stored.tenant_info,
    steps: completedSteps,
    mediaCount: mediaCount ?? 0,
    timestamp: new Date().toISOString(),
    guidedState,
  });

  const doneClassification: TriageClassification = {
    gathered,
    current_question: null,
    tenant_info: stored.tenant_info,
    issue_classification: stored.issue_classification,
    safety_detection: stored.safety_detection,
    media_refs: stored.media_refs,
    retrieval: stored.retrieval,
    validation: stored.validation,
    guided_troubleshooting: guidedState,
    summary,
  };

  const effectivePriority = isEscalated || isEmergency ? "emergency" : "medium";
  const effectiveStatus = isEscalated || isEmergency ? "escalated" : "open";

  const { error: doneUpdateErr } = await supabase
    .from("tickets")
    .update({
      triage_state: "DONE",
      classification: doneClassification as unknown as Json,
      category: (gathered.category ?? "general") as Database["public"]["Enums"]["ticket_category"],
      priority: effectivePriority,
      status: effectiveStatus,
      safety_assessment: isEmergency
        ? ({ flagged: true, reason: "emergency_detected" } as unknown as Json)
        : null,
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
  if (doneUpdateErr) {
    console.error("triage/chat guided_complete_update failed", {
      message: doneUpdateErr.message,
    });
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
    triage_state: "DONE",
    action: "guided_complete",
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
    reply,
    triage_state: "DONE",
    is_complete: true,
  });
}
