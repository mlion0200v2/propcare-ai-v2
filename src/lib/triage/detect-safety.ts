/**
 * Safety detection for triage issues.
 *
 * Replaces the generic "Are there any safety concerns? YES/NO" with:
 * 1. Automatic detection from issue description + gathered details
 * 2. Targeted safety questions based on the issue category
 *
 * Pure, deterministic — no LLM calls.
 */

import type { GatheredInfo } from "./types";

export interface SafetyDetectionResult {
  /** Whether the system detected a safety concern automatically */
  detected: boolean;
  /** Whether the system is uncertain and should ask a targeted question */
  needsQuestion: boolean;
  /** The targeted question to ask (only if needsQuestion=true) */
  question: string | null;
  /** Internal rationale */
  rationale: string;
}

// ── Emergency keywords (reused from state-machine.ts) ──

const EMERGENCY_KEYWORDS = [
  "gas leak",
  "gas smell",
  "smell gas",
  "fire",
  "smoke",
  "carbon monoxide",
  "exposed wire",
  "sparking",
  "sewage",
  "collapse",
  "ceiling fell",
  // NOTE: "mold", "flooding", "flooded", "no heat", "no hot water" removed —
  // these are category+severity dependent, not automatic emergencies.
];

// ── High-risk keywords that suggest we should ask a targeted question ──

const RISK_INDICATORS: Record<string, RegExp[]> = {
  plumbing: [
    /\b(major|bad|big|serious|severe|a lot)\b/i,
    /\b(water|wet|soaked|dripping)\b/i,
    /\b(under|beneath|below|spread|spreading)\b/i,
  ],
  electrical: [
    /\b(old|damaged|exposed|frayed|burnt)\b/i,
    /\b(shock|shocked|zap|buzzing|humming)\b/i,
    /\b(hot|warm|overheating)\b/i,
  ],
  hvac: [
    /\b(cold|freezing|ice|frost)\b/i,
    /\b(smell|odor|burning)\b/i,
    /\b(loud|noise|bang|clicking)\b/i,
  ],
  structural: [
    /\b(large|growing|spreading|getting worse)\b/i,
    /\b(sagging|leaning|unstable|shifting)\b/i,
    /\b(crack|hole|gap)\b/i,
  ],
  appliance: [
    /\b(smoke|smoking|burning|smell|sparks)\b/i,
    /\b(gas|propane|natural gas)\b/i,
  ],
};

// ── Targeted safety questions per category ──

const TARGETED_SAFETY_QUESTIONS: Record<string, string> = {
  plumbing:
    "One quick safety check -- is the water spreading beyond the immediate area (like onto the floor or into other rooms)?",
  electrical:
    "One quick safety check -- do you notice any sparks, a burning smell, or warmth coming from the outlet or panel?",
  hvac:
    "One quick safety check -- do you notice any unusual smells (like burning or gas) coming from the system?",
  structural:
    "One quick safety check -- does the damage appear to be getting worse or affecting the stability of the area?",
  appliance:
    "One quick safety check -- do you notice any smoke, burning smell, or sparks from the appliance?",
  roofing:
    "One quick safety check -- is water coming through near any electrical fixtures or wiring?",
  general:
    "One quick safety check -- are there any immediate safety concerns like water near electrical outlets, gas smells, or structural instability?",
};

// ── Category+severity conditional emergency detection ──
// These issues are only emergencies under specific conditions.

const FLOODING_EMERGENCY_PATTERNS = [
  /\b(pouring|gushing|burst|ruptured|heavy flow|water everywhere)\b/i,
  /\b(burst pipe|pipe burst|water main break)\b/i,
];

const ELECTRICAL_EMERGENCY_PATTERNS = [
  /\b(sparks?|sparking)\b/i,
  /\b(burning smell|smell burning|burning)\b/i,
  /\b(exposed wir)/i,
];

