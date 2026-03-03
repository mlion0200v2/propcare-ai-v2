/**
 * Phase 2B — Grounded troubleshooting step generation.
 *
 * Uses OpenAI chat completion to generate tenant-safe steps
 * from retrieved SOP snippets with [SOP-N] citations.
 * Falls back to getFallbackSOP() when retrieval is empty or low-confidence.
 */

import OpenAI from "openai";
import type { GatheredInfo, TroubleshootingStep } from "./types";
import type { RetrievalSnippet } from "../retrieval/types";
import { getFallbackSOP } from "./sop-fallback";

const SYSTEM_PROMPT = `You are a property maintenance assistant. Generate 3-6 practical troubleshooting steps for a tenant based ONLY on the retrieved SOP snippets below.

Rules:
- Use ONLY information from the provided snippets
- Cite each step using [SOP-N] format matching the snippet number
- Do NOT invent, assume, or add information not in the snippets
- If the snippets do not contain enough information to give a step, say: "We don't have specific guidance for this — your property manager will follow up."
- Keep steps simple, safe, and tenant-appropriate (no professional-level repairs)
- Return ONLY the numbered steps, one per line, with citations`;

// Emergency safety text (prepended BEFORE grounded steps)
const EMERGENCY_SAFETY_LINES = [
  "**SAFETY ALERT**: Your issue has been flagged as a potential emergency.",
  "",
  "**If you are in immediate danger, call 911.**",
  "",
  "**IMMEDIATE ACTIONS:**",
  "1. If you smell gas, leave the unit immediately and call 911.",
  "2. If there's flooding, turn off the water main if you can safely reach it.",
  "3. If there's a fire or smoke, evacuate and call 911.",
  "4. Do NOT re-enter the unit until cleared by emergency services.",
  "",
  "Your ticket has been escalated to your property manager for urgent review.",
  "",
  "---",
  "",
];

export interface GroundedResult {
  reply: string;
  steps: TroubleshootingStep[];
  usedFallback: boolean;
}

/**
 * Generate grounded troubleshooting steps from retrieved snippets.
 *
 * If snippets are empty or low-confidence, falls back to hardcoded SOP.
 * If emergency, safety guidance is prepended BEFORE any steps.
 */
export async function generateGroundedSteps(
  gathered: GatheredInfo,
  snippets: RetrievalSnippet[],
  isEmergency: boolean,
  lowConfidence: boolean
): Promise<GroundedResult> {
  const category = gathered.category ?? "general";

  // Fallback path: no snippets or low confidence
  if (snippets.length === 0 || lowConfidence) {
    const sop = getFallbackSOP(category, isEmergency);

    const replyParts: string[] = [];
    if (isEmergency) {
      replyParts.push(...EMERGENCY_SAFETY_LINES);
    }
    replyParts.push(sop.display);
    if (!isEmergency) {
      replyParts.push(
        "",
        "Your ticket has been submitted. Your property manager will follow up."
      );
    }

    return {
      reply: replyParts.join("\n"),
      steps: sop.steps,
      usedFallback: true,
    };
  }

  // Build snippet context for the LLM
  const snippetContext = snippets
    .map(
      (s, i) =>
        `[SOP-${i + 1}] "${s.title}" (score: ${s.score.toFixed(2)})\n${s.content}`
    )
    .join("\n\n");

  const userPrompt = [
    `Category: ${category}`,
    `Location: ${gathered.location_in_unit ?? "unknown"}`,
    `Issue status: ${gathered.current_status ?? "unknown"}`,
    gathered.brand_model ? `Equipment: ${gathered.brand_model}` : null,
    "",
    "Retrieved SOP snippets:",
    snippetContext,
  ]
    .filter((line) => line !== null)
    .join("\n");

  // Call OpenAI
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.2,
    max_tokens: 600,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
  });

  const stepsText = completion.choices[0]?.message?.content?.trim() ?? "";

  // Parse numbered steps from LLM output
  const stepLines = stepsText
    .split("\n")
    .filter((line) => /^\d+[\.\)]/.test(line.trim()));

  const steps: TroubleshootingStep[] = stepLines.map((line, i) => ({
    step: i + 1,
    description: line.replace(/^\d+[\.\)]\s*/, "").trim(),
    completed: false,
  }));

  // Build sources footer
  const sourcesFooter = [
    "",
    "Sources:",
    ...snippets.map(
      (s, i) => `[SOP-${i + 1}] "${s.title}" (score: ${s.score.toFixed(2)})`
    ),
  ].join("\n");

  // Compose reply
  const replyParts: string[] = [];

  if (isEmergency) {
    replyParts.push(...EMERGENCY_SAFETY_LINES);
  } else {
    replyParts.push(
      "Thank you for providing all the details. Here are some troubleshooting steps while your property manager reviews your ticket:",
      ""
    );
  }

  replyParts.push("**Troubleshooting Steps:**");
  replyParts.push(stepsText);
  replyParts.push(sourcesFooter);

  if (!isEmergency) {
    replyParts.push(
      "",
      "Your ticket has been submitted. Your property manager will follow up."
    );
  }

  replyParts.push(
    "",
    "If you have any photos or videos of the issue, please upload them to help your property manager."
  );

  return {
    reply: replyParts.join("\n"),
    steps:
      steps.length > 0
        ? steps
        : // Fallback if LLM output couldn't be parsed
          getFallbackSOP(category, isEmergency).steps,
    usedFallback: false,
  };
}
