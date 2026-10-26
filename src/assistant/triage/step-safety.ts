/**
 * Never-instruct post-filter for troubleshooting steps shown to tenants.
 *
 * Applied to EVERY generated step — Pinecone-grounded, web-search, hardcoded
 * SOP and LLM "how do I…" help — as a last line of defence. A step is dropped
 * when it tells the tenant to do something only a professional should do
 * (gas, live electrical, moving heavy appliances, chemicals, roofs/ladders) or
 * points them at outside video tutorials.
 *
 * Warnings are allowed through: "Do NOT touch the gas valve" is fine,
 * "Turn off the gas valve" is not.
 *
 * Pure, deterministic — no LLM calls.
 */

import type { TroubleshootingStep } from "./types";

interface NeverInstructRule {
  id: string;
  pattern: RegExp;
}

const NEVER_INSTRUCT: NeverInstructRule[] = [
  // Gas — tenants never touch gas controls, pilots or lines.
  { id: "gas_pilot", pattern: /\b(re-?light|light|ignite|check|look at|inspect)\b[^.]{0,30}\bpilot( light| flame)?\b/i },
  { id: "gas_pilot", pattern: /\bpilot (light|flame)\b[^.]{0,30}\b(is lit|lit|relight|re-light|on|out)\b/i },
  { id: "gas_controls", pattern: /\bgas\s+(valve|shut-?off|supply|line|lines|meter|cock|control|knob|connection|connections|pipe|pipes|regulator)s?\b/i },
  { id: "gas_controls", pattern: /\b(turn|shut|switch)\s+(on|off)\s+(the\s+)?gas\b|\b(turn|shut|switch)\s+(the\s+)?gas\s+(on|off)\b/i },
  { id: "gas_controls", pattern: /\bgas\b[^.]{0,30}\bvalve\b[^.]{0,20}\b(open|close|closed|turn)\b|\b(open|close|turn)\b[^.]{0,20}\bvalve\b[^.]{0,30}\bgas\b/i },

  // Electrical — breakers are off-limits whenever sparks, burning, smoke or
  // water are involved; panels, covers and wiring are always off-limits.
  {
    id: "breaker_hazard",
    pattern: /\b(spark\w*|burning|smoke|smoking|scorch\w*|melt\w*|water(?! heater)|wet|leak\w*|flood\w*|drip\w*)\b[^.]{0,80}\b(breakers?|fuses?|electrical panel|breaker panel|main switch)\b|\b(breakers?|fuses?|electrical panel|breaker panel|main switch)\b[^.]{0,80}\b(spark\w*|burning|smoke|smoking|water(?! heater)|wet|leak\w*|flood\w*|drip\w*)\b/i,
  },
  { id: "electrical_work", pattern: /\b(remove|open|take off|unscrew)\b[^.]{0,25}\b(panel cover|cover plate|outlet cover|switch plate|faceplate|electrical panel|junction box)\b/i },
  { id: "electrical_work", pattern: /\b(touch|handle|tighten|reconnect|connect|disconnect|cap|tape|splice|strip)\b[^.]{0,25}\bwir(e|es|ing)\b/i },
  { id: "electrical_work", pattern: /\b(replace|change|swap)\b[^.]{0,15}\b(fuse|outlet|socket|switch|breaker|gfci)\b/i },

  // Moving heavy / built-in appliances.
  {
    id: "move_appliance",
    pattern: /\b(pull|move|slide|tilt|tip|drag|roll|lift|shift)\s+(out\s+|back\s+)?(the\s+|your\s+|a\s+|that\s+)?(fridge|refrigerator|freezer|stove|range|oven|washer|washing machine|dryer|dishwasher|water heater)\b|\b(fridge|refrigerator|freezer|stove|range|oven|washer|washing machine|dryer|dishwasher)\b[^.]{0,25}\b(out|away)\s+from\s+the\s+wall\b/i,
  },
  { id: "move_appliance", pattern: /\b(remove|take off)\b[^.]{0,20}\b(base grille|kick ?plate|toe ?kick|access panel|back panel)\b/i },

  // Chemicals.
  { id: "chemicals", pattern: /\bwd-?40\b|\b(lubricant|lubricate|graphite|silicone spray)\b/i },
  { id: "chemicals", pattern: /\b(use|pour|try|apply|add)\b[^.]{0,25}\b(drain cleaner|drano|liquid[- ]plumr|lye|caustic|muriatic|acid)\b/i },
  { id: "chemicals", pattern: /\bmix\w*\b[^.]{0,30}\b(bleach|ammonia|vinegar)\b[^.]{0,30}\b(bleach|ammonia|vinegar)\b/i },

  // Heights.
  { id: "heights", pattern: /\b(climb|go up|get up|get on)\b[^.]{0,20}\b(roof|ladder|attic)\b/i },

  // Outside tutorials — the assistant must not send tenants to videos.
  { id: "external_video", pattern: /\byoutube\b|\b(watch|search for|look up)\b[^.]{0,25}\b(video|tutorial)s?\b/i },
];

