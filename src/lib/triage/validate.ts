/**
 * Phase 2B — Post-grounding validation loop.
 *
 * Pure, deterministic validation of grounded troubleshooting output.
 * Checks citation grounding, safety guidance, retrieval confidence,
 * and basic completeness. No LLM calls.
 *
 * Persisted in tickets.classification.validation.
 */

import type { GatheredInfo, ValidationResult } from "./types";
import type { RetrievalSnippet } from "../retrieval/types";
import type { GroundedResult } from "./grounding";

// ── Thresholds (overridable via env) ──

const DEFAULT_HIGHEST_SCORE_THRESHOLD = 0.45;
const DEFAULT_AVERAGE_SCORE_THRESHOLD = 0.40;

function getThresholds() {
  return {
    highestScore: parseFloat(
      process.env.VALIDATION_HIGHEST_SCORE_THRESHOLD ??
        String(DEFAULT_HIGHEST_SCORE_THRESHOLD)
    ),
    averageScore: parseFloat(
      process.env.VALIDATION_AVERAGE_SCORE_THRESHOLD ??
        String(DEFAULT_AVERAGE_SCORE_THRESHOLD)
    ),
  };
}

// ── Citation pattern ──

const SOP_CITATION_RE = /\[SOP-\d+\]/;

// ── Safety keywords (subset of state-machine.ts emergency keywords) ──

const SAFETY_CHECK_PHRASES = [
  "911",
  "evacuate",
  "leave the unit",
  "leave immediately",
  "turn off",
  "safety",
  "emergency",
  "do not re-enter",
];

/**
 * Validate the grounded result against retrieval context and gathered info.
 *
 * Pure function — no side effects, no LLM calls.
 */
export function validateGroundedResult(
  groundedResult: GroundedResult,
  snippets: RetrievalSnippet[],
  gathered: GatheredInfo,
  retrievalHighestScore: number,
  retrievalAverageScore: number
): ValidationResult {
  const thresholds = getThresholds();
  const reasons: string[] = [];

  // ── A. Grounding: citations present when snippets exist ──
  const hasSnippets = snippets.length > 0;
  const hasCitations =
    SOP_CITATION_RE.test(groundedResult.reply) ||
    groundedResult.steps.some((s) => SOP_CITATION_RE.test(s.description));
  const missingCitations = hasSnippets && !groundedResult.usedFallback && !hasCitations;

  if (missingCitations) {
    reasons.push("snippets_provided_but_no_citations_in_output");
  }

  // ── B. Safety: emergency must include safety guidance ──
  const isEmergency = gathered.is_emergency === true;
  const replyLower = groundedResult.reply.toLowerCase();
  const hasSafetyGuidance = SAFETY_CHECK_PHRASES.some((phrase) =>
    replyLower.includes(phrase.toLowerCase())
  );
  const missingSafetyGuidance = isEmergency && !hasSafetyGuidance;

  if (missingSafetyGuidance) {
    reasons.push("emergency_issue_but_no_safety_guidance_in_output");
  }

  // ── C. Confidence: retrieval scores above thresholds ──
  const lowConfidence =
    hasSnippets &&
    !groundedResult.usedFallback &&
    (retrievalHighestScore < thresholds.highestScore ||
      retrievalAverageScore < thresholds.averageScore);

  if (lowConfidence) {
    reasons.push(
      `retrieval_scores_below_threshold: highest=${retrievalHighestScore.toFixed(3)} (need ${thresholds.highestScore}), avg=${retrievalAverageScore.toFixed(3)} (need ${thresholds.averageScore})`
    );
  }

  // ── D. Completeness: basic context consistency ──
  if (
    !groundedResult.usedFallback &&
    groundedResult.steps.length === 0 &&
    hasSnippets
  ) {
    reasons.push("grounding_produced_zero_parseable_steps");
  }

  // ── Verdict ──
  const isValid = !missingCitations && !missingSafetyGuidance && !lowConfidence && reasons.length === 0;

  return {
    is_valid: isValid,
    low_confidence: lowConfidence,
    missing_citations: missingCitations,
    missing_safety_guidance: missingSafetyGuidance,
    reasons,
    highest_score: retrievalHighestScore,
    average_score: retrievalAverageScore,
    action_taken: "none", // caller fills this in after acting on the result
  };
}
