/**
 * After photos: find the procedure (knowledge base + grounded steps, with
 * validation and safe fallbacks), then walk the tenant through it one step
 * at a time, and end on the summary to confirm.
 */
import { querySnippets } from "./retrieval/pinecone";
import type { RetrievalSnippet } from "./retrieval/types";
import {
  generateGroundedSteps,
  generateWebSearchSteps,
  convertToGuidedSteps,
  shouldUseGuidedTroubleshooting,
  filterStepsByEquipment,
  enforceStepSafety,
  type GroundedResult,
} from "./triage/grounding";
import { validateGroundedResult } from "./triage/validate";
import { getFallbackSOP } from "./triage/sop-fallback";
import {
  determineNextAction,
  findNextEligibleStep,
  getTerminalGuidance,
  buildStepMessage,
  buildFeedbackReply,
  buildClarifyReply,
  buildHelpReply,
} from "./triage/step-feedback";
import { classifyStepHybrid } from "./triage/interpret-step-response";
import { generateStepHelp } from "./triage/step-help";
import { checkPestEscalation } from "./triage/detect-safety";
import { detectEquipmentCorrection, extractEntryPoint, getEquipmentCategory, inferLocationFromEquipment } from "./triage/extract-details";
import { generateTenantSummary, generateTicketSummary } from "./triage/summary";
import { managerOnlyReply } from "./triage/guidance";
import { buildInitialGathered } from "./triage/base-questions";
import type { EmergencyMatch } from "./triage/emergency";
import type { GuidedTroubleshootingState, TroubleshootingStep, TriageClassification, ValidationResult } from "./triage/types";
import { logError, logWarn } from "./log";

export type TroubleshootState = TriageClassification & { description: string };

export type TroubleshootOutcome =
  /** A guided step to try (state.guided_troubleshooting is set). */
  | { kind: "guided"; reply: string }
  /** Steps given or finished: the summary for the tenant to confirm. */
  | { kind: "confirm"; reply: string; steps: TroubleshootingStep[] }
  /** Straight to the manager, no confirmation (pests that need a professional). */
  | { kind: "escalated"; reply: string; managerSummary: string }
  | { kind: "emergency"; emergency: EmergencyMatch };

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

function fallbackResult(state: TroubleshootState, isEmergency: boolean, disclaimer = ""): GroundedResult {
  const g = state.gathered;
  const sop = getFallbackSOP(g.category ?? "general", isEmergency, g.subcategory, g.equipment, g.subcategory);
  return { reply: disclaimer + sop.display, steps: sop.steps, usedFallback: true };
}

/** Steps from the knowledge base, validated; web search, then a built-in SOP, when they don't hold up. */
async function procedureSteps(state: TroubleshootState, trace: string): Promise<{ result: GroundedResult; validation: ValidationResult }> {
  const gathered = state.gathered;
  const isEmergency = gathered.is_emergency ?? false;

  let snippets: RetrievalSnippet[] = [];
  let lowConfidence = true;
  if (!state.retrieval) {
    try {
      const r = await querySnippets(gathered, state.description, trace);
      state.retrieval = r.log;
      snippets = r.snippets;
      lowConfidence = r.log.low_confidence;
    } catch (err) {
      logError("assistant_retrieval", err, { trace });
    }
  } else {
    snippets = state.retrieval.matches.map((m) => ({
      id: m.id,
      score: m.score,
      title: String(m.metadata?.title ?? m.id),
      content: String(m.metadata?.content ?? m.metadata?.text ?? ""),
      metadata: m.metadata,
    }));
    lowConfidence = state.retrieval.low_confidence;
  }

  let result: GroundedResult;
  try {
    result = await generateGroundedSteps(gathered, snippets, isEmergency, lowConfidence);
  } catch (err) {
    logError("assistant_grounding", err, { trace });
    result = fallbackResult(state, isEmergency);
  }
  // Steps about other appliances (a fridge step for a range hood) are dropped.
  result = filterStepsByEquipment(result, gathered.equipment, gathered.category ?? "general", isEmergency, gathered.subcategory);

  const highest = state.retrieval?.highest_score ?? 0;
  const average = state.retrieval?.average_score ?? 0;
  let validation = validateGroundedResult(result, snippets, gathered, highest, average);
  if (!validation.is_valid) {
    if (validation.missing_safety_guidance) {
      result = { ...result, reply: EMERGENCY_SAFETY_BLOCK + result.reply };
      validation = { ...validateGroundedResult(result, snippets, gathered, highest, average), action_taken: "prepend_safety" };
    }
    const reason = validation.missing_citations ? "missing_citations" : validation.domain_mismatch ? "domain_mismatch" : validation.low_confidence ? "low_confidence" : null;
    if (reason === "low_confidence" && result.usedWebSearch) {
      validation = { ...validation, action_taken: "none", low_confidence: false };
    } else if (reason) {
      if (reason === "domain_mismatch") logWarn("assistant_domain_mismatch", "Domain mismatch: trying web search before a built-in SOP", { trace, category: gathered.category });
      const web = await generateWebSearchSteps(gathered, isEmergency);
      if (web) {
        result = web;
        validation = { ...validation, action_taken: "web_search_fallback" };
      } else if (reason === "low_confidence") {
        result = fallbackResult(state, isEmergency, "Note: We could not find a high-confidence match in our knowledge base for your specific issue. Here are general troubleshooting steps for this category:\n\n");
        validation = { ...validation, action_taken: "fallback_sop_with_disclaimer" };
      } else {
        result = fallbackResult(state, isEmergency);
        validation = { ...validation, action_taken: "fallback_sop" };
      }
    }
  } else {
    validation = { ...validation, action_taken: "none" };
  }

  // Never-instruct filter, whatever the source.
  const safe = enforceStepSafety(result);
  if (safe.removedUnsafe.length > 0) logWarn("assistant_unsafe_steps_removed", "Removed unsafe troubleshooting steps", { trace, rules: safe.removedUnsafe });
  result = safe;
  // Some reports go straight to the manager (neighbour noise): no troubleshooting.
  const managerReply = managerOnlyReply(gathered);
  if (managerReply) result = { ...result, reply: managerReply, steps: [] };
  return { result, validation };
}

