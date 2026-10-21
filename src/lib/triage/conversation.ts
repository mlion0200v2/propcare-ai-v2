/**
 * The tenant chat's question logic, without I/O.
 *
 * The chat route (src/app/api/triage/chat/route.ts) loads and saves the
 * ticket and calls these functions to decide what the tenant has said and
 * what to ask next. The conversation eval (tests/eval) drives the same
 * functions with scripted tenants, so what it measures is what tenants get.
 */
import {
  step,
  buildInitialReply,
  buildInitialReplyWithClarification,
  buildInitialGathered,
  getNextMissingField,
  QUESTIONS,
} from "./state-machine";
import {
  extractLocation,
  extractTiming,
  extractCurrentStatus,
  extractEntryPoint,
  extractEquipment,
  inferLocationFromEquipment,
  detectEquipmentAmbiguity,
} from "./extract-details";
import {
  isGatherComplete,
  isExtendedField,
  getNextExtendedQuestion,
  getExtendedQuestionText,
  processExtendedAnswer,
  isWaterLeak,
  extractLeakWhere,
} from "./gather-issue";
import { buildAcknowledgement } from "./acknowledgement";
import {
  classifyIssue,
  classifyPest,
  classifyMold,
  classifyPlumbing,
  classifyStructural,
  classifyApplianceSymptom,
  classifyHvacSymptom,
  classifyLandscaping,
  parseClarifyingResponse,
  buildClarifyingCategoryQuestion,
  type ClassificationResult,
  type IssueCategory,
} from "./classify-issue";
import { detectEmergency, classifySafetyAnswer, type EmergencyMatch } from "./emergency";
import { detectSafety } from "./detect-safety";
import { matchingRooms, whichRoomQuestion } from "@/lib/units/profile";
import type { GatheredInfo, IssueClassification, TriageClassification, TriageContext } from "./types";

const ALL_SET_REPLY =
  "Thanks for all the details! Is there anything else about the issue you'd like to mention before I proceed?";

/** Next gather question (base or extended), or null when every field is filled. */
export function getNextGatherQuestion(gathered: GatheredInfo): { field: string; text: string } | null {
  const nextBase = getNextMissingField(gathered);
  if (nextBase) return { field: nextBase, text: QUESTIONS[nextBase] };
  const nextExtended = getNextExtendedQuestion(gathered);
  if (nextExtended) return { field: nextExtended, text: getExtendedQuestionText(nextExtended) };
  return null;
}

/** Fill subcategories the message reveals (pest species, mold, plumbing kind…). */
function classifySubcategory(gathered: GatheredInfo, message: string, opening = false): void {
  if (gathered.subcategory) return;
  const byCategory: Partial<Record<string, (m: string) => string | null>> = {
    pest_control: (m) => classifyPest(m)?.species ?? null,
    plumbing: classifyPlumbing,
    appliance: classifyApplianceSymptom,
    hvac: classifyHvacSymptom,
    landscaping: classifyLandscaping,
  };
  if (gathered.category === "structural") {
    // (Kept as before: the first message prefers window/screen, later turns prefer mold.)
    gathered.subcategory = opening
      ? classifyStructural(message) ?? classifyMold(message) ?? null
      : classifyMold(message) ?? classifyStructural(message) ?? null;
    return;
  }
  const fn = gathered.category ? byCategory[gathered.category] : undefined;
  const sub = fn ? fn(message) : null;
  if (sub) gathered.subcategory = sub;
}

export interface OpeningContext {
  /** Room names from the unit profile ("Main bathroom (hallway)", "Ensuite"…). */
  rooms?: string[];
}

export interface Opening {
  classification: ClassificationResult;
  emergency: EmergencyMatch | null;
  triageClassification: TriageClassification;
  reply: string;
  extracted: { location: string | null; timing: string | null; status: string | null };
}

