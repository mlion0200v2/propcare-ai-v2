/**
 * GATHER_INFO: understand the first message, pick the SOP, ask its
 * questions one at a time (or the generic ones when no SOP matches), then
 * the safety check, then on to photos.
 */
import { understand, understandReply, type ModelUnderstander } from "./understanding";
import { EQUIPMENT_CATEGORY, EQUIPMENT_LABEL, type Room } from "./understanding/taxonomy";
import type { IssueFrame } from "./understanding/frame";
import { sopByKey } from "./sops/catalog";
import { selectSop } from "./sops/select";
import { answerIntake, frameSlots, nextIntakeQuestion, optionsFor, prefillFromMessage, startIntake, type IntakeState } from "./sops/intake";
import type { IntakeQuestion } from "./sops/schema";
import { matchingRooms, whichRoomQuestion, type PropertyContext } from "./property";
import { buildInitialGathered, buildInitialReply, getNextMissingField, isBaseField, QUESTIONS, recordBaseAnswer } from "./triage/base-questions";
import {
  extractLocation,
  extractTiming,
  extractCurrentStatus,
  extractEntryPoint,
  extractEquipment,
  inferLocationFromEquipment,
  detectEquipmentAmbiguity,
} from "./triage/extract-details";
import { getExtendedQuestionText, getNextExtendedQuestion, isExtendedField, isGatherComplete, processExtendedAnswer } from "./triage/gather-issue";
import { normalizeVocabulary } from "./triage/vocabulary";
import { buildAcknowledgement } from "./triage/acknowledgement";
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
} from "./triage/classify-issue";
import { detectEmergency, classifySafetyAnswer, type EmergencyKind, type EmergencyMatch, type SafetyAnswer } from "./triage/emergency";
import { detectSafety } from "./triage/detect-safety";
import { buildMediaPrompt } from "./triage/guidance";
import type { GatheredInfo, TriageClassification } from "./triage/types";

export interface GatherContext {
  property: PropertyContext;
  understander: ModelUnderstander | null;
  /** The safety gate asked and the tenant said there's no danger: don't escalate on the same words again. */
  safetyCleared?: boolean;
}

/** The conversation fields this phase reads and writes. */
export type GatherState = TriageClassification & { description: string };

export type GatherOutcome =
  | { kind: "ask"; reply: string }
  | { kind: "emergency"; emergency: EmergencyMatch }
  | { kind: "photos"; reply: string };

const ALL_SET_REPLY = "Thanks for all the details! Is there anything else about the issue you'd like to mention before I proceed?";

/** Shared questions whose tap options are enough; others list their options in the text. */
const PLAIN_SLOTS = new Set(["onset", "status", "amount", "electrical_near", "brand_model", "room"]);

const ROOM_LABEL: Record<Room, string | null> = {
  kitchen: "Kitchen", bathroom: "Bathroom", bedroom: "Bedroom", living_room: "Living room",
  laundry: "Laundry", basement: "Basement", hallway: "Hallway", balcony: "Balcony",
  garage: "Garage", exterior: "Outside", unknown: null,
};

export function intakeQuestionText(q: IntakeQuestion, state: IntakeState): string {
  const all = optionsFor(q, state);
  const options = all.filter((o) => o.value !== "not_sure");
  // Two options (yes/no) or shared questions: the tap answers are enough.
  if (PLAIN_SLOTS.has(q.slot) || options.length < 3) return q.question;
  const shown = options.map((o) => o.label.charAt(0).toLowerCase() + o.label.slice(1));
  return all.length > options.length ? `${q.question} (${shown.join("; ")}; or not sure)` : `${q.question} (${shown.join("; ")})`;
}

/** The selected SOP's next question; the room uses the unit's own rooms (location_in_unit). */
function nextSopQuestion(gathered: GatheredInfo): { field: string; text: string } | null {
  const state = gathered.sop!;
  const sop = sopByKey(state.issue_key);
  if (!sop) return null;
  const q = nextIntakeQuestion(sop, state, { room: !!gathered.location_in_unit });
  if (!q) return null;
  if (q.slot === "room") return { field: "location_in_unit", text: QUESTIONS.location_in_unit };
  return { field: `intake:${q.id}`, text: intakeQuestionText(q, state) };
}