/** The tenant's summary to confirm, after the steps (or the outcome of the guided steps). */
function toConfirm(state: TroubleshootState, lead: string, mediaCount: number, steps: TroubleshootingStep[]): TroubleshootOutcome {
  const summary = generateTenantSummary({
    description: state.description,
    gathered: state.gathered,
    mediaCount,
    guidedOutcome: state.guided_troubleshooting?.outcome,
  });
  return { kind: "confirm", reply: `${lead}\n\n---\n\n${summary}`, steps };
}

function guidedSteps(g: GuidedTroubleshootingState): TroubleshootingStep[] {
  return g.steps.map((s) => ({ step: s.index + 1, description: s.description, completed: g.log.some((l) => l.step_index === s.index && l.result !== null) }));
}

/** Photos done (or skipped): pest escalation, guided steps, or straight to the summary. Mutates `state`. */
export async function startTroubleshooting(state: TroubleshootState, mediaCount: number, trace: string): Promise<TroubleshootOutcome> {
  const gathered = state.gathered;

  const pest = checkPestEscalation(gathered, state.description);
  if (pest.shouldEscalate) {
    const entryNote = gathered.entry_point ? ` We've noted the entry point you reported (${gathered.entry_point}) and will include that in the work order.` : "";
    const reply = [
      `Based on what you've described, this pest issue needs professional attention.${entryNote}`,
      "",
      "Your property manager has been notified and will arrange for a licensed pest control service. They should be in touch within 1 business day.",
      "",
      "In the meantime, please keep food stored in sealed containers and avoid disturbing any areas where you've noticed activity.",
    ].join("\n");
    const managerSummary = `Pest escalation: ${pest.reason}\n\n${generateTicketSummary({ description: state.description, gathered, steps: [], mediaCount, timestamp: new Date().toISOString() })}`;
    return { kind: "escalated", reply, managerSummary };
  }

  const { result, validation } = await procedureSteps(state, trace);
  state.validation = validation;
  if (result.steps.length > 0) {
    const steps = convertToGuidedSteps(result.steps);
    if (shouldUseGuidedTroubleshooting(steps, gathered.is_emergency ?? false)) {
      state.guided_troubleshooting = {
        steps,
        current_step_index: 0,
        log: [{ step_index: 0, presented_at: new Date().toISOString(), responded_at: null, raw_response: null, result: null }],
        outcome: "in_progress",
      };
      return { kind: "guided", reply: buildStepMessage(steps[0], true) };
    }
  }
  return toConfirm(state, result.reply, mediaCount, result.steps);
}

