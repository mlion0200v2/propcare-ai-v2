/**
 * LLM-Generated Contextual Help for Guided Troubleshooting Steps
 *
 * When a tenant asks "how do I do this?" during guided troubleshooting,
 * this module generates a brief, practical explanation using gpt-4o-mini.
 */

import { openai } from "../openai";
import type { GuidedStep } from "./types";
import { isUnsafeInstruction, sanitizeReplyText } from "./step-safety";

const SYSTEM_PROMPT = `You are a friendly property maintenance assistant helping a tenant who isn't sure how to perform a troubleshooting step.

Rules:
- Give a brief, practical explanation (2-4 sentences max)
- Use simple language — the tenant is not a professional
- If the step involves locating something, describe where to look
- Do NOT suggest repairs, disassembly, or anything requiring tools beyond basics
- If the step seems beyond a typical tenant's ability, say so honestly and tell them it's fine to skip it
- NEVER tell the tenant to touch gas valves, gas lines or pilot lights, open electrical panels or covers, touch wiring, reset breakers when there is water, sparks, smoke or a burning smell, move or pull out heavy appliances, climb on roofs or ladders, or use WD-40 or chemical cleaners
- Do NOT suggest YouTube or any other videos or websites
- Use metric units (°C, cm)`;

function buildUserPrompt(
  step: GuidedStep,
  equipment: string | null,
  category: string
): string {
  const parts = [
    `Issue category: ${category}`,
    `Step to explain: "${step.description}"`,
  ];
  if (equipment) {
    parts.push(`Equipment/appliance: ${equipment}`);
  }
  return parts.join("\n");
}

/**
 * Generate a brief contextual explanation for a troubleshooting step.
 * Falls back to a simple restatement if the LLM call fails.
 */
export async function generateStepHelp(
  step: GuidedStep,
  equipment: string | null,
  category: string
): Promise<string> {
  try {

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.3,
      max_tokens: 250,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildUserPrompt(step, equipment, category) },
      ],
    });

    const content = completion.choices[0]?.message?.content?.trim();
    // Never-instruct post-filter: drop unsafe sentences; if that guts the
    // answer, fall back to the plain restatement below.
    if (content) {
      const sentences = content.split(/(?<=[.!?])\s+/);
      const safe = sentences.filter((sentence) => !isUnsafeInstruction(sentence));
      if (safe.length === sentences.length || safe.length >= 2) {
        return sanitizeReplyText(safe.join(" "));
      }
    }
  } catch (err) {
    console.error("[step-help] LLM call failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Fallback
  return `Here's what to try: ${step.description}. If you're not comfortable with this, just let me know and we'll skip it.`;
}
