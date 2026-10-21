/**
 * Model understanding: one structured call returning an IssueFrame.
 *
 * Strict schema (zod → JSON schema), controlled values from the taxonomy,
 * any language in, English facts out. Cached by message hash and time-boxed;
 * any failure returns null and the rules frame is used instead.
 */
import { createHash } from "node:crypto";
import { zodResponseFormat } from "openai/helpers/zod";
import { IssueFrameSchema, withUnknowns, type IssueFrame } from "./frame";
import { EQUIPMENT, SYMPTOMS, SUBSTANCES, ROOMS, ONSETS, STATUSES } from "./taxonomy";

export type ModelUnderstander = (message: string, context?: string) => Promise<IssueFrame | null>;

export const UNDERSTANDING_SYSTEM_PROMPT = [
  "You read a tenant's message about a problem in their rental home and fill in an issue frame.",
  "Use ONLY these values (use \"unknown\" when the tenant hasn't said or it can't be inferred safely):",
  `equipment: ${EQUIPMENT.join(", ")}`,
  `symptom: ${SYMPTOMS.join(", ")}`,
  `substance (what is leaking, smelled or seen): ${SUBSTANCES.join(", ")}`,
  `room: ${ROOMS.join(", ")}`,
  `onset: ${ONSETS.join(", ")}`,
  `status: ${STATUSES.join(", ")}`,
  "Rules:",
  "- Messages may have typos, slang, Chinese or French. 'rangehood leaking gease' = range_hood, leaking, grease.",
  "- A range hood or stove leaks grease or oil, not water, unless the tenant says water.",
  "- 'sink' alone is 'sink'; use kitchen_sink or bathroom_sink only if the room is said.",
  "- Don't guess onset or status: unknown unless stated.",
  "- severity: emergency for gas smell, smoke or fire, sparks, CO alarm sounding, water on electrical, sewage backup, flooding; high for no heat, leaks that are spreading; low for noise or a chirping alarm; else medium.",
  "- facts: up to 5 short English facts the tenant stated (what they tried, what they noticed).",
  "- confidence: 0 to 1 per field; unknowns: the fields you set to unknown.",
].join("\n");

const cache = new Map<string, Promise<IssueFrame | null>>();
const MAX_CACHE = 500;

function cacheKey(message: string, context?: string): string {
  return createHash("sha256").update(`${context ?? ""}\u0000${message}`).digest("hex");
}

/** Production understander (OpenAI). Null when no key is configured. */
export function openAIUnderstander(options: { model?: string; timeoutMs?: number } = {}): ModelUnderstander | null {
  const key = process.env.OPENAI_API_KEY;
  if (!key || key.startsWith("placeholder")) return null;
  const model = options.model ?? process.env.UNDERSTANDING_MODEL ?? "gpt-4o-mini";
  const timeoutMs = options.timeoutMs ?? Number(process.env.UNDERSTANDING_TIMEOUT_MS ?? 5000);

  return async (message, context) => {
    const k = cacheKey(message, context);
    const hit = cache.get(k);
    if (hit) return hit;
    const pending = (async () => {
      try {
        const { openai } = await import("@/lib/openai-client");
        const completion = await openai.chat.completions.parse(
          {
            model,
            temperature: 0,
            messages: [
              { role: "system", content: UNDERSTANDING_SYSTEM_PROMPT },
              ...(context ? [{ role: "system" as const, content: `What we know so far: ${context}` }] : []),
              { role: "user", content: message.slice(0, 1500) },
            ],
            response_format: zodResponseFormat(IssueFrameSchema, "issue_frame"),
          },
          { timeout: timeoutMs, maxRetries: 0 }
        );
        const parsed = completion.choices[0]?.message.parsed;
        return parsed ? withUnknowns(parsed) : null;
      } catch {
        return null;
      }
    })();
    if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value as string);
    cache.set(k, pending);
    const result = await pending;
    if (result === null) cache.delete(k); // don't cache failures
    return result;
  };
}
