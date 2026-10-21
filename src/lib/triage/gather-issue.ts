/**
 * Phase 2B — Extended issue detail gathering.
 *
 * Adds current_status (always), a water-leak source deep-dive (leaks only:
 * where, how much, when, electrical nearby) and brand_model (conditional:
 * appliance/hvac) on top of the base 4 fields collected by step().
 *
 * isGatherComplete() is the SINGLE source of truth for whether all
 * required issue details have been collected.
 */

import type { GatheredInfo } from "./types";
import { FIXTURES, LEAK_SOURCES, detectFixture, matchOption, resolveLikelySource, type FixtureId } from "./fixtures";

// Categories that require brand_model
const BRAND_MODEL_CATEGORIES = ["appliance", "hvac"] as const;

// Extended field questions
const EXTENDED_QUESTIONS: Record<string, string> = {
  current_status:
    "What is the current status of the issue? (e.g., still happening, comes and goes, getting worse)",
  brand_model:
    "What is the brand and model of the equipment, if known? (e.g., GE Profile dishwasher, Carrier AC unit). If unknown, reply \"unknown\".",
  leak_where:
    "Where is the water? (the ceiling, a wall, the floor, or which fixture: a sink, the toilet, the tub or shower, an appliance)",
  leak_amount:
    "How much water is there right now? (a few drops, a small puddle, or spreading)",
  leak_electrical:
    "Is the water near an outlet, a light, or anything plugged in? (yes / no / not sure)",
};

// Leak deep-dive, in order. leak_part / leak_timing come from the fixture table.
const LEAK_FIELDS = ["leak_where", "leak_part", "leak_timing", "leak_amount", "leak_electrical"] as const;
type LeakField = (typeof LEAK_FIELDS)[number];

function fixtureOf(gathered: GatheredInfo) {
  return gathered.leak_fixture ? FIXTURES[gathered.leak_fixture as FixtureId] ?? null : null;
}

/** Leak questions this conversation needs (depends on the fixture). */
function leakFieldNeeded(gathered: GatheredInfo, field: LeakField): boolean {
  const spec = fixtureOf(gathered);
  switch (field) {
    case "leak_where":
      return !spec; // only when no fixture is known
    case "leak_part":
      return !!spec?.part;
    case "leak_timing":
      return !!spec?.timing;
    default:
      return true;
  }
}

function missingLeakField(gathered: GatheredInfo): LeakField | null {
  return LEAK_FIELDS.find((f) => leakFieldNeeded(gathered, f) && gathered[f] == null) ?? null;
}

/**
 * Work out the fixture from the description, room and "where" answer, and
 * fill in whatever the tenant has already said about it. Call after every
 * answer (a room answer can make "sink" a kitchen sink).
 */
export function refreshLeakDetails(gathered: GatheredInfo, description: string, firstMessage = false): GatheredInfo {
  if (!gathered.leak_details_needed) return gathered;
  const updated = { ...gathered };
  if (!updated.leak_fixture) {
    updated.leak_fixture = detectFixture(`${description} ${updated.leak_where ?? ""}`, updated.location_in_unit);
    const spec = updated.leak_fixture ? FIXTURES[updated.leak_fixture as FixtureId] : null;
    // What the tenant already said about where/when on this fixture.
    // (For ceilings/walls the room named is where the tenant is, not what's above.)
    if (spec?.part && updated.leak_part == null && spec.id !== "ceiling_wall") {
      const said = matchOption(spec.part, `${description} ${updated.leak_where ?? ""}`);
      if (said && said.source) updated.leak_part = said.label;
    }
    if (spec?.timing && updated.leak_timing == null && firstMessage) {
      const said = matchOption(spec.timing, description);
      if (said && said.label !== "Not sure") updated.leak_timing = said.label;
    }
  }
  const source = resolveLikelySource((updated.leak_fixture as FixtureId) ?? null, updated.leak_part, updated.leak_timing);
  updated.leak_likely_source = source ? { id: source, label: LEAK_SOURCES[source].label } : updated.leak_likely_source ?? null;
  return updated;
}

const LEAK_WORDS =
  /\b(leak|leaks|leaking|leaked|drip|drips|dripping|water (?:is )?(?:coming|pouring|on the floor|everywhere|under|underneath|around|behind|below|pooling|collecting|seeping)|puddle|puddles|pooling|flood|flooding|flooded|overflow|overflowing|burst|seeping|wet (?:ceiling|wall|floor|carpet|cabinet)|water stain|water damage)\b/i;