/**
 * Check for emergencies that depend on BOTH category and severity.
 * Returns a SafetyDetectionResult if a conditional emergency is detected, null otherwise.
 */
function detectConditionalEmergency(
  allText: string,
  category: string
): SafetyDetectionResult | null {
  // Flooding: only emergency if water is actively pouring/burst
  if (
    (category === "plumbing" || /\b(flood|flooding|flooded)\b/i.test(allText)) &&
    FLOODING_EMERGENCY_PATTERNS.some((p) => p.test(allText))
  ) {
    return {
      detected: true,
      needsQuestion: false,
      question: null,
      rationale: `conditional_emergency: flooding with active water flow`,
    };
  }

  // Electrical: only emergency if sparks, burning smell, or exposed wiring
  if (
    category === "electrical" &&
    ELECTRICAL_EMERGENCY_PATTERNS.some((p) => p.test(allText))
  ) {
    return {
      detected: true,
      needsQuestion: false,
      question: null,
      rationale: `conditional_emergency: electrical with sparks/burning/exposed`,
    };
  }

  // Mold, dripping water, "getting worse" without qualifying context → NOT emergency
  // These fall through to risk indicators or low-risk path.

  return null;
}

/**
 * Detect safety concerns from the issue description and gathered details.
 *
 * Returns:
 * - detected=true if emergency keywords found (skip question, auto-flag)
 * - needsQuestion=true if category has risk indicators but no auto-detection
 * - detected=false, needsQuestion=false if low-risk category
 */
export function detectSafety(
  description: string,
  gathered: GatheredInfo
): SafetyDetectionResult {
  const allText = [
    description,
    gathered.location_in_unit ?? "",
    gathered.current_status ?? "",
  ]
    .join(" ")
    .toLowerCase();

  const category = gathered.category ?? "general";

  // 1. Check for universal emergency keywords (auto-detect)
  const foundKeyword = EMERGENCY_KEYWORDS.find((k) => allText.includes(k));
  if (foundKeyword) {
    return {
      detected: true,
      needsQuestion: false,
      question: null,
      rationale: `auto_detected: "${foundKeyword}"`,
    };
  }

  // 2. Category+severity conditional emergencies
  //    These keywords are only emergencies in specific contexts.
  const conditionalResult = detectConditionalEmergency(allText, category);
  if (conditionalResult) {
    return conditionalResult;
  }

  // 3. Check category-specific risk indicators
  const indicators = RISK_INDICATORS[category];

  if (indicators) {
    const matchCount = indicators.filter((r) => r.test(allText)).length;
    if (matchCount >= 2) {
      // Multiple risk signals — ask a targeted question
      return {
        detected: false,
        needsQuestion: true,
        question: TARGETED_SAFETY_QUESTIONS[category] ?? TARGETED_SAFETY_QUESTIONS.general,
        rationale: `risk_indicators_matched: ${matchCount} for ${category}`,
      };
    }
  }

  // 3. For high-risk categories, always ask a targeted question
  const HIGH_RISK_CATEGORIES = ["electrical", "hvac"];
  if (HIGH_RISK_CATEGORIES.includes(category)) {
    return {
      detected: false,
      needsQuestion: true,
      question: TARGETED_SAFETY_QUESTIONS[category],
      rationale: `high_risk_category: ${category}`,
    };
  }

  // 4. Low-risk category — no safety concern detected, no question needed
  return {
    detected: false,
    needsQuestion: false,
    question: null,
    rationale: `low_risk: ${category}`,
  };
}

// ── Pest escalation ──

export interface PestEscalationResult {
  shouldEscalate: boolean;
  reason: string;
}

// Severe indicators — escalate any pest (tenant already tried professional help,
// or issue is spreading beyond the unit / clearly beyond DIY containment)
const SEVERE_PEST_PATTERNS = [
  /\btried (exterminator|pest control|professional)\b/i,
  /\bspreading to (other|next|neighbor|adjacent)\b/i,
  /\beverywhere\b/i,
  /\binfest(ed|ation)\b/i,
];