/** Next question (SOP intake, else base or extended), or null when every detail is in. */
export function nextGatherQuestion(gathered: GatheredInfo): { field: string; text: string } | null {
  if (gathered.sop) return gathered.sop.complete ? null : nextSopQuestion(gathered);
  const nextBase = getNextMissingField(gathered);
  if (nextBase) return { field: nextBase, text: QUESTIONS[nextBase] };
  const nextExtended = getNextExtendedQuestion(gathered);
  if (nextExtended) return { field: nextExtended, text: getExtendedQuestionText(nextExtended) };
  return null;
}

/** The summary reads these plain fields; the intake answers fill them. */
function syncFromIntake(gathered: GatheredInfo): void {
  const a = gathered.sop?.answers;
  if (!a) return;
  if (a.onset && !gathered.started_when) gathered.started_when = a.onset.label;
  if (a.status && !gathered.current_status) gathered.current_status = a.status.label;
  if (a.brand_model && !gathered.brand_model) gathered.brand_model = a.brand_model.value === "unknown" ? "unknown" : a.brand_model.label;
}

/** Pick (or switch to) the SOP for this frame; answers to shared slots carry over. */
function chooseSop(gathered: GatheredInfo, frame: IssueFrame, text: string, property: PropertyContext | null): void {
  const choice = selectSop(frame, text);
  if (!choice) return;
  const previous = gathered.sop;
  if (previous && previous.issue_key === choice.sop.issue_key) return;
  let state = startIntake(choice.sop, frame, choice.confidence, property);
  if (previous) state = { ...state, answers: { ...previous.answers }, asked: [...previous.asked], fixtures: previous.fixtures };
  gathered.sop = prefillFromMessage(choice.sop, state, text);
  gathered.category ??= choice.sop.category;
  syncFromIntake(gathered);
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
    // The first message prefers window/screen, later turns prefer mold.
    gathered.subcategory = opening
      ? classifyStructural(message) ?? classifyMold(message) ?? null
      : classifyMold(message) ?? classifyStructural(message) ?? null;
    return;
  }
  const fn = gathered.category ? byCategory[gathered.category] : undefined;
  const sub = fn ? fn(message) : null;
  if (sub) gathered.subcategory = sub;
}

function emergencyFromFrame(frame: IssueFrame, message: string): EmergencyMatch | null {
  if (frame.severity !== "emergency") return null;
  const kind: EmergencyKind =
    frame.substance === "gas" ? "gas"
    : frame.equipment === "co_alarm" ? "carbon_monoxide"
    : frame.substance === "smoke" ? "fire"
    : frame.symptom === "sparking" ? "electrical"
    : frame.symptom === "no_heat" ? "no_heat"
    : frame.substance === "sewage" ? "sewage"
    : "unconfirmed_safety";
  return { kind, phrase: `understood: ${message.slice(0, 100)}` };
}

/** Category: the frame decides when the keyword rules can't; a clear SOP match settles it too. */
function categorise(message: string, frame: IssueFrame): ClassificationResult {
  const classification = classifyIssue(message);
  if (classification.confidence !== "low") return classification;
  if (frame.equipment !== "unknown" && frame.confidence.equipment >= 0.6) {
    return { category: EQUIPMENT_CATEGORY[frame.equipment] as IssueCategory, confidence: "medium", rationale: "issue_frame" };
  }
  if (frame.symptom === "pests") return { category: "pest_control", confidence: "medium", rationale: "issue_frame" };
  const sop = selectSop(frame, message);
  if (sop?.confidence === "high") return { category: sop.sop.category as IssueCategory, confidence: "medium", rationale: "sop_match" };
  return classification;
}