/** First message: classify, pull out what it already says, pick the first question. */
export function openConversation(message: string, ctx: OpeningContext = {}): Opening {
  const classification = classifyIssue(message);
  const issueClassification: IssueClassification = {
    category: classification.category,
    confidence: classification.confidence,
    rationale: classification.rationale,
  };
  const emergency = detectEmergency(message);

  const location = extractLocation(message) ?? inferLocationFromEquipment(message);
  const timing = extractTiming(message);
  const status = extractCurrentStatus(message);
  const entryPoint = extractEntryPoint(message);
  const equipment = extractEquipment(message);
  const { candidates: equipmentCandidates } = detectEquipmentAmbiguity(message);

  const gathered = buildInitialGathered();
  if (classification.confidence === "high" || classification.confidence === "medium") {
    gathered.category = classification.category;
  }
  if (emergency) gathered.is_emergency = true;
  if (location) gathered.location_in_unit = location;
  if (timing) gathered.started_when = timing;
  if (status) gathered.current_status = status;
  if (entryPoint) gathered.entry_point = entryPoint;
  if (equipment) gathered.equipment = equipment;
  if (equipmentCandidates.length > 0) gathered.equipment_candidates = equipmentCandidates;
  // Subcategory follows the classifier's category, even before it is accepted.
  {
    const probe = { ...gathered, category: classification.category, subcategory: null } as GatheredInfo;
    classifySubcategory(probe, message, true);
    if (probe.subcategory) gathered.subcategory = probe.subcategory;
  }

  // Use what the first message already says, and the unit's own rooms.
  if (isWaterLeak(message)) {
    gathered.leak_details_needed = true;
    gathered.leak_where = extractLeakWhere(message);
  }
  let roomWord: string | null = null;
  if (gathered.location_in_unit && ctx.rooms?.length) {
    const candidates = matchingRooms(gathered.location_in_unit, ctx.rooms);
    if (candidates.length > 1) {
      gathered.location_candidates = candidates;
      roomWord = gathered.location_in_unit;
      gathered.location_in_unit = null;
    } else if (candidates.length === 1) {
      gathered.location_in_unit = candidates[0];
    }
  }

  const acknowledgement = buildAcknowledgement(message, { timing, status });

  if (classification.confidence === "low") {
    const clarifyingQ = buildClarifyingCategoryQuestion(message, [classification.category]);
    return {
      classification,
      emergency,
      triageClassification: { gathered, current_question: "classify_category", issue_classification: issueClassification },
      reply: buildInitialReplyWithClarification(acknowledgement, clarifyingQ),
      extracted: { location, timing, status },
    };
  }

  const nextQ = getNextGatherQuestion(gathered);
  const questionText =
    nextQ?.field === "location_in_unit" && roomWord && gathered.location_candidates
      ? whichRoomQuestion(roomWord, gathered.location_candidates)
      : nextQ?.text;
  return {
    classification,
    emergency,
    triageClassification: { gathered, current_question: nextQ?.field ?? null, issue_classification: issueClassification },
    reply: buildInitialReply(acknowledgement, questionText ?? ALL_SET_REPLY),
    extracted: { location, timing, status },
  };
}

/**
 * Emergency check for a follow-up message, before anything else (every
 * turn). Also turns a non-"no" answer to the safety question into an
 * emergency. May record the safety answer on `stored`.
 */
export function turnEmergency(
  message: string,
  triageState: string,
  stored: TriageClassification
): EmergencyMatch | null {
  const isContactAnswer =
    triageState === "COLLECT_TENANT_INFO" &&
    (stored.current_question === "contact_phone" || stored.current_question === "contact_email");
  let emergency: EmergencyMatch | null = message && !isContactAnswer ? detectEmergency(message) : null;
  if (!emergency && triageState === "GATHER_INFO" && stored.current_question === "safety_check") {
    const answer = classifySafetyAnswer(message);
    if (answer !== "no_concern") {
      emergency = { kind: "unconfirmed_safety", phrase: message.slice(0, 120) };
      stored.safety_detection = {
        detected: true,
        method: answer === "concern" ? "user_confirmed" : "user_unclear",
        rationale: `user_response: "${message.slice(0, 50)}"`,
      };
    }
  }
  return emergency;
}

export type GatherStep =
  | { kind: "emergency"; gathered: GatheredInfo; emergency: EmergencyMatch }
  | { kind: "ask"; gathered: GatheredInfo; nextQuestion: string; reply: string }
  | { kind: "complete"; gathered: GatheredInfo };

