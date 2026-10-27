/**
 * The model-led conversation, one tenant message at a time. The safety
 * gate has already passed the message (../turn.ts). Here:
 *
 *   find cards → the conversation model → the advice filter → what's next
 *   (another question, photos, the summary to confirm, submitted, escalated)
 *
 * The model writes the reply and the ticket fields; code decides the phase,
 * removes unsafe advice and writes the manager's report.
 */
import { cardByKey, cardText, findCards } from "@/assistant/cards";
import type { CardSearch } from "@/assistant/cards/search";
import type { PropertyContext } from "@/assistant/property";
import type { DiagnosisView } from "@/assistant/sops/diagnosis-view";
import { isUnsafeInstruction, toCelsius } from "@/assistant/triage/step-safety";
import type { TroubleshootingStep } from "@/assistant/triage/types";
import { understand, understandReply, type IssueFrame, type ModelUnderstander } from "@/assistant/understanding";
import type { ChatInput, ChatStep, ConversationModel } from "./model";
import { chatDiagnosis, chatManagerSummary } from "./report";
import { emptyTicket, type ChatState } from "./types";

export interface ChatContext {
  property: PropertyContext;
  understander: ModelUnderstander | null;
  model: ConversationModel;
  search: CardSearch | null;
}

/** The conversation fields this flow reads and writes. */
export interface ChatConversation {
  description: string;
  issue_frame?: IssueFrame;
  chat?: ChatState | null;
}

export type ChatOutcome =
  | { kind: "reply"; reply: string }
  | { kind: "photos"; reply: string }
  | { kind: "confirm"; reply: string }
  | { kind: "submitted" | "escalated"; reply: string; managerSummary: string; diagnosis: DiagnosisView; steps: TroubleshootingStep[]; reason?: string };

export const CHAT_SUBMITTED_REPLY = "Your report has been submitted. Your property manager has been notified and will follow up with you.";
const RETRY_REPLY = "Sorry, I didn't catch that. Could you tell me again, in a few words?";

/** Ask the model to finish once the chat is this long; force the summary after the hard cap. */
const WRAP_UP_AFTER = 7;
const HARD_CAP = 10;
/** Model failures in a row before the report is submitted with what we have. */
const MAX_FAILURES = 2;

/** Remove sentences that tell the tenant to do something unsafe; °F → °C. */
export function filterAdvice(text: string): { text: string; removed: string[] } {
  const removed: string[] = [];
  const lines = text.split("\n").map((line) => {
    const sentences = line.split(/(?<=[.!?。！？])\s+/);
    const kept = sentences.filter((s) => {
      const stripped = s.replace(/^\s*(\d+[.)]|[-*•])\s*/, "").trim();
      if (stripped && isUnsafeInstruction(stripped)) {
        removed.push(stripped);
        return false;
      }
      return true;
    });
    return toCelsius(kept.length === sentences.length ? line : kept.join(" "));
  });
  return { text: lines.join("\n").replace(/\n{3,}/g, "\n\n").trim(), removed };
}

/** Start a conversation: understand the first message and find its cards. */
export async function openChat(message: string, ctx: ChatContext): Promise<{ chat: ChatState; frame: IssueFrame }> {
  const [{ frame }, vector] = await Promise.all([understand(message, ctx.understander), ctx.search ? ctx.search(message) : Promise.resolve(null)]);
  const chat: ChatState = {
    messages: [],
    ticket: emptyTicket(),
    cards: [],
    card: null,
    cause: null,
    confidence: "low",
    urgency: "medium",
    steps: [],
    asked_photos: false,
    options: [],
    removed: [],
    ...(vector && Object.keys(vector).length ? { vector } : {}),
  };
  return { chat, frame };
}

function tenantText(chat: ChatState): string {
  return chat.messages.filter((m) => m.role === "tenant").map((m) => m.text).join(" ");
}

function steps(chat: ChatState): TroubleshootingStep[] {
  return chat.steps.map((description, i) => ({ step: i + 1, description, completed: false }));
}

function finish(conv: ChatConversation, chat: ChatState, kind: "submitted" | "escalated", reply: string, mediaCount: number, reason?: string): ChatOutcome {
  return {
    kind,
    reply,
    managerSummary: chatManagerSummary({ description: conv.description, chat, mediaCount, escalation: reason ?? null, timestamp: new Date().toISOString() }),
    diagnosis: chatDiagnosis(chat, mediaCount),
    steps: steps(chat),
    ...(reason ? { reason } : {}),
  };
}

