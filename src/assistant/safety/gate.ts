/**
 * The safety gate: runs on every tenant message before anything else.
 *
 * Two readers, combined so the result is never less safe than the keyword
 * rules alone:
 *   - the keyword rules (../triage/emergency.ts): fast, deterministic, can't
 *     be talked out of an emergency;
 *   - a model check that reads any language and context. It catches danger
 *     no keyword names ("the outlet is warm and the plate is brown") and, for
 *     smell-only matches, can ask one confirming question instead of raising
 *     an alarm ("rotten-egg smell only from the hot water").
 *
 * When the model is unavailable or fails, the keyword rules decide alone,
 * exactly as before. Answers to a safety question are read the same way:
 * keywords first, then the model, and anything not a clear "no" escalates.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { zodResponseFormat } from "openai/helpers/zod";
import { classifySafetyAnswer, detectEmergency, isHedgedAnswer, type EmergencyKind, type EmergencyMatch, type SafetyAnswer } from "../triage/emergency";

const MODEL_KINDS = ["gas", "carbon_monoxide", "fire", "electrical", "water_electrical", "sewage", "flooding", "no_heat", "structural"] as const;

export const SafetyReadingSchema = z.object({
  /** emergency: danger now. check: danger is possible but unclear, ask one question. none: no sign of danger. */
  level: z.enum(["emergency", "check", "none"]),
  kind: z.enum([...MODEL_KINDS, "none"]),
  /** The tenant's words that show the danger ("" for none). */
  phrase: z.string(),
  /** For check: one short question, in the tenant's language, that tells danger from no danger ("" otherwise). */
  question: z.string(),
});
export type SafetyReading = z.infer<typeof SafetyReadingSchema>;

export const SafetyAnswerReadingSchema = z.object({
  answer: z.enum(["concern", "no_concern", "unclear"]),
});

/** The model side of the gate. Null result = unavailable; the keywords decide. */
export interface SafetyModel {
  read(message: string, context: string): Promise<SafetyReading | null>;
  readAnswer(question: string, answer: string): Promise<SafetyAnswer | null>;
}

/** A confirming question waiting for the tenant's answer. Stored in the conversation state. */
export interface PendingSafetyCheck {
  kind: EmergencyKind;
  phrase: string;
  question: string;
  /** The message that raised the check; handled normally once the answer clears it. */
  held_message: string;
  /** It was the first message: the conversation starts once the check clears. */
  opening?: boolean;
}

export type GateResult =
  | { kind: "emergency"; emergency: EmergencyMatch }
  | { kind: "check"; check: PendingSafetyCheck }
  | { kind: "clear" };

/**
 * Keyword matches that rest on a smell alone. Only these can be turned into a
 * confirming question; sparks, alarms, flooding, sewage and the rest always escalate.
 */
const SMELL_ONLY = /\b(rotten\s+eggs?|sulph?ur|smell\w*|odou?r|scent|whiff)\b/;
const EXPLICIT_DANGER = /\b(leak\w*|hiss\w*|fire|flames?|smok\w*|sparks?)\b/;

function smellOnly(match: EmergencyMatch): boolean {
  return (match.kind === "gas" || match.kind === "fire") && SMELL_ONLY.test(match.phrase) && !EXPLICIT_DANGER.test(match.phrase);
}

/** Asked when the model says "check" without a question of its own, or isn't available to word one. */
const CONFIRM_QUESTION: Partial<Record<EmergencyKind, string>> = {
  gas: "Just to be safe: do you smell gas or rotten eggs in the air, especially near the stove, furnace or water heater, and not only from the water?",
  fire: "Just to be safe: is there any smoke, or is the burning smell getting stronger or coming from an outlet, switch or wiring?",
};
const GENERIC_CONFIRM = "Just to be safe: do you notice any sparks, smoke, a burning or gas smell, or warmth coming from an outlet or panel?";

/**
 * Decide what a tenant message means for safety.
 *
 * @param context what we know so far (the first message, the current question), for the model
 * @param cleared dangers the tenant already said aren't there; a smell-only match of one isn't asked again
 */
export async function checkSafety(
  message: string,
  context: string,
  model: SafetyModel | null,
  cleared: EmergencyKind[] = [],
  now?: Date
): Promise<GateResult> {
  if (!message.trim()) return { kind: "clear" };
  const keywords = detectEmergency(message, now);
  const reading = model ? await model.read(message, context) : null;

  if (keywords) {
    if (reading?.level !== "emergency" && smellOnly(keywords) && cleared.includes(keywords.kind)) return { kind: "clear" };
    // The model can only soften a smell-only match, and only to a question.
    if (reading && reading.level !== "emergency" && smellOnly(keywords)) {
      const question = (reading.level === "check" && reading.question.trim()) || CONFIRM_QUESTION[keywords.kind] || GENERIC_CONFIRM;
      return { kind: "check", check: { kind: keywords.kind, phrase: keywords.phrase, question, held_message: message } };
    }
    return { kind: "emergency", emergency: keywords };
  }

  if (!reading || reading.level === "none" || reading.kind === "none") return { kind: "clear" };
  const phrase = reading.phrase.trim() || message.slice(0, 120);
  if (reading.level === "emergency") return { kind: "emergency", emergency: { kind: reading.kind, phrase } };
  if (cleared.includes(reading.kind)) return { kind: "clear" };
  const question = reading.question.trim() || CONFIRM_QUESTION[reading.kind] || GENERIC_CONFIRM;
  return { kind: "check", check: { kind: reading.kind, phrase, question, held_message: message } };
}

