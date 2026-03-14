/**
 * Phase 2B — Extended issue detail gathering.
 *
 * Adds current_status (always) and brand_model (conditional: appliance/hvac)
 * on top of the base 4 fields collected by step().
 *
 * isGatherComplete() is the SINGLE source of truth for whether all
 * required issue details have been collected.
 */

import type { GatheredInfo } from "./types";

// Categories that require brand_model
const BRAND_MODEL_CATEGORIES = ["appliance", "hvac"] as const;

// Extended field questions
const EXTENDED_QUESTIONS: Record<string, string> = {
  current_status:
    "What is the current status of the issue? (e.g., still happening, comes and goes, getting worse)",
  brand_model:
    "What is the brand and model of the equipment, if known? (e.g., GE Profile dishwasher, Carrier AC unit). If unknown, reply \"unknown\".",
};

// Extended fields asked in this order (after base 4 are complete)
const EXTENDED_FIELD_ORDER = ["current_status", "brand_model"] as const;

/**
 * Check whether the given field name is an extended field (not handled by step()).
 */
export function isExtendedField(field: string): boolean {
  return EXTENDED_FIELD_ORDER.includes(field as typeof EXTENDED_FIELD_ORDER[number]);
}

/**
 * Single source of truth: are ALL required issue fields collected?
 *
 * Checks:
 * - category, location_in_unit, started_when (non-null)
 * - current_status (non-null)
 * - brand_model (non-null only if category is appliance or hvac)
 *
 * NOTE: is_emergency is NOT checked here — it is set by the safety
 * detection module AFTER gather is complete (see detect-safety.ts).
 */
export function isGatherComplete(gathered: GatheredInfo): boolean {
  // Core gather fields (is_emergency handled separately by safety detection)
  if (
    gathered.category === null ||
    gathered.location_in_unit === null ||
    gathered.started_when === null
  ) {
    return false;
  }

  // Extended: current_status always required
  if (gathered.current_status === null) {
    return false;
  }

  // Extended: brand_model required for appliance/hvac
  if (needsBrandModel(gathered.category) && gathered.brand_model === null) {
    return false;
  }

  return true;
}

/**
 * Get the next extended question to ask, or null if all extended fields are complete.
 * Assumes base 4 fields are already filled (call only after step() returns DONE or
 * after verifying base fields are non-null).
 */
export function getNextExtendedQuestion(gathered: GatheredInfo): string | null {
  if (gathered.current_status === null) {
    return "current_status";
  }

  if (needsBrandModel(gathered.category) && gathered.brand_model === null) {
    return "brand_model";
  }

  return null;
}

/**
 * Get the question text for an extended field.
 */
export function getExtendedQuestionText(field: string): string {
  return EXTENDED_QUESTIONS[field] ?? "";
}

/**
 * Process the user's answer for an extended field.
 * Returns the updated gathered info (immutable — returns new object).
 */
export function processExtendedAnswer(
  gathered: GatheredInfo,
  field: string,
  userMessage: string
): GatheredInfo {
  const updated = { ...gathered };
  const trimmed = userMessage.trim();

  switch (field) {
    case "current_status":
      updated.current_status = trimmed;
      break;
    case "brand_model":
      updated.brand_model = trimmed.toLowerCase() === "unknown" ? "unknown" : trimmed;
      break;
  }

  return updated;
}

/**
 * Check if a category requires the brand_model field.
 */
function needsBrandModel(category: string | null): boolean {
  if (!category) return false;
  return BRAND_MODEL_CATEGORIES.includes(category as typeof BRAND_MODEL_CATEGORIES[number]);
}
