/**
 * LLM-Generated Contextual Help for Guided Troubleshooting Steps
 *
 * When a tenant asks "how do I do this?" during guided troubleshooting,
 * this module generates a brief, practical explanation using gpt-4o-mini.
 */

import OpenAI from "openai";
import type { GuidedStep } from "./types";

const SYSTEM_PROMPT = `You are a friendly property maintenance assistant helping a tenant who isn't sure how to perform a troubleshooting step.

Rules:
- Give a brief, practical explanation (2-4 sentences max)
- Use simple language — the tenant is not a professional
- If the step involves locating something, describe where to look
- Do NOT suggest repairs, disassembly, or anything requiring tools beyond basics
- If the step seems beyond a typical tenant's ability, say so honestly
- End with a YouTube search suggestion: "You might find a helpful video by searching YouTube for '[specific search term]'."`;

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
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

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
    if (content) return content;
  } catch (err) {
    console.error("[step-help] LLM call failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Fallback
  return `Here's what to try: ${step.description}. If you're not comfortable with this, just let me know and we'll skip it.`;
}
