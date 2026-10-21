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
} from "./gather-issue";
import { normalizeVocabulary } from "./vocabulary";
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
import { understand, understandReply, type ModelUnderstander } from "@/lib/understanding";
import { EQUIPMENT_CATEGORY, EQUIPMENT_LABEL, type Room } from "@/lib/understanding/taxonomy";
import type { IssueFrame } from "@/lib/understanding/frame";
import { sopByKey } from "@/lib/sops/catalog";
import { selectSop } from "@/lib/sops/select";
import {
  answerIntake,
  frameSlots,
  nextIntakeQuestion,
  optionsFor,
  prefillFromMessage,
  startIntake,
  type IntakeState,
} from "@/lib/sops/intake";
import type { IntakeQuestion } from "@/lib/sops/schema";
import type { EmergencyKind } from "./emergency";
import type { GatheredInfo, IssueClassification, TriageClassification, TriageContext } from "./types";

const ALL_SET_REPLY =
  "Thanks for all the details! Is there anything else about the issue you'd like to mention before I proceed?";

/** Shared questions whose tap options are enough; others list their options in the text. */
const PLAIN_SLOTS = new Set(["onset", "status", "amount", "electrical_near", "brand_model", "room"]);

export function intakeQuestionText(q: IntakeQuestion, state: IntakeState): string {
  const all = optionsFor(q, state);
  const options = all.filter((o) => o.value !== "not_sure");
  // Two options (yes/no) or shared questions: the tap answers are enough.
  if (PLAIN_SLOTS.has(q.slot) || options.length < 3) return q.question;
  const shown = options.map((o) => o.label.charAt(0).toLowerCase() + o.label.slice(1));
  return all.length > options.length ? `${q.question} (${shown.join("; ")}; or not sure)` : `${q.question} (${shown.join("; ")})`;
}

/** Slots the conversation already has, beyond the frame (room/onset/status said in words). */
function knownSlots(gathered: GatheredInfo): Record<string, boolean> {
  return { room: !!gathered.location_in_unit };
}

/** The selected SOP's next question; the room uses the unit's own rooms (location_in_unit). */
function nextSopQuestion(gathered: GatheredInfo): { field: string; text: string } | null {
  const state = gathered.sop!;
  const sop = sopByKey(state.issue_key);
  if (!sop) return null;
  const known = knownSlots(gathered);
  const q = nextIntakeQuestion(sop, state, known);
  if (!q) return null;
  if (q.slot === "room") return { field: "location_in_unit", text: QUESTIONS.location_in_unit };
  return { field: `intake:${q.id}`, text: intakeQuestionText(q, state) };
}

/**
 * Keep the fields the summary, work order and older screens read in step
 * with the intake (started_when, current_status, brand_model, likely source).
 */
function syncFromIntake(gathered: GatheredInfo): void {
  const state = gathered.sop;
  if (!state) return;
  const a = state.answers;
  if (a.onset && !gathered.started_when) gathered.started_when = a.onset.label;
  if (a.status && !gathered.current_status) gathered.current_status = a.status.label;
  if (a.brand_model && !gathered.brand_model) gathered.brand_model = a.brand_model.value === "unknown" ? "unknown" : a.brand_model.label;
  if (a.amount) gathered.leak_amount = a.amount.label;
  if (a.electrical_near) gathered.leak_electrical = a.electrical_near.value === "not_sure" ? "not sure" : a.electrical_near.value;
  gathered.leak_likely_source = state.cause
    ? { id: state.cause.id, label: state.cause.label, sop_query: state.cause.sop_query, prevention: state.cause.prevention }
    : null;
}

/** Done with the SOP's questions: mark it and fill what the generic summary expects. */
function completeIntake(gathered: GatheredInfo): void {
  if (!gathered.sop) return;
  gathered.sop = { ...gathered.sop, complete: true };
  syncFromIntake(gathered);
  gathered.started_when ??= "Not asked";
  gathered.current_status ??= "Not asked";
}

/** Pick (or switch to) the SOP for this frame; answers to shared slots carry over. */
function chooseSop(gathered: GatheredInfo, frame: IssueFrame, text: string): void {
  const choice = selectSop(frame, text);
  if (!choice) return;
  const previous = gathered.sop;
  if (previous && previous.issue_key === choice.sop.issue_key) return;
  let state = startIntake(choice.sop, frame, choice.confidence);
  if (previous) state = { ...state, answers: { ...previous.answers }, asked: [...previous.asked] };
  gathered.sop = prefillFromMessage(choice.sop, state, text);
  gathered.category ??= choice.sop.category;
  gathered.leak_details_needed = false;
  syncFromIntake(gathered);
}

