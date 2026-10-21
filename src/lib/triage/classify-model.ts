/**
 * Model fallback for issue classification. Used ONLY when the keyword rules
 * and the vocabulary table find nothing (see openConversation), so most
 * messages never reach it. Short timeout; any failure means "ask the tenant".
 */
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";
import { openai } from "../openai-client";
import { logWarn } from "./logger";

const CATEGORIES = [
  "plumbing", "electrical", "hvac", "appliance", "structural", "pest_control",
  "locksmith", "roofing", "painting", "flooring", "landscaping", "general",
] as const;

const Result = z.object({
  category: z.enum(CATEGORIES),
  equipment: z.string().nullable(),
  confident: z.boolean(),
});

export async function classifyWithModel(message: string): Promise<{ category: string; equipment: string | null } | null> {
  if (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY.startsWith("placeholder")) return null;
  try {
    const completion = await openai.chat.completions.parse(
      {
        model: process.env.CLASSIFY_MODEL || "gpt-4o-mini",
        temperature: 0,
        messages: [
          {
            role: "system",
            content:
              "Classify a tenant's home maintenance report. Pick one category. If they name an appliance or fixture, " +
              "give it in plain words (e.g. 'range hood', 'dishwasher', 'toilet'), else null. Set confident=false if unsure.",
          },
          { role: "user", content: message.slice(0, 500) },
        ],
        response_format: zodResponseFormat(Result, "classification"),
      },
      { timeout: 6000 }
    );
    const parsed = completion.choices[0]?.message.parsed;
    if (!parsed || !parsed.confident || parsed.category === "general") return null;
    return { category: parsed.category, equipment: parsed.equipment?.trim().toLowerCase() || null };
  } catch (err) {
    logWarn("classify_model_fallback", "Model fallback failed; asking the tenant instead", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
