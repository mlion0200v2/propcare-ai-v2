/**
 * The conversation model: one structured call per tenant message. It reads
 * the reference cards, the ticket so far and the chat, and returns the
 * reply (in the tenant's language), tap options, the whole ticket (in
 * English) and what happens next. Code around it decides safety, filters
 * the advice and builds the manager's report.
 */
import { z } from "zod";
import { zodResponseFormat } from "openai/helpers/zod";
import { GLOBAL_NEVER } from "@/assistant/cards";
import type { PropertyContext } from "@/assistant/property";
import { fixtureLabel } from "@/assistant/property";
import { TICKET_CATEGORIES, type ChatMessage, type TicketFields } from "./types";

export const ChatStepSchema = z.object({
  reply: z.string(),
  options: z.array(z.string()),
  ticket: z.object({
    issue: z.string().nullable(),
    location: z.string().nullable(),
    started: z.string().nullable(),
    severity: z.string().nullable(),
    equipment: z.string().nullable(),
    brand_model: z.string().nullable(),
    tried: z.array(z.string()),
    facts: z.array(z.string()),
    category: z.enum(TICKET_CATEGORIES),
  }),
  card: z.string(),
  cause: z.string(),
  confidence: z.enum(["high", "medium", "low"]),
  urgency: z.enum(["low", "medium", "high"]),
  steps_suggested: z.array(z.string()),
  ask_photos: z.boolean(),
  ready: z.boolean(),
  confirmed: z.boolean().nullable(),
  escalate: z.boolean(),
  escalate_reason: z.string(),
});
export type ChatStep = z.infer<typeof ChatStepSchema>;

export interface ChatInput {
  messages: ChatMessage[];
  ticket: TicketFields;
  /** Card texts (../cards cardText), best first; may be empty. */
  cards: string[];
  property: PropertyContext;
  steps: string[];
  mediaCount: number;
  askedPhotos: boolean;
  /** "chat" while gathering; "confirm" once the summary is shown. */
  phase: "chat" | "confirm";
  /** Set when the chat is long: finish now. */
  wrapUp: boolean;
  /** A previous draft told the tenant to do these: rewrite without them. */
  avoid?: string[];
}

export interface ConversationModel {
  next(input: ChatInput): Promise<ChatStep | null>;
}

export const CHAT_SYSTEM_PROMPT = [
  "You are the maintenance assistant for a residential property manager in British Columbia, Canada. A tenant is reporting a problem in their home by chat.",
  "Your job: understand what is really going on, keep the tenant safe, suggest only safe things a tenant may do, and collect what the property manager needs to send the right person, in as few messages as possible.",
  "",
  "How to talk:",
  "- Reply in the language of the tenant's latest message. Ticket fields are always in English.",
  "- Short, warm and plain. No headings, no long lists. At most one question per message.",
  "- Ask only what a tradesperson needs and you don't know yet (the cards list it). Never ask what the tenant already said. Aim to finish in 3 to 5 tenant messages.",
  "- options: 2 to 6 short tap answers in the tenant's language when the answers are predictable (a room, yes/no, a few kinds); [] for open questions.",
  "- Work out what it most likely is, and say so plainly with what makes you think so (a small hairy striped larva on a carpet is most likely a carpet beetle larva). Don't claim certainty.",
  "- Never mention parts, trades, costs or the ticket-only causes to the tenant.",
  "",
  "Reference cards:",
  "- They describe common problems. Use the one that fits (card = its key), switch when the tenant's answers point elsewhere, or use none (card = \"none\") and your own knowledge when none fits.",
  "- cause: the card's cause id that fits best, or \"none\".",
  "",
  "Safe steps:",
  "- Only steps from the card you use, or for a problem no card covers, simple low-risk ones (contain water with towels or a bucket, stop using it, keep the area dry, close a door, take a photo, keep food sealed).",
  "- Never tell the tenant to do anything on the never list. steps_suggested: the steps in this reply, in English.",
  "",
  "Photos: ask once (ask_photos = true, and say what to photograph) when a photo would help the tradesperson; not for noise-only problems or when photos are already added.",
  "",
  "Finishing:",
  "- When you know what, where, since when, how bad, and what was tried (or the tenant can't say), set ready = true and make the reply a short summary in the tenant's language that asks them to confirm.",
  "- escalate = true (with escalate_reason) when a card's 'stop and hand over' condition is met or the tenant can't contain the problem; the reply then tells them their manager is being alerted and what to do meanwhile.",
  "- Danger to people (gas, fire, sparks, flooding near electrics) is checked by a separate safety system before you. If the tenant now describes danger, escalate and tell them to keep away from it.",
  "- In the confirm step: confirmed = true when the tenant agrees; false when they correct something (update the ticket and show the corrected summary); null otherwise.",
  "",
  "Ticket (always the whole ticket, in English): issue (one line), location, started, severity (how bad now), equipment, brand_model, tried, facts, category.",
  "urgency: high when it is spreading, causing damage or leaves the home without an essential (water, heat, a working toilet, a lock); low for cosmetic or minor; else medium.",
].join("\n");