/** The first message: understand it, keep what it already says, ask the first question. */
export async function openGather(
  message: string,
  ctx: GatherContext
): Promise<{ state: GatherState; reply: string; emergency: EmergencyMatch | null }> {
  const { frame } = await understand(message, ctx.understander);
  const classification = categorise(message, frame);
  // Deterministic rules first; the understanding may only raise urgency.
  const emergency = ctx.safetyCleared ? null : (detectEmergency(message) ?? emergencyFromFrame(frame, message));

  const frameRoom = frame.confidence.room >= 0.7 ? ROOM_LABEL[frame.room] : null;
  const timing = extractTiming(message);
  const status = extractCurrentStatus(message);
  const equipment = extractEquipment(message) ?? (frame.equipment !== "unknown" ? EQUIPMENT_LABEL[frame.equipment] : null);
  const { candidates: equipmentCandidates } = detectEquipmentAmbiguity(message);

  const gathered = buildInitialGathered();
  if (classification.confidence !== "low") gathered.category = classification.category;
  if (emergency) gathered.is_emergency = true;
  else if (ctx.safetyCleared) gathered.is_emergency = false;
  gathered.location_in_unit = extractLocation(message) ?? inferLocationFromEquipment(message) ?? frameRoom;
  gathered.started_when = timing;
  gathered.current_status = status;
  gathered.entry_point = extractEntryPoint(message);
  gathered.equipment = equipment;
  if (equipmentCandidates.length > 0) gathered.equipment_candidates = equipmentCandidates;
  // Subcategory follows the classifier's category, even before it is accepted.
  {
    const probe = { ...gathered, category: classification.category, subcategory: null } as GatheredInfo;
    classifySubcategory(probe, message, true);
    gathered.subcategory = probe.subcategory;
  }

  // The unit's own rooms: "bathroom" in a two-bathroom unit asks which.
  let roomWord: string | null = null;
  if (gathered.location_in_unit && ctx.property.rooms.length) {
    const candidates = matchingRooms(gathered.location_in_unit, ctx.property.rooms);
    if (candidates.length > 1) {
      gathered.location_candidates = candidates;
      roomWord = gathered.location_in_unit;
      gathered.location_in_unit = null;
    } else if (candidates.length === 1) {
      gathered.location_in_unit = candidates[0];
    }
  }

  if (classification.confidence !== "low") chooseSop(gathered, frame, message, ctx.property);

  // Only reflect the problem back when it was understood; in our words, not theirs.
  const acknowledgement = buildAcknowledgement(normalizeVocabulary(message), {
    timing,
    status,
    understood: classification.confidence !== "low",
  });
  const issue_classification = { category: classification.category, confidence: classification.confidence, rationale: classification.rationale };
  const state: GatherState = { description: message, gathered, current_question: null, issue_classification, issue_frame: frame };

  if (classification.confidence === "low") {
    state.current_question = "classify_category";
    return { state, emergency, reply: buildInitialReply(acknowledgement, buildClarifyingCategoryQuestion(message, [classification.category])) };
  }
  const next = nextGatherQuestion(gathered);
  state.current_question = next?.field ?? null;
  const text = next?.field === "location_in_unit" && roomWord && gathered.location_candidates ? whichRoomQuestion(roomWord, gathered.location_candidates) : next?.text;
  return { state, emergency, reply: buildInitialReply(acknowledgement, text ?? ALL_SET_REPLY) };
}

/**
 * A reply in GATHER_INFO: fold what it says into the understanding, record
 * the answer, then the next question, the safety check, or photos.
 * Mutates `state`.
 */
