/**
 * Hybrid Step-Response Interpreter
 *
 * Combines deterministic regex (fast-path + fallback) with a small LLM call
 * for ambiguous tenant replies during guided troubleshooting.
 *
 * Flow:
 * 1. Hard safety regex → if match, return "unsafe" immediately (no LLM)
 * 2. Regex fast-path via classifyStepFeedback → if not "unclear", use it
 * 3. LLM interpretation → parse structured JSON
 * 4. If LLM detects emergency → override to "unsafe"
 * 5. If LLM confidence >= "medium" → map to TroubleshootingStepResult
 * 6. Fallback → regex result ("unclear")
 *
 * The LLM NEVER chooses the next workflow step — it only interprets the reply.
 * All routing decisions remain deterministic in step-feedback.ts / route.ts.
 */

import OpenAI from "openai";
import type {
  GuidedStep,
  InterpretedStepResponse,
  InterpretedResult,
  TroubleshootingStepResult,
} from "./types";
import { classifyStepFeedback } from "./step-feedback";

// ── Result mapper ──

const RESULT_MAP: Record<InterpretedResult, TroubleshootingStepResult> = {
  completed: "completed",
  helped: "helped",
  partially_helped: "partial",
  did_not_help: "did_not_help",
  asking_how: "asking_how",
  unable_to_access: "unable_to_access",
  cannot_assess: "unable_to_access",
  did_not_try: "did_not_try",
  skip: "did_not_try",
  unknown: "unclear",
};

const VALID_RESULTS = new Set<string>(Object.keys(RESULT_MAP));
const VALID_CONFIDENCES = new Set(["high", "medium", "low"]);

export function mapToStepResult(
  interpreted: InterpretedResult
): TroubleshootingStepResult {
  return RESULT_MAP[interpreted] ?? "unclear";
}

// ── JSON parser (strict) ──

