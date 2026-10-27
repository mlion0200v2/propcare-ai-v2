/**
 * One tenant message in, the next step out. Dispatches on the
 * conversation's phase; keeps nothing between calls.
 *
 *   GATHER_INFO → (safety check) → AWAITING_MEDIA → GUIDED_TROUBLESHOOTING
 *     → CONFIRM_SUMMARY → DONE, and EMERGENCY from anywhere.
 */
import type { AssistantState, Phase, TicketUpdate, TurnRequest, TurnResponse } from "./api";
import { openAIUnderstander, type ModelUnderstander } from "./understanding";
import { openGather, continueGather, safetyAnswerEmergency, intakeQuestionText, type GatherContext } from "./gather";
import { sopByKey } from "./sops/catalog";
import { startTroubleshooting, continueTroubleshooting, type TroubleshootOutcome } from "./troubleshoot";
import { confirmOrCorrect } from "./confirm";
import { buildDiagnosisView } from "./sops/diagnosis-view";
import { buildChatHints } from "./triage/hints";
import { buildInitialGathered } from "./triage/base-questions";
import { buildEmergencyFollowUpReply, detectEmergency, emergencyAdvice, type EmergencyKind, type EmergencyMatch } from "./triage/emergency";

export interface TurnOptions {
  /**
   * Model understanding. Defaults to OpenAI when a key is configured (else
   * rules only); tests and the eval pass their own, or null.
   */
  understander?: ModelUnderstander | null;
}

const DONE_REPLY = "This report has already been submitted. Your property manager will follow up with you.";

/**
 * Text channels (email, voice) hear the options in the question; the web
 * shows them one per line under it, so there the question stands alone.
 */
function forChannel(req: TurnRequest, state: AssistantState, reply: string): string {
  const sopState = state.gathered?.sop;
  if (req.channel !== "web" || !sopState || !state.current_question?.startsWith("intake:")) return reply;
  const q = sopByKey(sopState.issue_key)?.intake_questions.find((x) => `intake:${x.id}` === state.current_question);
  if (!q) return reply;
  const inline = intakeQuestionText(q, sopState);
  return inline === q.question ? reply : reply.replace(inline, q.question);
}

function respond(
  req: TurnRequest,
  state: AssistantState,
  phase: Phase,
  reply: string,
  extra: { ticket?: TicketUpdate; emergency?: EmergencyMatch | null; done?: boolean } = {}
): TurnResponse {
  state.phase = phase;
  const hints =
    phase === "DONE" || phase === "EMERGENCY"
      ? { quickReplies: [], notes: [] }
      : buildChatHints({
          currentQuestion: state.current_question,
          triageState: phase,
          category: state.gathered?.category ?? null,
          description: state.description,
          profile: req.property,
          locationCandidates: state.gathered?.location_candidates ?? null,
          gathered: state.gathered,
        });
  state.ui = { options: hints.quickReplies, notes: hints.notes };
  return {
    reply: forChannel(req, state, reply),
    options: state.ui.options,
    notes: state.ui.notes,
    phase,
    state,
    emergency: extra.emergency ? { kind: extra.emergency.kind, phrase: extra.emergency.phrase } : null,
    ticket: extra.ticket ?? {},
    done: extra.done ?? false,
  };
}

/** Stop and escalate: safety advice now; the app alerts the manager. */
function emergencyResponse(req: TurnRequest, state: AssistantState, emergency: EmergencyMatch): TurnResponse {
  state.gathered = { ...(state.gathered ?? buildInitialGathered()), is_emergency: true };
  state.current_question = null;
  state.safety_detection = state.safety_detection?.detected
    ? state.safety_detection
    : { detected: true, method: "auto", rationale: `${emergency.kind}: "${emergency.phrase}"` };
  state.emergency = {
    kind: emergency.kind,
    phrase: emergency.phrase,
    detected_at: new Date().toISOString(),
    previous_state: state.phase,
    manager_notified: false,
  };
  return respond(req, state, "EMERGENCY", emergencyAdvice(emergency.kind as EmergencyKind), {
    emergency,
    ticket: { priority: "emergency", escalate: true, flag_emergency: true },
  });
}