/** Next gather question (SOP intake, else base or extended), or null when every field is filled. */
export function getNextGatherQuestion(gathered: GatheredInfo): { field: string; text: string } | null {
  if (gathered.sop) return gathered.sop.complete ? null : nextSopQuestion(gathered);
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

/**
 * Model fallback, used only when the keyword rules find nothing at all.
 * Returns a category (and equipment, if named) or null.
 */
export type FallbackClassifier = (message: string) => Promise<{ category: string; equipment: string | null } | null>;

const KNOWN_CATEGORIES = new Set<string>([
  "plumbing", "electrical", "hvac", "appliance", "structural", "pest_control", "locksmith",
  "roofing", "painting", "flooring", "landscaping", "general", "other",
]);

export interface OpeningContext {
  /** Room names from the unit profile ("Main bathroom (hallway)", "Ensuite"…). */
  rooms?: string[];
  classifyFallback?: FallbackClassifier;
  /** Model understanding (null/absent: rules only). */
  understander?: ModelUnderstander | null;
}

const ROOM_LABEL: Record<Room, string | null> = {
  kitchen: "Kitchen", bathroom: "Bathroom", bedroom: "Bedroom", living_room: "Living room",
  laundry: "Laundry", basement: "Basement", hallway: "Hallway", balcony: "Balcony",
  garage: "Garage", exterior: "Outside", unknown: null,
};

function emergencyFromFrame(frame: IssueFrame, message: string): EmergencyMatch | null {
  if (frame.severity !== "emergency") return null;
  const kind =
    frame.substance === "gas" ? "gas"
    : frame.equipment === "co_alarm" ? "carbon_monoxide"
    : frame.substance === "smoke" ? "fire"
    : frame.symptom === "sparking" ? "electrical"
    : frame.symptom === "no_heat" ? "no_heat"
    : frame.substance === "sewage" ? "sewage"
    : "unconfirmed_safety";
  return { kind, phrase: `understood: ${message.slice(0, 100)}` };
}

export interface Opening {
  classification: ClassificationResult;
  emergency: EmergencyMatch | null;
  triageClassification: TriageClassification;
  reply: string;
  extracted: { location: string | null; timing: string | null; status: string | null };
  frame: IssueFrame;
}

/** First message: classify, pull out what it already says, pick the first question. */
export async function openConversation(message: string, ctx: OpeningContext = {}): Promise<Opening> {
  // Understanding first (rules always; the model too when configured).
  const { frame } = await understand(message, ctx.understander ?? null);
  let classification = classifyIssue(message);
  // The frame decides the category when the keyword rules can't.
  if (classification.confidence === "low" && frame.equipment !== "unknown" && frame.confidence.equipment >= 0.6) {
    classification = { category: EQUIPMENT_CATEGORY[frame.equipment] as IssueCategory, confidence: "medium", rationale: "issue_frame" };
  } else if (classification.confidence === "low" && frame.symptom === "pests") {
    classification = { category: "pest_control", confidence: "medium", rationale: "issue_frame" };
  }
  // An SOP that clearly matches settles the category too.
  const sopChoice = selectSop(frame, message);
  if (classification.confidence === "low" && sopChoice?.confidence === "high") {
    classification = { category: sopChoice.sop.category as IssueCategory, confidence: "medium", rationale: "sop_match" };
  }
  let modelEquipment: string | null = null;
  if (classification.rationale === "no_keyword_match" && ctx.classifyFallback) {
    try {
      const guess = await ctx.classifyFallback(message);
      if (guess && KNOWN_CATEGORIES.has(guess.category) && guess.category !== "general") {
        classification = { category: guess.category as IssueCategory, confidence: "medium", rationale: "model_fallback" };
        modelEquipment = guess.equipment;
      }
    } catch {
      // Model unavailable: fall back to asking, as before.
    }
  }
  const issueClassification: IssueClassification = {
    category: classification.category,
    confidence: classification.confidence,
    rationale: classification.rationale,
  };
  // Deterministic rules first; the understanding may only raise urgency.
  const emergency = detectEmergency(message) ?? emergencyFromFrame(frame, message);

  const frameRoom = frame.confidence.room >= 0.7 ? ROOM_LABEL[frame.room] : null;
  const location = extractLocation(message) ?? inferLocationFromEquipment(message) ?? frameRoom;
  const timing = extractTiming(message);
  const status = extractCurrentStatus(message);
  const entryPoint = extractEntryPoint(message);
  const equipment =
    extractEquipment(message) ?? modelEquipment ?? (frame.equipment !== "unknown" ? EQUIPMENT_LABEL[frame.equipment] : null);
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

  // Use the unit's own rooms.
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

  // The SOP for it (its questions, minus what the message already says).
  if (classification.confidence !== "low") chooseSop(gathered, frame, message);

  // Only reflect the problem back when it was understood; use our words, not theirs.
  const acknowledgement = buildAcknowledgement(normalizeVocabulary(message), {
    timing,
    status,
    understood: classification.confidence !== "low",
  });

  if (classification.confidence === "low") {
    const clarifyingQ = buildClarifyingCategoryQuestion(message, [classification.category]);
    return {
      classification,
      emergency,
      triageClassification: { gathered, current_question: "classify_category", issue_classification: issueClassification, issue_frame: frame },
      reply: buildInitialReplyWithClarification(acknowledgement, clarifyingQ),
      extracted: { location, timing, status },
      frame,
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
    triageClassification: { gathered, current_question: nextQ?.field ?? null, issue_classification: issueClassification, issue_frame: frame },
    reply: buildInitialReply(acknowledgement, questionText ?? ALL_SET_REPLY),
    extracted: { location, timing, status },
    frame,
  };
}

/**
 * A reply may add information ("it's grease, not water"): fold it into the
 * stored frame. Call before advanceGather. Tickets from before the frame
 * existed get one from their description first.
 */
export async function updateIssueFrame(
  stored: TriageClassification,
  description: string,
  message: string,
  understander?: ModelUnderstander | null
): Promise<IssueFrame> {
  const current = stored.issue_frame ?? (await understand(description, understander ?? null)).frame;
  stored.issue_frame = await understandReply(current, message, understander ?? null);
  // Intake answers win over what the reply text suggests; the rest follows the frame.
  if (stored.gathered?.sop) stored.gathered.sop = { ...stored.gathered.sop, slots: frameSlots(stored.issue_frame) };
  return stored.issue_frame;
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
  } else if (currentQuestion?.startsWith("intake:") && gathered.sop) {
    const sop = sopByKey(gathered.sop.issue_key);
    const question = sop?.intake_questions.find((q) => `intake:${q.id}` === currentQuestion);
    if (sop && question) {
      const result = answerIntake(sop, gathered.sop, question, message);
      gathered = { ...gathered, sop: result.state };
      syncFromIntake(gathered);
      if (result.emergency) {
        return {
          kind: "emergency",
          gathered,
          emergency: { kind: result.emergency as EmergencyKind, phrase: `${question.question} "${message.slice(0, 80)}"` },
        };
      }
      // An answer that changes what it is (the water is at the toilet; it's grease) can change the SOP.
      if (result.frameUpdate && stored.issue_frame && ["equipment", "symptom", "substance"].includes(result.frameUpdate.slot)) {
        stored.issue_frame = { ...stored.issue_frame, [result.frameUpdate.slot]: result.frameUpdate.value };
        if (result.frameUpdate.slot === "equipment" && !gathered.equipment) gathered.equipment = EQUIPMENT_LABEL[stored.issue_frame.equipment];
        chooseSop(gathered, stored.issue_frame, `${description} ${message}`);
      }
    }
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

  // SOP intake: its next question, or done. (Answering "what type of issue" can bring an SOP into play.)
  if (!gathered.sop && gathered.category && stored.issue_frame) chooseSop(gathered, stored.issue_frame, description);
  if (gathered.sop) {
    const next = nextSopQuestion(gathered);
    if (next) return { kind: "ask", gathered, nextQuestion: next.field, reply: next.text };
    completeIntake(gathered);
    return { kind: "complete", gathered };
  }

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
    // The SOP decides whether the generic electrical check adds anything (not for a chirping alarm).
    const sop = gathered.sop ? sopByKey(gathered.sop.issue_key) : null;
    if (sop && !sop.ask_safety_check && !safety.detected) safety.needsQuestion = false;
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