export function parseInterpretation(
  raw: string
): InterpretedStepResponse | null {
  try {
    // Strip markdown code fences if present
    const cleaned = raw
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```\s*$/, "")
      .trim();

    const parsed = JSON.parse(cleaned);

    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !VALID_RESULTS.has(parsed.result) ||
      !VALID_CONFIDENCES.has(parsed.confidence)
    ) {
      return null;
    }

    return {
      result: parsed.result as InterpretedResult,
      confidence: parsed.confidence as "high" | "medium" | "low",
      extracted_note:
        typeof parsed.extracted_note === "string" && parsed.extracted_note.trim()
          ? parsed.extracted_note.trim()
          : undefined,
      mentioned_safety_issue: parsed.mentioned_safety_issue === true,
      mentioned_emergency_issue: parsed.mentioned_emergency_issue === true,
      should_clarify: parsed.should_clarify === true,
      clarification_question:
        typeof parsed.clarification_question === "string" &&
        parsed.clarification_question.trim()
          ? parsed.clarification_question.trim()
          : undefined,
    };
  } catch {
    return null;
  }
}

// ── LLM prompt ──

const SYSTEM_PROMPT = `You are a maintenance triage assistant analyzing a tenant's reply to a troubleshooting step.

Your job is to interpret the tenant's reply in the context of the specific step they were asked to perform.

Respond with ONLY valid JSON matching this exact schema:
{
  "result": "completed" | "helped" | "partially_helped" | "did_not_help" | "asking_how" | "unable_to_access" | "cannot_assess" | "did_not_try" | "skip" | "unknown",
  "confidence": "high" | "medium" | "low",
  "extracted_note": "<string or null>",
  "mentioned_safety_issue": <boolean>,
  "mentioned_emergency_issue": <boolean>
}

Definitions:
- "completed" = tenant performed the step (even if outcome is unclear or not yet evaluated)
- "helped" = tenant says the step fixed or resolved the issue
- "partially_helped" = tenant says the step improved things but didn't fully fix
- "did_not_help" = tenant tried the step but it didn't work or change anything
- "asking_how" = tenant is asking for instructions, explanation, or guidance on how to perform the step
- "unable_to_access" = tenant can't physically access, reach, find, or get to what's needed
- "cannot_assess" = tenant can't determine the answer to an observation/check question
- "did_not_try" = tenant explicitly chose not to attempt the step
- "skip" = tenant wants to move past this step without trying
- "unknown" = reply is completely unrelated or you genuinely cannot determine intent

Rules:
- Set confidence to "high" when intent is unambiguous
- Set confidence to "medium" when reasonable interpretation but some ambiguity
- Set confidence to "low" only when you are truly guessing
- extracted_note: Include ONLY factual observations or details the tenant mentioned (locations, conditions, findings). Do not invent or infer details not explicitly stated. Set to null if no useful detail.
- mentioned_safety_issue: true if the reply mentions anything potentially unsafe (gas smell, sparks, flooding, structural damage)
- mentioned_emergency_issue: true ONLY for clear emergencies (active fire, gas leak, severe flooding, structural collapse)

Do NOT add any text outside the JSON object.`;

function buildUserPrompt(
  step: GuidedStep,
  category: string,
  subcategory: string | null,
  tenantReply: string
): string {
  return [
    `Step type: ${step.step_kind}`,
    `Issue category: ${category}${subcategory ? ` (${subcategory})` : ""}`,
    `Step asked: "${step.description}"`,
    `Tenant reply: "${tenantReply}"`,
  ].join("\n");
}

// ── LLM call ──

export async function interpretStepResponse(
  step: GuidedStep,
  category: string,
  subcategory: string | null,
  tenantReply: string
): Promise<InterpretedStepResponse | null> {
  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      max_tokens: 200,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: buildUserPrompt(step, category, subcategory, tenantReply),
        },
      ],
    });

    const content = completion.choices[0]?.message?.content;
    if (!content) return null;

    return parseInterpretation(content);
  } catch (err) {
    console.error("[interpret-step-response] LLM call failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// ── Hybrid orchestrator ──

export interface HybridClassificationResult {
  result: TroubleshootingStepResult;
  note: string | null;
  source: "regex" | "llm";
  interpretation: InterpretedStepResponse | null;
}

/**
 * Classify tenant step feedback using a hybrid regex+LLM approach.
 *
 * 1. Regex fast-path (includes hard safety check as first priority)
 * 2. If regex returns "unclear", call LLM
 * 3. If LLM detects emergency, override to "unsafe"
 * 4. If LLM confidence >= "medium", use mapped result
 * 5. Otherwise fall back to regex result
 */
export async function classifyStepHybrid(
  message: string,
  step: GuidedStep,
  category: string,
  subcategory: string | null
): Promise<HybridClassificationResult> {
  // 1. Regex fast-path (includes UNSAFE_PATTERNS as highest priority)
  const regexResult = classifyStepFeedback(message, step);

  if (regexResult !== "unclear") {
    return {
      result: regexResult,
      note: null,
      source: "regex",
      interpretation: null,
    };
  }

  // 2. Regex returned "unclear" — call LLM
  const interpretation = await interpretStepResponse(
    step,
    category,
    subcategory,
    message
  );

  // 3. LLM call failed → fall back to regex "unclear"
  if (!interpretation) {
    return {
      result: "unclear",
      note: null,
      source: "regex",
      interpretation: null,
    };
  }

  // 4. LLM detected emergency → deterministic safety override
  if (interpretation.mentioned_emergency_issue) {
    return {
      result: "unsafe",
      note: interpretation.extracted_note ?? null,
      source: "llm",
      interpretation,
    };
  }

  // 5. Low confidence → fall back to regex "unclear"
  if (interpretation.confidence === "low") {
    return {
      result: "unclear",
      note: interpretation.extracted_note ?? null,
      source: "regex",
      interpretation,
    };
  }

  // 6. Medium or high confidence → use LLM result
  return {
    result: mapToStepResult(interpretation.result),
    note: interpretation.extracted_note ?? null,
    source: "llm",
    interpretation,
  };
}