function fromTroubleshooting(req: TurnRequest, state: AssistantState, outcome: TroubleshootOutcome): TurnResponse {
  const category = state.gathered.category ?? "general";
  switch (outcome.kind) {
    case "guided":
      return respond(req, state, "GUIDED_TROUBLESHOOTING", outcome.reply);
    case "confirm":
      return respond(req, state, "CONFIRM_SUMMARY", outcome.reply, { ticket: { category, troubleshooting_steps: outcome.steps } });
    case "escalated":
      state.summary = outcome.managerSummary;
      return respond(req, state, "DONE", outcome.reply, {
        done: true,
        ticket: {
          category,
          priority: "high",
          escalate: true,
          manager_summary: outcome.managerSummary,
          diagnosis: buildDiagnosisView(state.gathered, req.media.count),
          notify_manager: "urgent",
        },
      });
    case "emergency":
      return emergencyResponse(req, state, outcome.emergency);
  }
}

export async function turn(req: TurnRequest, options: TurnOptions = {}): Promise<TurnResponse> {
  const ctx: GatherContext = {
    property: req.property,
    understander: options.understander === undefined ? openAIUnderstander() : options.understander,
  };
  const message = req.message.trim();

  // The first message.
  if (!req.state) {
    const opened = await openGather(message, ctx);
    const state: AssistantState = { v: 1, phase: "GATHER_INFO", ui: { options: [], notes: [] }, ...opened.state };
    if (opened.emergency) return emergencyResponse(req, state, opened.emergency);
    return respond(req, state, "GATHER_INFO", opened.reply);
  }

  const state: AssistantState = structuredClone(req.state);
  if (state.phase === "DONE") return respond(req, state, "DONE", DONE_REPLY, { done: true });
  if (state.phase === "EMERGENCY") return respond(req, state, "EMERGENCY", buildEmergencyFollowUpReply());

  // Danger in any reply, in any phase, stops everything else.
  const emergency = (message ? detectEmergency(message) : null) ?? (state.phase === "GATHER_INFO" ? safetyAnswerEmergency(state, message) : null);
  if (emergency) return emergencyResponse(req, state, emergency);

  switch (state.phase) {
    case "GATHER_INFO": {
      const outcome = await continueGather(state, message, ctx);
      if (outcome.kind === "emergency") return emergencyResponse(req, state, outcome.emergency);
      return respond(req, state, outcome.kind === "photos" ? "AWAITING_MEDIA" : "GATHER_INFO", outcome.reply);
    }
    case "AWAITING_MEDIA":
      // Photos added or skipped: either way, on to the procedure.
      return fromTroubleshooting(req, state, await startTroubleshooting(state, req.media.count, req.conversation));
    case "GUIDED_TROUBLESHOOTING":
      return fromTroubleshooting(req, state, await continueTroubleshooting(state, message, req.media.count, req.conversation));
    case "CONFIRM_SUMMARY": {
      const outcome = confirmOrCorrect(state, message, req.action === "confirm_summary" ? "confirm" : undefined, req.media.count);
      if (outcome.kind === "corrected") return respond(req, state, "CONFIRM_SUMMARY", outcome.reply);
      state.summary = outcome.managerSummary;
      return respond(req, state, "DONE", outcome.reply, {
        done: true,
        ticket: {
          category: state.gathered.category ?? "general",
          troubleshooting_steps: outcome.steps.length ? outcome.steps : undefined,
          priority: outcome.urgent ? "emergency" : "medium",
          escalate: outcome.urgent,
          flag_emergency: outcome.emergency,
          manager_summary: outcome.managerSummary,
          diagnosis: buildDiagnosisView(state.gathered, req.media.count),
          notify_manager: outcome.urgent ? "urgent" : "summary",
        },
      });
    }
  }
}