/** True when the report is about water escaping somewhere (asks the leak deep-dive). */
export function isWaterLeak(text: string): boolean {
  return LEAK_WORDS.test(text);
}

const LEAK_WHERE_PATTERNS: [RegExp, string][] = [
  [/\bceiling\b/i, "Ceiling"],
  [/\b(under|underneath|below) (the )?(kitchen |bathroom )?sink\b|\bsink\b.*\b(underneath|under it|below it|cabinet)\b/i, "Under the sink"],
  [/\b(behind|around|base of|under) (the |my )?toilet\b/i, "Around the toilet"],
  [/\b(dishwasher|washing machine|washer|fridge|refrigerator|water heater|hot water tank)\b/i, "Around an appliance"],
  [/\bwalls?\b/i, "Wall"],
  [/\bfloor\b/i, "Floor"],
];

/** Where the water is, if the tenant already said it ("dripping from the ceiling" → Ceiling). */
export function extractLeakWhere(text: string): string | null {
  for (const [pattern, label] of LEAK_WHERE_PATTERNS) if (pattern.test(text)) return label;
  return null;
}

/** "yes" | "no" | "not sure" from a free-text answer. Anything unclear is "not sure". */
export function normaliseYesNo(answer: string): "yes" | "no" | "not sure" {
  const a = answer.trim().toLowerCase();
  // Explicit "no outlet / nothing electrical" first.
  if (/\b(no|not near|nowhere near|nothing) (outlets?|lights?|plugs?|sockets?|electric\w*)\b/.test(a)) return "no";
  // Any mention of electricity counts as yes, even after "no, but…" (safer).
  if (/\b(outlets?|lights?|plugs?|plugged|sockets?|electric\w*|switch(es)?|wires?|wiring|power bar|extension cord)\b/.test(a)) return "yes";
  if (/^(no|nope|nah|n)\b/.test(a)) return "no";
  if (/^(yes|yeah|yep|y|it is|close|near)\b/.test(a)) return "yes";
  return "not sure";
}

// Extended fields asked in this order (after base 4 are complete)
const EXTENDED_FIELD_ORDER = ["current_status", ...LEAK_FIELDS, "brand_model"] as const;

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

  // Extended: leak deep-dive for water leaks (fixture-specific)
  if (gathered.leak_details_needed && missingLeakField(gathered)) {
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

  if (gathered.leak_details_needed) {
    const missing = missingLeakField(gathered);
    if (missing) return missing;
  }

  if (needsBrandModel(gathered.category) && gathered.brand_model === null) {
    return "brand_model";
  }

  return null;
}

/**
 * Get the question text for an extended field.
 */
export function getExtendedQuestionText(field: string, gathered?: GatheredInfo): string {
  const spec = gathered ? fixtureOf(gathered) : null;
  if (field === "leak_part" && spec?.part) return withOptions(spec.part.question, spec.part.options.map((o) => o.label));
  if (field === "leak_timing" && spec?.timing) return withOptions(spec.timing.question, spec.timing.options.map((o) => o.label));
  return EXTENDED_QUESTIONS[field] ?? "";
}

function withOptions(question: string, labels: string[]): string {
  const shown = labels.filter((l) => l !== "Not sure").map((l) => l.charAt(0).toLowerCase() + l.slice(1));
  return `${question} (${shown.join("; ")}; or not sure)`;
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
    case "leak_where":
    case "leak_amount":
      updated[field] = trimmed.slice(0, 200);
      break;
    case "leak_part":
    case "leak_timing": {
      // Store the option it means (so the likely source is known), else the words.
      const spec = fixtureOf(updated);
      const question = field === "leak_part" ? spec?.part : spec?.timing;
      const option = question ? matchOption(question, trimmed) : null;
      updated[field] = option ? option.label : trimmed.slice(0, 200);
      break;
    }
    case "leak_electrical": {
      const answer = normaliseYesNo(trimmed);
      updated.leak_electrical = answer;
      // Water near electricity (or can't tell) is treated as an emergency.
      if (answer !== "no") updated.is_emergency = true;
      break;
    }
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