/** The tenant's reply to a guided step. Mutates `state`. */
export async function continueTroubleshooting(state: TroubleshootState, message: string, mediaCount: number, trace: string): Promise<TroubleshootOutcome> {
  const guided = state.guided_troubleshooting;
  const current = guided?.steps[guided.current_step_index];
  if (!guided || !current) {
    logError("assistant_guided_state", new Error("guided troubleshooting state missing or out of range"), { trace });
    return startTroubleshooting(state, mediaCount, trace);
  }
  const gathered = state.gathered ?? buildInitialGathered();

  // "It's not a fridge, it's the range hood": start over with the right equipment.
  const correction = detectEquipmentCorrection(message, gathered.equipment);
  if (correction.detected && correction.equipment) {
    const corrected = { ...gathered, equipment: correction.equipment };
    const category = getEquipmentCategory(correction.equipment);
    if (category && category !== corrected.category) {
      corrected.category = category;
      corrected.subcategory = null;
      state.issue_classification = { category, confidence: "high", rationale: `equipment_correction: ${correction.equipment}` };
    }
    corrected.location_in_unit ??= inferLocationFromEquipment(correction.equipment);
    state.gathered = corrected;
    state.retrieval = undefined;
    state.guided_troubleshooting = undefined;
    state.validation = undefined;
    return startTroubleshooting(state, mediaCount, trace);
  }

  // A newly reported entry point for pests: a professional is needed now.
  if (!gathered.entry_point) {
    const ep = extractEntryPoint(message);
    if (ep) {
      gathered.entry_point = ep;
      if (checkPestEscalation(gathered, message).shouldEscalate) {
        state.guided_troubleshooting = { ...guided, outcome: "escalated" };
        const lead = [
          `Thanks for that detail. We've noted the entry point you reported (${ep}) and will include that in the work order. This pest issue needs professional attention.`,
          "",
          "Your property manager has been notified and will arrange for a licensed pest control service.",
        ].join("\n");
        return toConfirm(state, lead, mediaCount, guidedSteps(state.guided_troubleshooting));
      }
    }
  }

  // Regex fast path, the model for ambiguous replies, then a fallback.
  const { result: feedback, note, source } = await classifyStepHybrid(message, current, gathered.category ?? "general", gathered.subcategory ?? null);
  const previousResult = guided.log.find((e) => e.step_index === guided.current_step_index)?.result ?? null;
  const log = guided.log.map((e) =>
    e.step_index === guided.current_step_index
      ? { ...e, responded_at: new Date().toISOString(), raw_response: message.slice(0, 500), result: feedback, ...(note ? { note } : {}), interpretation_source: source }
      : e
  );
  const withLog: GuidedTroubleshootingState = { ...guided, log };

  if (feedback === "unsafe") {
    state.guided_troubleshooting = { ...withLog, outcome: "escalated" };
    return { kind: "emergency", emergency: { kind: "unconfirmed_safety", phrase: message.slice(0, 120) } };
  }

  const action = determineNextAction(withLog, feedback, previousResult);
  if (action.type === "clarify") {
    state.guided_troubleshooting = withLog;
    return { kind: "guided", reply: buildClarifyReply(current) };
  }
  if (action.type === "provide_help") {
    state.guided_troubleshooting = withLog;
    const help = await generateStepHelp(current, gathered.equipment ?? null, gathered.category ?? "general");
    return { kind: "guided", reply: buildHelpReply(help, current) };
  }
  const replyOpts = { currentStepKind: current.step_kind, extractedNote: note };
  const finish = (outcome: GuidedTroubleshootingState["outcome"], reply: string) => {
    state.guided_troubleshooting = { ...withLog, outcome };
    return toConfirm(state, reply, mediaCount, guidedSteps(state.guided_troubleshooting));
  };
  if (action.type === "resolved" || action.type === "escalate" || action.type === "all_steps_done") {
    const outcome = action.type === "resolved" ? "resolved" : action.type === "escalate" ? "escalated" : "all_steps_done";
    const terminal = getTerminalGuidance({ ...withLog, outcome });
    return finish(outcome, buildFeedbackReply(feedback, action, undefined, terminal, replyOpts));
  }

  const nextIndex = findNextEligibleStep(withLog, guided.current_step_index);
  if (nextIndex === null) {
    const terminal = getTerminalGuidance({ ...withLog, outcome: "all_steps_done" });
    return finish("all_steps_done", buildFeedbackReply(feedback, { type: "all_steps_done" }, undefined, terminal, replyOpts));
  }
  const next = guided.steps[nextIndex];
  state.guided_troubleshooting = {
    ...withLog,
    current_step_index: nextIndex,
    log: [...log, { step_index: nextIndex, presented_at: new Date().toISOString(), responded_at: null, raw_response: null, result: null }],
    outcome: "in_progress",
  };
  return { kind: "guided", reply: buildFeedbackReply(feedback, action, next, undefined, replyOpts) };
}