// A step that only warns ("Do NOT …", "Never …", "Avoid …") is allowed even
// though it mentions a forbidden action — unless it is a disguised instruction
// ("don't forget to turn off the gas valve").
const WARNING_PREFIX = /^\s*(\d+[.)]\s*)?(\*\*)?\s*(do not|don'?t|never|avoid|please don'?t|please do not|stop|stay away)\b/i;
const DISGUISED_INSTRUCTION = /\b(don'?t|do not) (forget|hesitate)\b/i;

// An inline negation right before the match: "(don't pull the fridge out)".
const NEGATED_BEFORE = /\b(don'?t|do not|never|without|no need to|not)\s+$/i;

/** The never-instruct rule a step breaks, or null when it is safe to show. */
export function findUnsafeInstruction(text: string): string | null {
  const disguised = DISGUISED_INSTRUCTION.test(text);
  if (WARNING_PREFIX.test(text) && !disguised) return null;
  for (const rule of NEVER_INSTRUCT) {
    const re = new RegExp(rule.pattern.source, "gi");
    for (const m of text.matchAll(re)) {
      const before = text.slice(Math.max(0, (m.index ?? 0) - 20), m.index);
      if (disguised || !NEGATED_BEFORE.test(before)) return rule.id;
    }
  }
  return null;
}

export function isUnsafeInstruction(text: string): boolean {
  return findUnsafeInstruction(text) !== null;
}

// ── Units: Birchwood is in BC — show Celsius ──

function fToC(f: number): number {
  return Math.round(((f - 32) * 5) / 9);
}

/**
 * Convert Fahrenheit temperatures to Celsius, e.g. "120°F and 140°F" →
 * "49 °C and 60 °C", "120-140 degrees F" → "49–60 °C".
 */
export function toCelsius(text: string): string {
  return text
    .replace(
      /(-?\d+(?:\.\d+)?)\s*(?:°\s*F?|degrees?\s*(?:F|Fahrenheit)?)?\s*(?:-|–|to)\s*(-?\d+(?:\.\d+)?)\s*(?:°\s*F|degrees?\s*(?:F|Fahrenheit)|℉)(?![a-z])/gi,
      (_m, a: string, b: string) => `${fToC(parseFloat(a))}–${fToC(parseFloat(b))} °C`
    )
    .replace(
      /(-?\d+(?:\.\d+)?)\s*(?:°\s*F|degrees?\s*(?:F|Fahrenheit)|℉)(?![a-z])/gi,
      (_m, a: string) => `${fToC(parseFloat(a))} °C`
    );
}

// ── Applying the filter ──

export interface StepSafetyResult {
  steps: TroubleshootingStep[];
  removed: Array<{ description: string; rule: string }>;
}

/** Drop unsafe steps, convert units, renumber. */
export function filterUnsafeSteps(steps: TroubleshootingStep[]): StepSafetyResult {
  const removed: StepSafetyResult["removed"] = [];
  const kept: TroubleshootingStep[] = [];
  for (const step of steps) {
    const rule = findUnsafeInstruction(step.description);
    if (rule) {
      removed.push({ description: step.description, rule });
      continue;
    }
    kept.push({ ...step, description: toCelsius(step.description) });
  }
  return {
    steps: kept.map((s, i) => ({ ...s, step: i + 1 })),
    removed,
  };
}

/**
 * Remove unsafe lines from a free-text reply (numbered steps or bullet lines)
 * and convert units. Non-step prose is kept as-is apart from unit conversion.
 */
export function sanitizeReplyText(reply: string): string {
  return reply
    .split("\n")
    .filter((line) => {
      const stripped = line.replace(/^\s*(\d+[.)]|[-*•])\s*/, "").trim();
      return !stripped || !isUnsafeInstruction(stripped);
    })
    .map(toCelsius)
    .join("\n");
}
