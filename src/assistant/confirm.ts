/**
 * CONFIRM_SUMMARY: the tenant confirms the summary (the report is
 * submitted, with the manager's summary and diagnosis) or corrects it.
 */
import { isSummaryConfirmation } from "./triage/confirmation";
import { extractCurrentStatus, extractEquipment, extractLocation, extractTiming } from "./triage/extract-details";
import { parseCategoryCorrection } from "./triage/classify-issue";
import { generateTenantSummary, generateTicketSummary } from "./triage/summary";
import type { TriageClassification, TroubleshootingStep } from "./triage/types";

export type ConfirmState = TriageClassification & { description: string };

export type ConfirmOutcome =
  | {
      kind: "submitted";
      reply: string;
      managerSummary: string;
      steps: TroubleshootingStep[];
      /** Escalated by the troubleshooting or flagged as an emergency. */
      urgent: boolean;
      emergency: boolean;
    }
  | { kind: "corrected"; reply: string };

export const SUBMITTED_REPLY = "Your report has been submitted. Your property manager has been notified and will follow up with you.";

/** Mutates `state` (corrections). */
export function confirmOrCorrect(state: ConfirmState, message: string, confirmButton: string | undefined, mediaCount: number): ConfirmOutcome {
  const text = confirmButton ?? message;
  const gathered = state.gathered;
  const guided = state.guided_troubleshooting;

  // Negation-aware: "not right" / "no, that's wrong" must not submit.
  if (isSummaryConfirmation(text, confirmButton)) {
    const steps: TroubleshootingStep[] = guided
      ? guided.steps.map((s) => ({ step: s.index + 1, description: s.description, completed: guided.log.some((l) => l.step_index === s.index && l.result !== null) }))
      : [];
    const managerSummary =
      state.summary ??
      generateTicketSummary({ description: state.description, gathered, steps, mediaCount, timestamp: new Date().toISOString(), guidedState: guided });
    const emergency = gathered.is_emergency ?? false;
    return { kind: "submitted", reply: SUBMITTED_REPLY, managerSummary, steps, urgent: emergency || guided?.outcome === "escalated", emergency };
  }

  // A correction: take what it changes.
  gathered.location_in_unit = extractLocation(text) ?? gathered.location_in_unit;
  gathered.started_when = extractTiming(text) ?? gathered.started_when;
  gathered.current_status = extractCurrentStatus(text) ?? gathered.current_status;
  gathered.equipment = extractEquipment(text) ?? gathered.equipment;
  // "It's X instead of Y"
  const corrected = parseCategoryCorrection(text, gathered.category ?? "general");
  if (corrected) {
    gathered.category = corrected;
    gathered.subcategory = null;
  }
  const summary = generateTenantSummary({ description: state.description, gathered, mediaCount, guidedOutcome: guided?.outcome });
  return { kind: "corrected", reply: `Got it, I've updated your report.\n\n${summary}` };
}
