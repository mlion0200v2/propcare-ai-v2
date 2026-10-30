/**
 * One tenant message in, the next step out. The safety gate reads every
 * message first; then it dispatches on the conversation's phase. Keeps
 * nothing between calls.
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
import { buildEmergencyFollowUpReply, emergencyAdvice, type EmergencyKind, type EmergencyMatch } from "./triage/emergency";
import { checkSafety, openAISafetyModel, readSafetyAnswer, type SafetyModel } from "./safety/gate";
import { chatTurn, openChat, type ChatContext, type ChatOutcome } from "./chat/flow";
import { openAIConversationModel, type ConversationModel } from "./chat/model";
import { pineconeCardSearch, type CardSearch } from "./cards/search";

export interface TurnOptions {
  /**
   * Model understanding. Defaults to OpenAI when a key is configured (else
   * rules only); tests and the eval pass their own, or null.
   */
  understander?: ModelUnderstander | null;
  /** The safety gate's model. Defaults to OpenAI when a key is configured; null = keyword rules only. */
  safety?: SafetyModel | null;
  /**
   * How a new conversation runs: "chat" (the model leads, reading reference
   * cards) or "scripted" (the SOP intake). Defaults to ASSISTANT_MODE, else
   * scripted. A conversation keeps the mode it started in.
   */
  mode?: "chat" | "scripted";
  /** The conversation model for "chat". Defaults to OpenAI when a key is configured. */
  conversation?: ConversationModel | null;
  /** Knowledge-base similarity for finding cards. Defaults to Pinecone when configured. */
  search?: CardSearch | null;
}

/** What a turn works with: the scripted flow's context, the safety model, and the chat's (when on). */
interface Deps {
  ctx: GatherContext;
  safety: SafetyModel | null;
  chat: ChatContext | null;
}

/** What the old flow's own safety question asks about, for reading the answer. */
const SAFETY_QUESTION_TOPIC = "Do you notice any sparks, smoke, a burning or gas smell, or warmth from an outlet, panel or appliance?";

const DONE_REPLY = "This report has already been submitted. Your property manager will follow up with you.";
const CHAT_UNAVAILABLE_REPLY = "Sorry, I can't reply right now. Please try again in a minute; your report so far is saved.";

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
  const quiet = phase === "DONE" || phase === "EMERGENCY" || state.safety_check;
  if (state.chat) {
    // The model's tap options; text channels hear them in the reply.
    const options = quiet || phase === "AWAITING_MEDIA" ? [] : state.chat.options;
    state.ui = { options: req.channel === "web" ? options : [], notes: [] };
    return {
      reply: req.channel !== "web" && options.length ? `${reply}\n\n${options.map((o) => `- ${o}`).join("\n")}` : reply,
      options: state.ui.options,
      notes: [],
      phase,
      state,
      emergency: extra.emergency ? { kind: extra.emergency.kind, phrase: extra.emergency.phrase } : null,
      ticket: extra.ticket ?? {},
      done: extra.done ?? false,
    };
  }
  const hints =
    quiet
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
    answered: 0,
  };
  state.safety_check = null;
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

/** The chat's ticket fields, kept in `gathered` too (the app and the manager's page read it). */
function syncGathered(state: AssistantState): void {
  const t = state.chat!.ticket;
  state.gathered = {
    ...(state.gathered ?? buildInitialGathered()),
    category: t.category,
    location_in_unit: t.location,
    started_when: t.started,
    current_status: t.severity,
    equipment: t.equipment,
    brand_model: t.brand_model,
  };
}

function fromChat(req: TurnRequest, state: AssistantState, outcome: ChatOutcome): TurnResponse {
  syncGathered(state);
  const chat = state.chat!;
  const category = chat.ticket.category;
  const steps = chat.steps.map((description, i) => ({ step: i + 1, description, completed: false }));
  switch (outcome.kind) {
    case "reply":
      return respond(req, state, "GATHER_INFO", outcome.reply);
    case "photos":
      return respond(req, state, "AWAITING_MEDIA", outcome.reply);
    case "confirm":
      return respond(req, state, "CONFIRM_SUMMARY", outcome.reply, { ticket: { category, ...(steps.length ? { troubleshooting_steps: steps } : {}) } });
    case "submitted":
    case "escalated": {
      const escalated = outcome.kind === "escalated";
      state.summary = outcome.managerSummary;
      state.gathered.diagnosis = outcome.diagnosis;
      state.gathered.is_emergency ??= false;
      return respond(req, state, "DONE", outcome.reply, {
        done: true,
        ticket: {
          category,
          ...(outcome.steps.length ? { troubleshooting_steps: outcome.steps } : {}),
          priority: escalated || chat.urgency === "high" ? "high" : "medium",
          escalate: escalated,
          manager_summary: outcome.managerSummary,
          diagnosis: outcome.diagnosis,
          notify_manager: escalated ? "urgent" : "summary",
        },
      });
    }
  }
}