/**
 * Read an answer to a safety question. Keywords first (danger words, a clean
 * "no"); the model reads the rest, in any language. Unclear is never cleared.
 */
export async function readSafetyAnswer(question: string, answer: string, model: SafetyModel | null, now?: Date): Promise<SafetyAnswer> {
  const byKeywords = classifySafetyAnswer(answer, now);
  if (byKeywords !== "unclear" || !model || isHedgedAnswer(answer)) return byKeywords;
  return (await model.readAnswer(question, answer)) ?? "unclear";
}

// ── The OpenAI model ──

export const SAFETY_SYSTEM_PROMPT = [
  "You check a tenant's message to their property manager's maintenance assistant for danger to people. Messages may be in any language.",
  "level:",
  "- emergency: the message describes danger now: gas smell or hissing gas, carbon monoxide alarm sounding, smoke or fire, sparks, a burning smell from wiring, an outlet, switch or panel that is hot, warm, scorched, melted, buzzing or discoloured, electric shock, water on or near electrics, sewage backing up, water pouring or spreading fast, a ceiling or structure falling, no heat in freezing weather.",
  "- check: danger is possible but the message points to a likely harmless cause or is unclear. Examples: a rotten-egg smell only from the hot water tap (often bacteria in the tank, but could be gas near a gas water heater); a dusty burning smell when a heater is switched on for the first time in the season; a faint smell they can't place. Write one short question in the tenant's language that tells the two apart.",
  "- none: no sign of danger to people (a broken appliance, a slow drain, pests, noise, a chirping smoke alarm battery, a dripping tap).",
  "kind: the danger type, or none. phrase: the tenant's words that show it (\"\" for none). question: only for check, else \"\".",
  "Do not raise a check for ordinary repairs just because they involve electricity or water. When unsure between emergency and check, choose emergency.",
].join("\n");

export const SAFETY_ANSWER_PROMPT = [
  "The tenant was asked a safety question by their maintenance assistant and answered, possibly in another language.",
  "answer: no_concern only when the answer clearly says there is no sign of the danger asked about (\"non\", \"没有\", \"nothing like that\").",
  "concern when it says there is, or describes anything dangerous. unclear when it is hedged, unsure, off-topic or both.",
].join("\n");

export interface SafetyModelOptions {
  model?: string;
  timeoutMs?: number;
  onUsage?: (usage: { model: string; prompt_tokens: number; completion_tokens: number }) => void;
  noCache?: boolean;
}

const cache = new Map<string, Promise<unknown>>();
const MAX_CACHE = 500;

/** Production safety model (OpenAI). Null when no key is configured. */
export function openAISafetyModel(options: SafetyModelOptions = {}): SafetyModel | null {
  const key = process.env.OPENAI_API_KEY;
  if (!key || key.startsWith("placeholder")) return null;
  const model = options.model ?? process.env.SAFETY_MODEL ?? "gpt-4o-mini";
  const timeoutMs = options.timeoutMs ?? Number(process.env.SAFETY_TIMEOUT_MS ?? 5000);

  async function call<T>(name: string, schema: z.ZodType<T>, system: string, user: string): Promise<T | null> {
    const k = createHash("sha256").update(`${name}\u0000${user}`).digest("hex");
    const hit = options.noCache ? undefined : (cache.get(k) as Promise<T | null> | undefined);
    if (hit) return hit;
    const pending = (async () => {
      try {
        const { openai } = await import("@/assistant/openai");
        const completion = await openai.chat.completions.parse(
          {
            model,
            temperature: 0,
            messages: [
              { role: "system", content: system },
              { role: "user", content: user.slice(0, 2000) },
            ],
            response_format: zodResponseFormat(schema, name),
          },
          { timeout: timeoutMs, maxRetries: 0 }
        );
        if (completion.usage) {
          options.onUsage?.({ model, prompt_tokens: completion.usage.prompt_tokens, completion_tokens: completion.usage.completion_tokens });
        }
        return (completion.choices[0]?.message.parsed as T | undefined) ?? null;
      } catch {
        return null;
      }
    })();
    if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value as string);
    cache.set(k, pending);
    const result = await pending;
    if (result === null) cache.delete(k); // don't cache failures
    return result;
  }

  return {
    read: (message, context) =>
      call("safety_reading", SafetyReadingSchema, SAFETY_SYSTEM_PROMPT, `${context ? `Context: ${context}\n\n` : ""}Tenant: ${message}`),
    readAnswer: async (question, answer) =>
      (await call("safety_answer", SafetyAnswerReadingSchema, SAFETY_ANSWER_PROMPT, `Question: ${question}\nAnswer: ${answer}`))?.answer ?? null,
  };
}