/** Take the model's step into the state: the ticket, the card, the steps (filtered). */
function apply(chat: ChatState, step: ChatStep): void {
  chat.ticket = { ...step.ticket, tried: step.ticket.tried.slice(0, 10), facts: step.ticket.facts.slice(0, 10) };
  // Only cards it was shown; a cause only from that card.
  chat.card = chat.cards.includes(step.card) ? step.card : null;
  chat.cause = chat.card && step.cause !== "none" ? step.cause : null;
  chat.confidence = step.confidence;
  chat.urgency = step.urgency;
  const safeSteps = step.steps_suggested.map((s) => s.trim()).filter((s) => s && !isUnsafeInstruction(s));
  chat.steps = [...new Set([...chat.steps, ...safeSteps])].slice(0, 12);
  chat.options = step.options.map((o) => o.trim()).filter((o) => o && o.length <= 80 && !isUnsafeInstruction(o)).slice(0, 6);
}

/**
 * One tenant message (or button) in a model-led conversation. Mutates `conv`.
 *
 * @param phase the conversation's phase before this message
 */
export async function chatTurn(
  conv: ChatConversation,
  input: { message: string; action?: "skip_photos" | "photos_added" | "confirm_summary"; mediaCount: number; phase: string },
  ctx: ChatContext
): Promise<ChatOutcome> {
  const chat = conv.chat!;
  if (input.action === "confirm_summary") return finish(conv, chat, "submitted", CHAT_SUBMITTED_REPLY, input.mediaCount);

  const note =
    input.action === "skip_photos" ? "[Skipped adding photos]" : input.action === "photos_added" ? `[Added ${input.mediaCount} photo(s) or video(s)]` : null;
  const said = [input.message, note].filter(Boolean).join(" ");
  if (said) chat.messages.push({ role: "tenant", text: said });

  // What it is, from everything the tenant has said; the cards follow.
  // (The first message was understood when the chat opened.)
  if (input.message && chat.messages.length > 1) {
    conv.issue_frame = conv.issue_frame ? await understandReply(conv.issue_frame, input.message, null) : (await understand(input.message, null)).frame;
  }
  const found = conv.issue_frame ? findCards(conv.issue_frame, `${conv.description} ${tenantText(chat)}`, { vectorScores: chat.vector }).map((c) => c.card.key) : [];
  chat.cards = [...new Set([...(chat.card ? [chat.card] : []), ...found])].slice(0, 5);

  const tenantMessages = chat.messages.filter((m) => m.role === "tenant").length;
  const confirming = input.phase === "CONFIRM_SUMMARY";
  const request: ChatInput = {
    messages: chat.messages,
    ticket: chat.ticket,
    cards: chat.cards.map((k) => findCardText(k)).filter((t): t is string => Boolean(t)),
    property: ctx.property,
    steps: chat.steps,
    mediaCount: input.mediaCount,
    askedPhotos: chat.asked_photos,
    phase: confirming ? "confirm" : "chat",
    wrapUp: tenantMessages >= WRAP_UP_AFTER,
  };
  let step = await ctx.model.next(request);
  // An unsafe step can hide in a reply in any language: ask once for a rewrite without it.
  const unsafe = step?.steps_suggested.filter((s) => isUnsafeInstruction(s)) ?? [];
  if (step && unsafe.length) {
    chat.removed.push(...unsafe);
    step = (await ctx.model.next({ ...request, avoid: unsafe })) ?? step;
  }

  if (!step) {
    chat.failures = (chat.failures ?? 0) + 1;
    if (chat.failures >= MAX_FAILURES) return finish(conv, chat, "submitted", CHAT_SUBMITTED_REPLY, input.mediaCount);
    return { kind: confirming ? "confirm" : "reply", reply: RETRY_REPLY };
  }
  chat.failures = 0;

  apply(chat, step);
  // A photo request is shown alone with the upload buttons, never beside a question.
  const photos = !confirming && !step.ready && !step.escalate && Boolean(step.photo_request.trim()) && !chat.asked_photos && input.mediaCount === 0;
  const { text, removed } = filterAdvice(photos ? step.photo_request : step.reply);
  chat.removed.push(...removed);
  const reply = text || RETRY_REPLY;
  chat.messages.push({ role: "assistant", text: reply });

  if (step.escalate) {
    chat.urgency = "high";
    return finish(conv, chat, "escalated", reply, input.mediaCount, step.escalate_reason || "The assistant handed this over");
  }
  if (confirming && step.confirmed === true) return finish(conv, chat, "submitted", reply, input.mediaCount);
  if (confirming || step.ready || tenantMessages >= HARD_CAP) return { kind: "confirm", reply };
  if (photos) {
    chat.asked_photos = true;
    return { kind: "photos", reply };
  }
  return { kind: "reply", reply };
}

function findCardText(key: string): string | null {
  const card = cardByKey(key);
  return card ? cardText(card) : null;
}
