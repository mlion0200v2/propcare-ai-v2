/**
 * Live conversations: the model plays the tenant from a hidden card and
 * answers whatever the chat asks; a judge model scores the transcript.
 * The chat side is the real conversation module (with the model
 * understander when given), so what is scored is what tenants get.
 */
import { z } from "zod";
import * as conversation from "../../../src/lib/triage/conversation";
import { buildChatHints } from "../../../src/lib/triage/hints";
import { readUnitProfile } from "../../../src/lib/units/profile";
import type { ModelUnderstander } from "../../../src/lib/understanding";
import type { TriageClassification } from "../../../src/lib/triage/types";
import type { CorpusCase } from "../frame-eval";
import type { StructuredCall } from "./llm";

const ROOMS = ["Kitchen", "Main bathroom (hallway)", "Laundry closet", "Bedroom", "Living room"];

export interface LiveTurn {
  question: string | null;
  bot: string;
  options: string[];
  tenant?: string;
  /** What the chat understood when it asked. */
  known?: { equipment: string; substance: string; room: string };
}

export interface LiveTranscript {
  id: string;
  first: string;
  turns: LiveTurn[];
  sop: string | null;
  emergency: string | null;
  cause: string | null;
}

const TenantReply = z.object({ reply: z.string() });

export const TENANT_SYSTEM = [
  "You are a tenant chatting with your landlord's maintenance assistant about a problem at home.",
  "A hidden card says what is really going on. Answer the assistant's latest question in one short message, the way a real tenant texts.",
  "If one of the tap options fits, reply with its exact text. If the card doesn't say, make up a plausible detail that fits the card and stick to it; say 'not sure' only when a tenant really wouldn't know.",
  "Never mention the card. Keep the language of your first message (English, Chinese or French).",
].join("\n");

function tenantCard(c: CorpusCase): string {
  const e = c.expected;
  return [
    `First message you sent: "${c.message}"`,
    `What it is: ${e.equipment.replace(/_/g, " ")}; problem: ${e.symptom.replace(/_/g, " ")}; what's leaking/smelled: ${e.substance}; room: ${e.room.replace(/_/g, " ")}.`,
    c.emergency ? "It is dangerous right now (say so if asked about safety)." : "It is not dangerous: no sparks, no burning smell, no gas, water is not near anything electrical.",
  ].join("\n");
}

export async function simulateConversation(
  c: CorpusCase,
  call: StructuredCall,
  understander: ModelUnderstander | null,
  maxTurns = 12
): Promise<LiveTranscript> {
  const open = await conversation.openConversation(c.message, { rooms: ROOMS, understander });
  const stored: TriageClassification = open.triageClassification;
  const t: LiveTranscript = { id: c.id, first: c.message, turns: [], sop: null, emergency: open.emergency?.kind ?? null, cause: null };
  let question = stored.current_question;
  let bot = open.reply;
  const card = tenantCard(c);
  for (let i = 0; i < maxTurns && !t.emergency; i++) {
    const options = question
      ? buildChatHints({ currentQuestion: question, triageState: "GATHER_INFO", category: stored.gathered?.category ?? null, description: c.message, profile: readUnitProfile({ rooms: ROOMS }), gathered: stored.gathered }).quickReplies
      : [];
    const f = stored.issue_frame;
    const turn: LiveTurn = { question, bot, options, known: f ? { equipment: f.equipment, substance: f.substance, room: f.room } : undefined };
    t.turns.push(turn);
    if (!question) break;
    const history = t.turns.map((x) => `Assistant: ${x.bot}${x.tenant ? `\nYou: ${x.tenant}` : ""}`).join("\n");
    const { reply } = await call({
      purpose: "tenant",
      system: TENANT_SYSTEM,
      user: `${card}\n\nConversation so far:\n${history}\nTap options: ${options.join(" | ") || "(none)"}\n\nYour reply:`,
      schema: TenantReply,
      name: "tenant_reply",
    });
    turn.tenant = reply;
    const emergency = conversation.turnEmergency(reply, "GATHER_INFO", stored);
    if (emergency) {
      t.emergency = emergency.kind;
      break;
    }
    await conversation.updateIssueFrame(stored, c.message, reply, understander);
    const step = conversation.advanceGather({ stored, description: c.message, triageState: "GATHER_INFO", message: reply });
    stored.gathered = step.gathered;
    if (step.kind === "emergency") {
      t.emergency = step.emergency.kind;
      break;
    }
    if (step.kind === "ask") {
      question = step.nextQuestion || null;
      bot = step.reply;
      stored.current_question = question;
      continue;
    }
    const next = conversation.afterGather(step.gathered, c.message, stored);
    if (next.kind === "emergency") {
      t.emergency = next.emergency.kind;
      break;
    }
    if (next.kind === "safety_question") {
      question = "safety_check";
      bot = next.question;
      stored.current_question = question;
      continue;
    }
    t.turns.push({ question: null, bot: "(on to photos)", options: [] });
    break;
  }
  t.sop = stored.gathered?.sop?.issue_key ?? null;
  t.cause = stored.gathered?.sop?.cause?.label ?? null;
  return t;
}

export const JudgeVerdict = z.object({
  understood: z.number().int().min(1).max(5).describe("Did the assistant understand what the problem is (equipment, what's wrong, what's leaking)?"),
  relevance: z.number().int().min(1).max(5).describe("Were the questions relevant to this problem?"),
  irrelevant_questions: z.array(z.string()).describe("Questions that make no sense for this problem (e.g. 'where is the water?' for a grease drip)."),
  reasked_questions: z.array(z.string()).describe("Questions about something the tenant had already said."),
  safety_ok: z.boolean().describe("Was danger handled correctly (escalated when dangerous, not alarmed when safe)?"),
  efficiency: z.number().int().min(1).max(5).describe("Was it short enough: no padding, no needless questions?"),
  overall: z.number().int().min(1).max(5),
  notes: z.string(),
});
export type Verdict = z.infer<typeof JudgeVerdict>;

export const JUDGE_SYSTEM = [
  "You review a maintenance-intake chat between a tenant and an assistant for a property manager.",
  "Score it against the rubric. A good intake understands the problem from the first message (typos, slang, Chinese and French included),",
  "asks only questions that help a technician or the tenant's safety, never asks again what the tenant already said,",
  "escalates real danger (gas, fire, sparks, CO alarm, water near electrics, flooding, no heat in freezing weather) and nothing else.",
  "List irrelevant and re-asked questions verbatim. Be strict but fair.",
].join("\n");

export async function judge(t: LiveTranscript, c: CorpusCase, call: StructuredCall): Promise<Verdict> {
  const transcript = [`Tenant: ${t.first}`, ...t.turns.flatMap((x) => [`Assistant: ${x.bot}`, ...(x.tenant ? [`Tenant: ${x.tenant}`] : [])])].join("\n");
  return call({
    purpose: "judge",
    system: JUDGE_SYSTEM,
    user: `What was really going on: ${c.expected.equipment} / ${c.expected.symptom} / ${c.expected.substance}; dangerous: ${c.emergency ? "yes" : "no"}.\nEscalated by the assistant: ${t.emergency ?? "no"}.\n\nChat:\n${transcript}`,
    schema: JudgeVerdict,
    name: "judge_verdict",
  });
}
