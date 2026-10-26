/**
 * Out-of-scope question/option check for the eval, written independently
 * of the app's scope filter (src/assistant/sops/scope.ts) so it can catch it
 * missing something. Context comes from the labelled (true) frame.
 */
export interface ScopeContext {
  equipment: string;
  substance: string;
  room: string;
}

const BATH_FIXTURES = /\b(shower|showering|bath|bathtub|bathing|tub|toilet|flush|flushed|flushing)\b/i;
const KITCHEN_FIXTURES = /\b(dishwasher|range hood|hood fan|stove|oven|cooktop|garbage disposal|garburator|fridge|refrigerator|freezer)\b/i;
const APPLIANCES = new Set(["fridge", "dishwasher", "washer", "dryer", "range_hood", "stove_oven", "microwave", "garbage_disposal"]);
const KITCHEN_ONLY = new Set(["fridge", "dishwasher", "range_hood", "stove_oven", "microwave", "garbage_disposal", "kitchen_sink"]);
const BATH_ONLY = new Set(["toilet", "tub_shower", "bathroom_sink", "bathroom_fan"]);
const NOT_WATER = new Set(["grease", "oil", "smoke"]);

/** Why this question or option text doesn't fit the true situation, or null. */
export function scopeViolation(text: string, ctx: ScopeContext): string | null {
  // Ceiling/wall leaks may name what's above (an upstairs bathroom); questions that ask
  // the room or "where is the water?" list rooms/fixtures to pick from.
  if (ctx.equipment === "ceiling" || ctx.equipment === "wall") return null;
  const kitchen = ctx.room === "kitchen" || KITCHEN_ONLY.has(ctx.equipment);
  const bathroom = ctx.room === "bathroom" || BATH_ONLY.has(ctx.equipment);
  if ((kitchen || (APPLIANCES.has(ctx.equipment) && ctx.equipment !== "washer")) && BATH_FIXTURES.test(text)) return `bathroom fixture in a ${ctx.equipment}/${ctx.room} chat`;
  if (bathroom && KITCHEN_FIXTURES.test(text)) return `kitchen fixture in a ${ctx.equipment}/${ctx.room} chat`;
  if (NOT_WATER.has(ctx.substance) && /\bwater\b/i.test(text)) return `water question, but it's ${ctx.substance}`;
  return null;
}

/** Questions that are pick-lists of rooms or categories (allowed to name any room). */
export function isPickList(question: string | null): boolean {
  return question === "location_in_unit" || question === "classify_category";
}
