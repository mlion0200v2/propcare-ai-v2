/**
 * The conversation model: one structured answer per tenant message, after
 * any card searches it makes (search_cards). It follows a numbered routine
 * (CHAT_SYSTEM_PROMPT), reads the cards, the ticket so far and the chat, and returns the
 * reply (in the tenant's language), tap options, the whole ticket (in
 * English) and what happens next. Code around it decides safety, filters
 * the advice and builds the manager's report.
 */
import { z } from "zod";
import { zodFunction, zodResponseFormat } from "openai/helpers/zod";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
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
  photo_request: z.string(),
  ready: z.boolean(),
  confirmed: z.boolean().nullable(),
  escalate: z.boolean(),
  escalate_reason: z.string(),
});
export type ChatStep = z.infer<typeof ChatStepSchema>;

export interface ChatInput {
  messages: ChatMessage[];
  ticket: TicketFields;
  /** Cards the model found in earlier messages (../cards cardText), the one in use first; may be empty. */
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

/** What the model may call while it works out a reply. */
export interface ChatTools {
  /** Reference cards (cardText) closest to an English description; [] when none fits. */
  searchCards(query: string): Promise<string[]>;
}

export interface ConversationModel {
  next(input: ChatInput, tools?: ChatTools): Promise<ChatStep | null>;
}

export const CHAT_SYSTEM_PROMPT = [
  "You are the maintenance assistant for a residential property manager in British Columbia, Canada. A tenant is reporting a problem in their home by chat.",
  "Your job: find out what is really going on, keep the tenant safe, suggest only safe things a tenant may do, and collect what the property manager needs to send the right person, in as few messages as possible.",
  "",
  "# Routine",
  "Before you reply: once you know what kind of problem it is (and again whenever that changes), call search_cards with a short English description (\"carpet beetle larvae in bedroom\", \"kitchen sink leaks under the cabinet\"). Don't search on a room or a vague word alone.",
  "Then go through these steps in order and do the FIRST one that applies. One step per reply.",
  "",
  "1. Confirming. If Step is confirm, the summary was shown: the tenant agrees → confirmed = true and a short thanks. They correct something → update the ticket, confirmed = false, and show the corrected summary asking again. Anything else → confirmed = null, answer briefly and ask them to confirm.",
  "2. Danger. The tenant now describes danger to people (gas, smoke or fire, sparks, water near electrics, sewage coming up) → escalate = true; the reply tells them to keep away from it and that their manager is being alerted.",
  "3. Something to show. The tenant says they have or found something they can show (\"here's what I found\", \"I took a picture\", \"I have one here\") and no photos are added or asked for yet → photo_request: what to photograph.",
  "4. Hand over. A card's 'Stop and hand over' condition is met, or the tenant can't contain the problem → escalate = true with escalate_reason; the reply says their manager is being alerted and what to do meanwhile.",
  "5. What is it. You can't yet say what kind of problem it is → ask the one question that tells it apart (for an unknown bug: what it looks like, its size and colour, where exactly; for a leak: where the water comes from). Give options when the answers are predictable.",
  "6. Photo. A photo would help the tradesperson (not for noises or smells), none is added and you haven't asked → photo_request: what to photograph.",
  "7. Missing facts. Ask for the first one still missing, in this order: exactly where (room, which fixture), since when, how bad now (spreading, how much), what they tried. Use the card's questions. Skip what the tenant already said, can't know or answered \"don't know\".",
  "8. Summary. Nothing is missing, or the chat is long → ready = true; the reply is a short summary in the tenant's language asking them to confirm.",
  "",
  "With any step: when there is a safe step the tenant hasn't done that limits damage now (contain the water, stop using it), add it in one sentence.",
  "",
  "# Edge cases",
  "- The tenant asks a question: answer it briefly and safely, then do the routine.",
  "- \"I don't know\" or \"I can't check\": record that, never ask it again.",
  "- More than one problem: handle the main one; put the others in facts.",
  "- Not a repair (rent, neighbours, noise from people, parking): say you can only take maintenance reports and they should contact their property manager; options [].",
  "- Already fixed or gone: record it, then go to the summary.",
  "- Photos skipped: never ask for photos again.",
  "",
  "# How to write",
  "- Reply in the language of the tenant's latest message. Ticket fields are always in English.",
  "- Short, warm and plain. No headings, no lists. At most one question per message.",
  "- options: 2 to 6 short tap answers in the tenant's language when the answers are predictable (a room, yes/no, a few kinds); [] for open questions.",
  "- Say what it most likely is only when the tenant's own words support it, with what makes you think so (a small hairy striped larva on a carpet is most likely a carpet beetle larva). Don't claim certainty.",
  "- Never mention parts, trades, costs or the ticket-only causes to the tenant.",
  "- photo_request is shown with upload and skip buttons instead of reply, so it says only what to photograph (it may start with what you think it is). Otherwise photo_request = \"\".",
  "",
  "# Cards",
  "- search_cards returns the closest reference cards. They may not fit: use one only when the tenant's words match it (card = its key), switch when the answers point elsewhere, or use none (card = \"none\") and your own knowledge.",
  "- cause: the card's cause id that fits best, or \"none\".",
  "- Safe steps: only from the card you use, or for a problem no card covers, simple low-risk ones (contain water with towels or a bucket, stop using it, keep the area dry, close a door, keep food sealed). Never anything on a never list. steps_suggested: the steps in this reply, in English.",
  "",
  "# Ticket and urgency",
  "- Always return the whole ticket, in English: issue (one line), location, started, severity (how bad now), equipment, brand_model, tried, facts, category.",
  "- urgency: high when it is spreading, causing damage or leaves the home without an essential (water, heat, a working toilet, a lock); low for cosmetic or minor; else medium.",
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
    "# Reference cards found so far",
    input.cards.length ? input.cards.join("\n\n") : "(none yet: call search_cards once you know what kind of problem it is)",
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

/** Searches per tenant message; after that the model must answer. */
const MAX_SEARCHES = 2;
const NO_CARD = 'No card fits. Use your own knowledge (card = "none").';

const SEARCH_CARDS_TOOL = zodFunction({
  name: "search_cards",
  description: "Find the reference cards closest to a problem. Call once you know what kind of problem it is, with a short English description.",
  parameters: z.object({ query: z.string().describe('e.g. "carpet beetle larvae in bedroom", "kitchen sink leaks under the cabinet"') }),
});

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
    async next(input, tools) {
      try {
        const { openai } = await import("@/assistant/openai");
        const messages: ChatCompletionMessageParam[] = [
          { role: "system", content: CHAT_SYSTEM_PROMPT },
          { role: "user", content: chatPrompt(input) },
        ];
        // The model may search for cards (up to MAX_SEARCHES), then it answers.
        let searches = 0;
        for (;;) {
          const canSearch = Boolean(tools) && searches < MAX_SEARCHES;
          const completion = await openai.chat.completions.parse(
            {
              model,
              temperature: 0.3,
              messages,
              response_format: zodResponseFormat(ChatStepSchema, "chat_step"),
              ...(canSearch ? { tools: [SEARCH_CARDS_TOOL] } : {}),
            },
            { timeout: timeoutMs, maxRetries: 1 }
          );
          if (completion.usage) {
            options.onUsage?.({ model, prompt_tokens: completion.usage.prompt_tokens, completion_tokens: completion.usage.completion_tokens });
          }
          const message = completion.choices[0]?.message;
          const calls = message?.tool_calls ?? [];
          if (!message || !calls.length || !canSearch) return message?.parsed ?? null;

          messages.push({ role: "assistant", content: message.content, tool_calls: calls });
          for (const call of calls) {
            searches++;
            const query = call.type === "function" && call.function.name === "search_cards" ? (call.function.parsed_arguments as { query?: string } | null)?.query : undefined;
            const cards = query ? await tools!.searchCards(query) : [];
            messages.push({ role: "tool", tool_call_id: call.id, content: cards.length ? cards.join("\n\n") : NO_CARD });
          }
        }
      } catch {
        return null;
      }
    },
  };
}