/**
 * A GATHER_INFO answer: record it, then either ask the next question or
 * report that every detail is in. `stored` gets issue/safety updates.
 */
export function advanceGather(params: {
  stored: TriageClassification;
  description: string;
  triageState: string;
  message: string;
}): GatherStep {
  const { stored, description, triageState, message } = params;
  let gathered = stored.gathered ?? buildInitialGathered();
  let currentQuestion = stored.current_question ?? null;
  let stepReply: string | null = null;

  if (currentQuestion === "classify_category") {
    const prev = stored.issue_classification ?? { category: "general" as const, confidence: "low" as const, rationale: "default" };
    const updated = parseClarifyingResponse(message, {
      category: prev.category as IssueCategory,
      confidence: prev.confidence,
      rationale: prev.rationale,
    });
    gathered.category = updated.category;
    stored.issue_classification = { category: updated.category, confidence: updated.confidence, rationale: updated.rationale };
    currentQuestion = null;
  } else if (currentQuestion === "safety_check") {
    // Concern or unclear answers were escalated by turnEmergency; only "no" reaches here.
    gathered.is_emergency = false;
    stored.safety_detection = { detected: false, method: "user_denied", rationale: `user_response: "${message.slice(0, 50)}"` };
    currentQuestion = null;
  } else if (currentQuestion && isExtendedField(currentQuestion)) {
    gathered = processExtendedAnswer(gathered, currentQuestion, message);
    // Water near an outlet/light (or "not sure") → stop and escalate now.
    if (currentQuestion === "leak_electrical" && gathered.leak_electrical !== "no") {
      return {
        kind: "emergency",
        gathered,
        emergency: {
          kind: gathered.leak_electrical === "yes" ? "water_electrical" : "unconfirmed_safety",
          phrase: `water near electrical: "${message.slice(0, 80)}"`,
        },
      };
    }
  } else {
    const context: TriageContext = {
      triage_state: triageState as "GATHER_INFO" | "DONE",
      description,
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

  if (!gathered.entry_point) {
    const ep = extractEntryPoint(message);
    if (ep) gathered.entry_point = ep;
  }
  if (!gathered.equipment) {
    const eq = extractEquipment(message);
    if (eq) gathered.equipment = eq;
  }
  classifySubcategory(gathered, message);

  if (!isGatherComplete(gathered)) {
    let nextQuestion: string | null;
    let reply: string;
    if (stepReply && currentQuestion && !isExtendedField(currentQuestion)) {
      nextQuestion = currentQuestion;
      reply = stepReply;
    } else {
      nextQuestion = getNextExtendedQuestion(gathered);
      reply = nextQuestion ? getExtendedQuestionText(nextQuestion) : "";
    }
    // No question left but gather says incomplete: fall through rather than deadlock.
    if (nextQuestion || reply) return { kind: "ask", gathered, nextQuestion: nextQuestion ?? "", reply };
  }
  return { kind: "complete", gathered };
}

export type AfterGather =
  | { kind: "emergency"; emergency: EmergencyMatch }
  | { kind: "safety_question"; question: string }
  | { kind: "media" };

/** Once every detail is in: auto-detected danger, a targeted safety question, or on to photos. */
export function afterGather(gathered: GatheredInfo, description: string, stored: TriageClassification): AfterGather {
  if (gathered.is_emergency === null) {
    const safety = detectSafety(description, gathered);
    if (safety.detected) {
      gathered.is_emergency = true;
      stored.safety_detection = { detected: true, method: "auto", rationale: safety.rationale };
      return { kind: "emergency", emergency: { kind: safety.kind ?? "unconfirmed_safety", phrase: safety.rationale } };
    }
    if (safety.needsQuestion && !stored.safety_detection) {
      return { kind: "safety_question", question: safety.question! };
    }
    gathered.is_emergency = false;
    stored.safety_detection = { detected: false, method: "skipped", rationale: safety.rationale };
  }
  if (gathered.is_emergency === true) {
    return {
      kind: "emergency",
      emergency: { kind: "unconfirmed_safety", phrase: stored.safety_detection?.rationale ?? "flagged during triage" },
    };
  }
  return { kind: "media" };
}
