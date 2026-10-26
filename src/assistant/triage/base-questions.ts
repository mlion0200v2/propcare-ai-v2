/**
 * The generic questions, used when no SOP matches: where in the unit, and
 * when it started (then current status and brand/model, gather-issue.ts).
 * When an SOP matches, its own intake questions are asked instead.
 */

import type { GatheredInfo } from "./types";

export const QUESTIONS: Record<string, string> = {
  location_in_unit: "Where in your unit is the issue? (e.g., kitchen, bathroom, bedroom)",
  started_when: "When did this start? (e.g., today, yesterday, a few days ago)",
};

const FIELD_ORDER = ["location_in_unit", "started_when"] as const;
type BaseField = (typeof FIELD_ORDER)[number];

export function isBaseField(field: string): field is BaseField {
  return (FIELD_ORDER as readonly string[]).includes(field);
}

/** The next base question to ask, or null when both are answered. */
export function getNextMissingField(gathered: GatheredInfo): BaseField | null {
  return FIELD_ORDER.find((f) => gathered[f] === null || gathered[f] === undefined) ?? null;
}

/** Record the answer to a base question (as given; the room is matched to the unit later). */
export function recordBaseAnswer(gathered: GatheredInfo, field: BaseField, message: string): GatheredInfo {
  return { ...gathered, [field]: message.trim() };
}

/** First reply: the acknowledgement, then the first question. */
export function buildInitialReply(acknowledgement: string, nextQuestionText: string): string {
  return [acknowledgement, "", nextQuestionText].join("\n");
}

/** An empty gathered-info object. */
export function buildInitialGathered(): GatheredInfo {
  return {
    category: null,
    location_in_unit: null,
    started_when: null,
    is_emergency: null,
    current_status: null,
    brand_model: null,
    subcategory: null,
    entry_point: null,
    equipment: null,
    equipment_candidates: null,
  };
}
