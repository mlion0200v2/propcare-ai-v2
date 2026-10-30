/**
 * One PropCare chat with a simulated tenant, through turn() as the web chat
 * runs it, recorded for the code checks (../cases/checks.ts) and the judges.
 * Shared by the case eval and the head-to-head.
 */
import { z } from "zod";
import { openAIUnderstander } from "../../../src/assistant/understanding";
import { openAISafetyModel } from "../../../src/assistant/safety/gate";
import { openAIConversationModel } from "../../../src/assistant/chat/model";
import { pineconeCardSearch } from "../../../src/assistant/cards/search";
import { emergencyNotice, EMERGENCY_QUESTIONS } from "../../../src/assistant/triage/emergency";
import { diagnosisText } from "../../../src/assistant/sops/diagnosis-view";
import type { TicketFields } from "../../../src/assistant/chat/types";
import type { TurnResponse } from "../../../src/assistant";
import { newChat, say } from "../drive";
import type { StructuredCall } from "./llm";
import { TENANT_SYSTEM } from "./simulate";

export const ROOMS = ["Kitchen", "Main bathroom (hallway)", "Ensuite", "Master bedroom", "Bedroom", "Living room", "Laundry closet"];
const MAX_TURNS = 12;

export interface Turn {
  bot: string;
  options?: string[];
  /** The tenant's answer to this reply ("[sends a photo]" for an upload). */
  tenant?: string;
  /** The phase after this reply. */
  phase?: string;
  /** This reply asked the safety gate's confirming question. */
  safetyQuestion?: boolean;
  /** This reply escalated: an emergency, or the manager alerted urgently. */
  escalated?: boolean;
}

export interface Transcript {
  turns: Turn[];
  /** What the manager receives (summary + diagnosis), when the side produces one. */
  ticket: string | null;
  end: string;
  /** The model's card searches and the card it ended on (chat mode). */
  searches?: string[];
  card?: string | null;
  /** Filled for PropCare runs: what the checks read. */
  emergency?: boolean;
  escalated?: boolean;
  fields?: TicketFields | null;
  category?: string | null;
  urgency?: string | null;
  /** The chat ended (done, or an emergency with its questions answered) before the turn limit. */
  finished?: boolean;
}

const TenantReply = z.object({ reply: z.string() });

export async function tenantSays(call: StructuredCall, brief: string, first: string, turns: Turn[]): Promise<string> {
  const history = [`You: ${first}`, ...turns.flatMap((t) => [`Assistant: ${t.bot}`, ...(t.tenant ? [`You: ${t.tenant}`] : [])])].join("\n");
  const options = turns.at(-1)?.options ?? [];
  const { reply } = await call({
    purpose: "tenant",
    system: TENANT_SYSTEM,
    user: `${brief}\n\nConversation so far:\n${history}\nTap options: ${options.join(" | ") || "(none)"}\n\nYour reply:`,
    schema: TenantReply,
    name: "tenant_reply",
  });
  return reply;
}

const CONFIRMS = /\b(yes|yeah|yep|looks good|correct|submit|right|ok|okay|oui|d'accord|exact|对|是|好|没错)\b|对|是的|没错|好的/i;

/**
 * PropCare: the whole flow through turn(). With `photos`, the tenant uploads
 * one when asked (as the app's upload does); otherwise they skip.
 */
export async function runOurs(first: string, brief: string, call: StructuredCall, options: { mode: "chat" | "scripted"; photos: boolean }): Promise<Transcript> {
  const chat = newChat({
    rooms: ROOMS,
    understander: openAIUnderstander({ noCache: true }),
    safety: openAISafetyModel({ noCache: true }),
    mode: options.mode,
    conversation: options.mode === "chat" ? openAIConversationModel() : null,
    search: options.mode === "chat" ? pineconeCardSearch() : null,
  });
  let r: TurnResponse = await say(chat, first);
  const turns: Turn[] = [];
  let ticket: string | null = null;
  let emergency = false;
  let escalated = false;
  let finished = false;
  for (let i = 0; i < MAX_TURNS; i++) {
    // The app adds the notice (with the manager's first question) to the safety advice.
    const urgent = Boolean(r.ticket.escalate || r.ticket.notify_manager === "urgent" || r.emergency);
    turns.push({ bot: r.emergency ? `${r.reply}\n\n${emergencyNotice(true)}` : r.reply, options: r.options, phase: r.phase, safetyQuestion: Boolean(r.state.safety_check), escalated: urgent });
    if (r.emergency) emergency = true;
    if (urgent) escalated = true;
    if (r.ticket.manager_summary) ticket = [r.ticket.manager_summary, r.ticket.diagnosis ? diagnosisText(r.ticket.diagnosis) : ""].filter(Boolean).join("\n\n");
    // After an emergency the tenant answers the manager's questions, then the chat ends.
    if (r.done || (r.phase === "EMERGENCY" && (chat.state?.emergency?.answered ?? 0) >= EMERGENCY_QUESTIONS.length)) {
      finished = true;
      break;
    }
    if (r.phase === "AWAITING_MEDIA") {
      if (options.photos && /You have a photo/.test(brief)) {
        turns.at(-1)!.tenant = "[sends a photo]";
        chat.media += 1;
        r = await say(chat, "", "photos_added");
      } else {
        const t = await tenantSays(call, brief, first, turns);
        turns.at(-1)!.tenant = t;
        r = await say(chat, t, "skip_photos");
      }
      continue;
    }
    const t = await tenantSays(call, brief, first, turns);
    turns.at(-1)!.tenant = t;
    r = await say(chat, t, r.phase === "CONFIRM_SUMMARY" && CONFIRMS.test(t) ? "confirm_summary" : undefined);
  }
  const c = chat.state?.chat;
  return {
    turns,
    ticket,
    end: r.phase,
    searches: c?.searches ?? [],
    card: c?.card ?? null,
    emergency,
    escalated,
    fields: c?.ticket ?? null,
    category: c?.ticket.category ?? r.ticket.category ?? null,
    urgency: c?.urgency ?? null,
    finished,
  };
}

export function render(t: Transcript, first: string): string {
  const lines = [`Tenant: ${first}`, ...t.turns.flatMap((x) => [`Assistant: ${x.bot}${x.options?.length ? `\n  [options: ${x.options.join(" | ")}]` : ""}`, ...(x.tenant ? [`Tenant: ${x.tenant}`] : [])])];
  return lines.join("\n");
}