function homeText(p: PropertyContext): string {
  const lines = [
    p.rooms.length ? `Rooms: ${p.rooms.join(", ")}` : null,
    p.fixtures.length ? `Fixtures: ${p.fixtures.map((f) => `${fixtureLabel(f)}${f.room ? ` (${f.room})` : ""}`).join("; ")}` : null,
    p.water_shutoff ? `Water shut-off: ${p.water_shutoff}` : null,
    p.breaker_panel ? `Breaker panel: ${p.breaker_panel}` : null,
  ].filter(Boolean);
  return lines.length ? lines.join("\n") : "(no details on file)";
}

/** The user message the model reads: the home, the cards, the ticket, the chat. */
export function chatPrompt(input: ChatInput): string {
  const tenantMessages = input.messages.filter((m) => m.role === "tenant").length;
  return [
    "# The home",
    homeText(input.property),
    "",
    "# Reference cards",
    input.cards.length ? input.cards.join("\n\n") : "(none fit: use your own knowledge)",
    "",
    "# Never tell the tenant to",
    ...GLOBAL_NEVER.map((n) => `- ${n}`),
    "",
    "# Ticket so far",
    JSON.stringify(input.ticket),
    `Steps already suggested: ${input.steps.length ? input.steps.join(" | ") : "none"}`,
    `Photos: ${input.mediaCount} added${input.askedPhotos ? "; already asked for" : ""}`,
    `Step: ${input.phase === "confirm" ? "confirm (the summary was shown; read the tenant's answer)" : "chat"}`,
    `Tenant messages so far: ${tenantMessages}${input.wrapUp ? ". The chat is long: finish now (ready = true) with what you have." : ""}`,
    "",
    "# The chat",
    ...input.messages.map((m) => `${m.role === "tenant" ? "Tenant" : "Assistant"}: ${m.text}`),
    ...(input.avoid?.length ? ["", `Your previous draft told the tenant to: ${input.avoid.join("; ")}. That is not allowed. Rewrite the reply without it.`] : []),
  ].join("\n");
}

export interface ConversationModelOptions {
  model?: string;
  timeoutMs?: number;
  onUsage?: (usage: { model: string; prompt_tokens: number; completion_tokens: number }) => void;
}

/** Production conversation model (OpenAI). Null when no key is configured. */
export function openAIConversationModel(options: ConversationModelOptions = {}): ConversationModel | null {
  const key = process.env.OPENAI_API_KEY;
  if (!key || key.startsWith("placeholder")) return null;
  const model = options.model ?? process.env.CHAT_MODEL ?? "gpt-4o-mini";
  const timeoutMs = options.timeoutMs ?? Number(process.env.CHAT_TIMEOUT_MS ?? 20000);

  return {
    async next(input) {
      try {
        const { openai } = await import("@/assistant/openai");
        const completion = await openai.chat.completions.parse(
          {
            model,
            temperature: 0.3,
            messages: [
              { role: "system", content: CHAT_SYSTEM_PROMPT },
              { role: "user", content: chatPrompt(input) },
            ],
            response_format: zodResponseFormat(ChatStepSchema, "chat_step"),
          },
          { timeout: timeoutMs, maxRetries: 1 }
        );
        if (completion.usage) {
          options.onUsage?.({ model, prompt_tokens: completion.usage.prompt_tokens, completion_tokens: completion.usage.completion_tokens });
        }
        return completion.choices[0]?.message.parsed ?? null;
      } catch {
        return null;
      }
    },
  };
}