// Mild recurring indicators — only escalate high-risk pests, not low-risk ones
const MILD_RECURRING_PATTERNS = [
  /\bcomes and goes\b/i,
  /\bkeeps coming back\b/i,
  /\brecurring\b/i,
  /\bgetting worse\b/i,
  /\bevery (day|night|morning|evening|week)\b/i,
  /\btried (traps?|spray|bait|poison)\b/i,
  /\b(multiple|many|lots of)\b/i,
  /\bcame back\b/i,
  /\bcoming back\b/i,
  /\bnot going away\b/i,
  /\bspreading\b/i,
];

// Subcategories that always require professional treatment
const PROFESSIONAL_ONLY_PESTS = ["bedbugs"];

// Low-risk pests that tenants can safely attempt DIY containment for
const LOW_RISK_PESTS = ["ants", "cockroaches"];

/**
 * Check if a pest issue should be escalated to property management.
 *
 * Tiered escalation:
 * - Professional-only pests (bed bugs) → always escalate
 * - Entry point detected → always escalate (structural issue)
 * - Severe indicators (tried exterminator, spreading to neighbors) → escalate any pest
 * - Mild recurring indicators (getting worse, came back) → escalate high-risk pests only,
 *   low-risk pests (ants, cockroaches) proceed to guided troubleshooting
 */
export function checkPestEscalation(
  gathered: GatheredInfo,
  allText: string
): PestEscalationResult {
  if (gathered.category !== "pest_control") {
    return { shouldEscalate: false, reason: "not_pest_control" };
  }

  // Professional-only pests always escalate
  if (gathered.subcategory && PROFESSIONAL_ONLY_PESTS.includes(gathered.subcategory)) {
    return {
      shouldEscalate: true,
      reason: `professional_only_pest: ${gathered.subcategory}`,
    };
  }

  // Check for entry point
  if (gathered.entry_point) {
    return {
      shouldEscalate: true,
      reason: `entry_point_detected: "${gathered.entry_point}"`,
    };
  }

  const combinedText = [allText, gathered.current_status ?? ""].join(" ");

  // Severe indicators escalate any pest
  const severeMatch = SEVERE_PEST_PATTERNS.find((p) => p.test(combinedText));
  if (severeMatch) {
    return {
      shouldEscalate: true,
      reason: `severe_indicator: ${severeMatch.source}`,
    };
  }

  // Mild recurring indicators only escalate non-low-risk pests
  const isLowRisk = gathered.subcategory && LOW_RISK_PESTS.includes(gathered.subcategory);
  if (!isLowRisk) {
    const mildMatch = MILD_RECURRING_PATTERNS.find((p) => p.test(combinedText));
    if (mildMatch) {
      return {
        shouldEscalate: true,
        reason: `recurring_indicator: ${mildMatch.source}`,
      };
    }
  }

  return { shouldEscalate: false, reason: "no_escalation_triggers" };
}

/**
 * Parse the user's response to a targeted safety question.
 * More flexible than strict YES/NO.
 */
export function parseSafetyResponse(response: string): boolean {
  const lower = response.trim().toLowerCase();

  // Positive indicators
  if (/\b(yes|yeah|yep|y|true|definitely|absolutely|for sure)\b/i.test(lower)) {
    return true;
  }

  // Negative indicators (checked BEFORE descriptive patterns so "not getting worse" → false)
  if (/\b(no|nope|nah|not|not really|doesn't seem|don't think|none|nothing|isn't|doesn't)\b/i.test(lower)) {
    return false;
  }

  // Descriptive safety concerns (only reached if no negation detected above)
  if (/\b(sparks?|smoke|smoking|burning|gas smell|smell gas|flooding|flooded|spreading|getting worse|unstable|exposed)\b/i.test(lower)) {
    return true;
  }

  // Default: no safety concern if unclear
  return false;
}