/** The first message: understand it and ask the first question (or escalate). */
async function open(
  req: TurnRequest,
  message: string,
  deps: Deps,
  emergency: EmergencyMatch | null,
  carry: Partial<AssistantState> = {}
): Promise<TurnResponse> {
  if (deps.chat) {
    const base: AssistantState = {
      v: 1,
      phase: "GATHER_INFO",
      ui: { options: [], notes: [] },
      description: message,
      gathered: buildInitialGathered(),
      current_question: null,
      ...carry,
    };
    if (emergency) return emergencyResponse(req, base, emergency);
    const { chat, frame } = await openChat(message);
    const state: AssistantState = { ...base, chat, issue_frame: frame };
    return fromChat(req, state, await chatTurn(state, { message, action: req.action, mediaCount: req.media.count, phase: "GATHER_INFO" }, deps.chat));
  }
  const ctx = deps.ctx;
  const opened = await openGather(message, ctx);
  const state: AssistantState = { v: 1, phase: "GATHER_INFO", ui: { options: [], notes: [] }, ...opened.state, ...carry };
  const danger = emergency ?? opened.emergency;
  if (danger) return emergencyResponse(req, state, danger);
  return respond(req, state, "GATHER_INFO", opened.reply);
}

export async function turn(req: TurnRequest, options: TurnOptions = {}): Promise<TurnResponse> {
  const ctx: GatherContext = {
    property: req.property,
    understander: options.understander === undefined ? openAIUnderstander() : options.understander,
  };
  const safety = options.safety === undefined ? openAISafetyModel() : options.safety;
  const message = req.message.trim();
  // A conversation keeps the mode it started in.
  const chatMode = req.state ? Boolean(req.state.chat) : (options.mode ?? (process.env.ASSISTANT_MODE === "chat" ? "chat" : "scripted")) === "chat";
  const model = chatMode ? (options.conversation === undefined ? openAIConversationModel() : options.conversation) : null;
  const deps: Deps = {
    ctx,
    safety,
    chat: model ? { property: req.property, model, search: options.search === undefined ? pineconeCardSearch() : options.search } : null,
  };

  // The first message.
  if (!req.state) {
    const gate = await checkSafety(message, "", safety);
    if (gate.kind === "check") {
      // Ask before anything else; the conversation starts once the answer clears it.
      const state: AssistantState = {
        v: 1,
        phase: "GATHER_INFO",
        ui: { options: [], notes: [] },
        description: message,
        gathered: buildInitialGathered(),
        current_question: null,
        safety_check: { ...gate.check, opening: true },
      };
      return respond(req, state, "GATHER_INFO", gate.check.question);
    }
    return open(req, message, deps, gate.kind === "emergency" ? gate.emergency : null);
  }

  const state: AssistantState = structuredClone(req.state);
  if (state.phase === "DONE") return respond(req, state, "DONE", DONE_REPLY, { done: true });
  if (state.phase === "EMERGENCY") {
    // The safety advice is given; collect what the manager needs, one question at a time.
    const answered = (state.emergency?.answered ?? 0) + (message ? 1 : 0);
    if (state.emergency) state.emergency.answered = answered;
    return respond(req, state, "EMERGENCY", buildEmergencyFollowUpReply(answered));
  }

  // The answer to the gate's confirming question.
  const pending = state.safety_check;
  if (pending) {
    state.safety_check = null;
    const answer = await readSafetyAnswer(pending.question, message, safety);
    const rationale = `${pending.kind} check: "${pending.phrase}"; answer: "${message.slice(0, 50)}"`;
    if (answer !== "no_concern") {
      state.safety_detection = { detected: true, method: answer === "concern" ? "user_confirmed" : "user_unclear", rationale };
      return emergencyResponse(req, state, { kind: pending.kind, phrase: pending.phrase });
    }
    const carry: Partial<AssistantState> = {
      safety_cleared: [...new Set([...(state.safety_cleared ?? []), pending.kind])],
      safety_detection: { detected: false, method: "user_denied", rationale },
    };
    if (pending.opening) return open(req, pending.held_message, { ...deps, ctx: { ...ctx, safetyCleared: true } }, null, carry);
    Object.assign(state, carry);
    return advance(req, state, pending.held_message, deps);
  }

  // Danger in any reply, in any phase, stops everything else.
  const gate = await checkSafety(message, `The tenant first reported: ${state.description}`, safety, state.safety_cleared ?? []);
  if (gate.kind === "emergency") return emergencyResponse(req, state, gate.emergency);
  if (gate.kind === "check") {
    state.safety_check = gate.check;
    return respond(req, state, state.phase, gate.check.question);
  }
  return advance(req, state, message, deps);
}

/** A message that passed the safety gate: the next step in the current phase. */
async function advance(req: TurnRequest, state: AssistantState, message: string, deps: Deps): Promise<TurnResponse> {
  const { ctx, safety } = deps;
  if (state.chat) {
    // Model-led: the model answers in every phase. Without one (no key), say so and keep the state.
    if (!deps.chat) return respond(req, state, state.phase, CHAT_UNAVAILABLE_REPLY);
    return fromChat(req, state, await chatTurn(state, { message, action: req.action, mediaCount: req.media.count, phase: state.phase }, deps.chat));
  }
  switch (state.phase) {
    case "GATHER_INFO": {
      // The old flow's own safety question ("sparks, burning smell…?"), read in any language.
      if (state.current_question === "safety_check") {
        const emergency = safetyAnswerEmergency(state, message, await readSafetyAnswer(SAFETY_QUESTION_TOPIC, message, safety));
        if (emergency) return emergencyResponse(req, state, emergency);
      }
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
    default:
      // DONE and EMERGENCY are answered before the gate.
      return respond(req, state, state.phase, DONE_REPLY, { done: state.phase === "DONE" });
  }
}