export async function continueGather(state: GatherState, message: string, ctx: GatherContext): Promise<GatherOutcome> {
  // A reply can add to (or correct) what we understood; urgency never drops.
  const current = state.issue_frame ?? (await understand(state.description, ctx.understander)).frame;
  state.issue_frame = await understandReply(current, message, ctx.understander);
  let gathered = state.gathered ?? buildInitialGathered();
  // Intake answers win over what the reply text suggests; the rest follows the frame.
  if (gathered.sop) gathered.sop = { ...gathered.sop, slots: frameSlots(state.issue_frame) };

  const question = state.current_question;
  if (question === "classify_category") {
    const prev = state.issue_classification ?? { category: "general", confidence: "low" as const, rationale: "default" };
    const updated = parseClarifyingResponse(message, { category: prev.category as IssueCategory, confidence: prev.confidence, rationale: prev.rationale });
    gathered.category = updated.category;
    state.issue_classification = { category: updated.category, confidence: updated.confidence, rationale: updated.rationale };
  } else if (question === "safety_check") {
    // Concern or unclear answers escalate (see safetyAnswerEmergency); only "no" reaches here.
    gathered.is_emergency = false;
    state.safety_detection = { detected: false, method: "user_denied", rationale: `user_response: "${message.slice(0, 50)}"` };
  } else if (question?.startsWith("intake:") && gathered.sop) {
    const sop = sopByKey(gathered.sop.issue_key);
    const q = sop?.intake_questions.find((x) => `intake:${x.id}` === question);
    if (sop && q) {
      const result = answerIntake(sop, gathered.sop, q, message);
      gathered = { ...gathered, sop: result.state };
      syncFromIntake(gathered);
      if (result.emergency) {
        state.gathered = gathered;
        return { kind: "emergency", emergency: { kind: result.emergency as EmergencyKind, phrase: `${q.question} "${message.slice(0, 80)}"` } };
      }
      // An answer that changes what it is (the water is at the toilet; it's grease) can change the SOP.
      if (result.frameUpdate && ["equipment", "symptom", "substance"].includes(result.frameUpdate.slot)) {
        state.issue_frame = { ...state.issue_frame, [result.frameUpdate.slot]: result.frameUpdate.value };
        if (result.frameUpdate.slot === "equipment" && !gathered.equipment) gathered.equipment = EQUIPMENT_LABEL[state.issue_frame.equipment];
        chooseSop(gathered, state.issue_frame, `${state.description} ${message}`, ctx.property);
      }
    }
  } else if (question && isExtendedField(question)) {
    gathered = processExtendedAnswer(gathered, question, message);
  } else if (question && isBaseField(question)) {
    gathered = recordBaseAnswer(gathered, question, message);
  }

  gathered.entry_point ??= extractEntryPoint(message);
  gathered.equipment ??= extractEquipment(message);
  classifySubcategory(gathered, message);
  // Answering "what type of issue" can bring an SOP into play.
  if (!gathered.sop && gathered.category) chooseSop(gathered, state.issue_frame, state.description, ctx.property);
  state.gathered = gathered;

  const next = gathered.sop || !isGatherComplete(gathered) ? nextGatherQuestion(gathered) : null;
  if (next) {
    state.current_question = next.field;
    return { kind: "ask", reply: next.text };
  }
  if (gathered.sop) {
    gathered.sop = { ...gathered.sop, complete: true };
    syncFromIntake(gathered);
    gathered.started_when ??= "Not asked";
    gathered.current_status ??= "Not asked";
  }
  return afterGather(state, ctx);
}

/** Every detail is in: auto-detected danger, a targeted safety question, or on to photos. */
function afterGather(state: GatherState, ctx: GatherContext): GatherOutcome {
  const gathered = state.gathered;
  state.current_question = null;
  if (gathered.is_emergency === null) {
    const safety = detectSafety(state.description, gathered);
    // The SOP decides whether the generic electrical check adds anything (not for a chirping alarm).
    const sop = gathered.sop ? sopByKey(gathered.sop.issue_key) : null;
    if (sop && !sop.ask_safety_check && !safety.detected) safety.needsQuestion = false;
    if (safety.detected) {
      gathered.is_emergency = true;
      state.safety_detection = { detected: true, method: "auto", rationale: safety.rationale };
      return { kind: "emergency", emergency: { kind: safety.kind ?? "unconfirmed_safety", phrase: safety.rationale } };
    }
    if (safety.needsQuestion && !state.safety_detection) {
      state.current_question = "safety_check";
      return { kind: "ask", reply: safety.question! };
    }
    gathered.is_emergency = false;
    state.safety_detection = { detected: false, method: "skipped", rationale: safety.rationale };
  }
  if (gathered.is_emergency === true) {
    return { kind: "emergency", emergency: { kind: "unconfirmed_safety", phrase: state.safety_detection?.rationale ?? "flagged during triage" } };
  }
  return { kind: "photos", reply: buildMediaPrompt(gathered, ctx.property) };
}

/**
 * A non-"no" answer to the safety question is treated as an emergency. Mutates `state`.
 *
 * @param answer how the answer was read (the safety gate reads it in any language)
 */
export function safetyAnswerEmergency(state: TriageClassification, message: string, answer: SafetyAnswer = classifySafetyAnswer(message)): EmergencyMatch | null {
  if (state.current_question !== "safety_check") return null;
  if (answer === "no_concern") return null;
  state.safety_detection = {
    detected: true,
    method: answer === "concern" ? "user_confirmed" : "user_unclear",
    rationale: `user_response: "${message.slice(0, 50)}"`,
  };
  return { kind: "unconfirmed_safety", phrase: message.slice(0, 120) };
}
