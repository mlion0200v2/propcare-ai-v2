/**
 * Automatic issue classification.
 *
 * Deterministic keyword rules + optional model fallback.
 * Replaces the numbered category menu with system-driven classification.
 */

const CATEGORY_OPTIONS = [
  "plumbing",
  "electrical",
  "hvac",
  "appliance",
  "structural",
  "pest_control",
  "locksmith",
  "roofing",
  "painting",
  "flooring",
  "landscaping",
  "general",
  "other",
] as const;

export type IssueCategory = (typeof CATEGORY_OPTIONS)[number];

export interface ClassificationResult {
  category: IssueCategory;
  confidence: "high" | "medium" | "low";
  rationale: string;
}

// ── Keyword rules (deterministic, checked first) ──

interface KeywordRule {
  category: IssueCategory;
  /** All patterns in at least one group must match for the rule to fire */
  patterns: RegExp[];
  /** Higher weight wins ties */
  weight: number;
}

const KEYWORD_RULES: KeywordRule[] = [
  // Plumbing
  { category: "plumbing", weight: 10, patterns: [/\b(leak|leaking|leaky|drip|dripping)\b/i] },
  { category: "plumbing", weight: 10, patterns: [/\b(faucet|sink|toilet|shower|bathtub|tub)\b/i] },
  { category: "plumbing", weight: 9, patterns: [/\b(pipe|pipes|plumb|drain|clog|clogged|backed up|backup|sewer|sewage)\b/i] },
  { category: "plumbing", weight: 8, patterns: [/\b(water heater|hot water|no hot water|water pressure)\b/i] },
  { category: "plumbing", weight: 7, patterns: [/\b(flood|flooding|flooded|water damage)\b/i] },
  { category: "plumbing", weight: 6, patterns: [/\b(garbage disposal|disposal)\b/i] },

  // Electrical
  { category: "electrical", weight: 10, patterns: [/\b(outlet|outlets|socket|plug|electrical)\b/i] },
  { category: "electrical", weight: 10, patterns: [/\b(breaker|circuit|fuse|tripped|tripping)\b/i] },
  { category: "electrical", weight: 9, patterns: [/\b(light|lights|lighting|switch|switches)\b/i] },
  { category: "electrical", weight: 8, patterns: [/\b(wiring|wire|wires|spark|sparking|sparks)\b/i] },
  { category: "electrical", weight: 7, patterns: [/\b(power|power out|no power|blackout|outage)\b/i] },
  { category: "electrical", weight: 6, patterns: [/\b(ceiling fan|fan)\b/i] },

  // HVAC
  { category: "hvac", weight: 10, patterns: [/\b(hvac|furnace|heater|heating)\b/i] },
  { category: "hvac", weight: 10, patterns: [/\b(air condition|ac unit|a\/c|air handler|condenser)\b/i] },
  { category: "hvac", weight: 9, patterns: [/\b(thermostat|temperature|too hot|too cold|no heat|no cooling)\b/i] },
  { category: "hvac", weight: 8, patterns: [/\b(vent|vents|ductwork|ducts|air filter)\b/i] },

  // Appliance — compound rules (must outweigh generic symptom rules)
  // Vent + oil/grease → appliance (range hood), not HVAC or plumbing
  { category: "appliance", weight: 14, patterns: [
    /\b(vent|hood|exhaust)\b/i,
    /\b(oil|grease|oily|greasy)\b/i,
  ]},
  { category: "appliance", weight: 12, patterns: [
    /\b(range hood|hood fan|vent hood|exhaust hood|stove hood|oven hood)\b/i,
  ]},
  { category: "appliance", weight: 11, patterns: [
    /\b(refrigerator|fridge|freezer|dishwasher|oven|stove|range|microwave|washer|dryer|washing machine|range hood)\b/i,
    /\b(leak|leaking|drip|dripping|oil|grease|water|noise|smell|smoke)\b/i,
  ]},
  // Appliance — noun-only rules
  { category: "appliance", weight: 10, patterns: [/\b(refrigerator|fridge|freezer|dishwasher|oven|stove|range|microwave|washer|dryer|washing machine|range hood)\b/i] },
  { category: "appliance", weight: 8, patterns: [/\b(appliance|appliances)\b/i] },

  // Structural
  { category: "structural", weight: 9, patterns: [/\b(mold|mildew|mouldy|moldy|moisture|damp|humid|fungus|musty)\b/i] },
  { category: "structural", weight: 10, patterns: [/\b(crack|cracks|cracking|foundation|settling)\b/i] },
  { category: "structural", weight: 9, patterns: [/\b(wall|walls|ceiling|floor)\b/i, /\b(damage|damaged|hole|sagging|bowing|buckling)\b/i] },
  { category: "structural", weight: 8, patterns: [/\b(window|windows|screen|screens|door|doors)\b/i, /\b(broken|stuck|won't close|won't open|jammed|loose|detached|falling|off track|coming off|torn|ripped)\b/i] },
  { category: "structural", weight: 7, patterns: [/\b(stair|stairs|railing|balcony|deck|porch)\b/i] },

  // Pest control
  { category: "pest_control", weight: 10, patterns: [/\b(pest|pests|bug|bugs|insect|insects|roach|roaches|cockroach|ant|ants|mice|mouse|rat|rats|rodent|spider|spiders|bed ?bug|termite|termites)\b/i] },
  { category: "pest_control", weight: 8, patterns: [/\b(infestation|exterminator|droppings)\b/i] },

  // Locksmith
  { category: "locksmith", weight: 10, patterns: [/\b(lock|locked|lockout|locked out|key|keys|deadbolt)\b/i] },

  // Roofing
  { category: "roofing", weight: 10, patterns: [/\b(roof|roofing|shingle|shingles|gutter|gutters)\b/i] },
  { category: "roofing", weight: 8, patterns: [/\b(ceiling)\b/i, /\b(leak|leaking|stain|water)\b/i] },

  // Painting
  { category: "painting", weight: 10, patterns: [/\b(paint|painting|repaint|peeling paint|chipping paint)\b/i] },
  { category: "painting", weight: 8, patterns: [/\b(wall|walls)\b/i, /\b(stain|scuff|mark|discolor)\b/i] },

  // Flooring
  { category: "flooring", weight: 10, patterns: [/\b(floor|flooring|tile|tiles|carpet|hardwood|laminate|vinyl)\b/i, /\b(damage|damaged|loose|broken|torn|buckled|warped|scratched|cracked|stained)\b/i] },

  // Landscaping
  { category: "landscaping", weight: 10, patterns: [/\b(landscaping|lawn|grass|tree|trees|bush|bushes|garden|yard|sprinkler|irrigation)\b/i] },
];

/**
 * Classify the issue from the tenant's description using keyword rules.
 * Returns null if no rules match with sufficient confidence.
 */
function classifyByKeywords(text: string): ClassificationResult | null {
  const scores: Partial<Record<IssueCategory, number>> = {};

  for (const rule of KEYWORD_RULES) {
    const allMatch = rule.patterns.every((p) => p.test(text));
    if (allMatch) {
      scores[rule.category] = Math.max(scores[rule.category] ?? 0, rule.weight);
    }
  }

  const entries = Object.entries(scores) as [IssueCategory, number][];
  if (entries.length === 0) return null;

  // Sort by score descending
  entries.sort((a, b) => b[1] - a[1]);
  const [topCategory, topScore] = entries[0];
  const secondScore = entries.length > 1 ? entries[1][1] : 0;

  // Confidence based on score and gap
  let confidence: "high" | "medium" | "low";
  if (topScore >= 9 && topScore - secondScore >= 2) {
    confidence = "high";
  } else if (topScore >= 7) {
    confidence = "medium";
  } else {
    confidence = "low";
  }

  return {
    category: topCategory,
    confidence,
    rationale: `keyword_match: ${topCategory} (score=${topScore}, gap=${topScore - secondScore})`,
  };
}

/**
 * Generate a clarifying question when classification confidence is low.
 * Instead of a numbered list, asks a short targeted question.
 */
export function buildClarifyingCategoryQuestion(
  description: string,
  topCandidates: IssueCategory[]
): string {
  if (topCandidates.length >= 2) {
    const formatted = topCandidates
      .slice(0, 3)
      .map((c) => c.replace(/_/g, " "))
      .join(", or ");
    return `Just to make sure I route this correctly -- would you describe this as a ${formatted} issue?`;
  }
  return "Could you tell me a bit more about what type of issue this is? For example, is it related to plumbing, electrical, heating/cooling, an appliance, or something else?";
}

/**
 * Classify an issue from the tenant's initial description.
 *
 * Uses deterministic keyword rules. Returns classification with confidence level.
 * The caller decides whether to auto-accept (high confidence) or ask a clarifying
 * question (low/medium confidence).
 */
export function classifyIssue(description: string): ClassificationResult {
  const keywordResult = classifyByKeywords(description);

  if (keywordResult) {
    return keywordResult;
  }

  // No keyword match at all — default to general with low confidence
  return {
    category: "general",
    confidence: "low",
    rationale: "no_keyword_match",
  };
}

/**
 * Parse a clarifying response from the user into a category.
 * More flexible than the old numbered-list approach.
 */
export function parseClarifyingResponse(
  response: string,
  previousClassification: ClassificationResult
): ClassificationResult {
  // First try keyword classification on the response
  const fromResponse = classifyByKeywords(response);
  if (fromResponse && fromResponse.confidence !== "low") {
    return {
      ...fromResponse,
      confidence: "high",
      rationale: `clarified_by_user: ${fromResponse.rationale}`,
    };
  }

  // Try direct category name match
  const lower = response.trim().toLowerCase();
  const directMatch = CATEGORY_OPTIONS.find(
    (c) => c === lower || c.replace("_", " ") === lower
  );
  if (directMatch) {
    return {
      category: directMatch,
      confidence: "high",
      rationale: `direct_match: ${directMatch}`,
    };
  }

  // Affirmative response to clarifying question — keep previous classification
  if (/\b(yes|yeah|yep|correct|right|that's right|exactly)\b/i.test(lower)) {
    return {
      ...previousClassification,
      confidence: "high",
      rationale: `user_confirmed: ${previousClassification.category}`,
    };
  }

  // Fall back: re-classify combining original description context
  return {
    ...previousClassification,
    confidence: "medium",
    rationale: `kept_previous: ${previousClassification.rationale}`,
  };
}

// ── Pest subcategory classification ──

export interface PestClassification {
  group: "insects" | "rodents";
  species: string;
}

const PEST_SPECIES: Array<{ species: string; group: "insects" | "rodents"; pattern: RegExp }> = [
  { species: "ants", group: "insects", pattern: /\b(ant|ants)\b/i },
  { species: "cockroaches", group: "insects", pattern: /\b(cockroach|cockroaches|roach|roaches)\b/i },
  { species: "bedbugs", group: "insects", pattern: /\b(bed\s*bug|bed\s*bugs|bedbug|bedbugs)\b/i },
  { species: "termites", group: "insects", pattern: /\b(termite|termites)\b/i },
  { species: "rats", group: "rodents", pattern: /\b(rat|rats)\b/i },
  { species: "mice", group: "rodents", pattern: /\b(mice|mouse)\b/i },
];

/**
 * Classify pest subcategory from text.
 * Returns null if no specific pest identified (generic "bug"/"pest").
 */
export function classifyPest(text: string): PestClassification | null {
  for (const { species, group, pattern } of PEST_SPECIES) {
    if (pattern.test(text)) {
      return { group, species };
    }
  }
  return null;
}

// ── Mold subcategory classification ──

/**
 * Classify mold subcategory from text.
 * Returns null if no mold-related term is found.
 */
export function classifyMold(text: string): string | null {
  if (/\b(mold|moldy|mouldy|mildew)\b/i.test(text)) return "mold";
  if (/\b(fungus|fungi)\b/i.test(text)) return "fungus";
  if (/\b(musty)\b/i.test(text)) return "musty";
  return null;
}

// ── Plumbing subcategory classification ──

/**
 * Classify plumbing problem type from text.
 * Returns null if no specific problem type identified.
 *
 * Order matters — specific compound patterns first, then general problem
 * types, with broken_fixture last as catch-all for fixture issues.
 */
export function classifyPlumbing(text: string): string | null {
  // running_toilet: compound — "toilet" + running/flushing indicator
  if (/\b(toilet)\b/i.test(text) && /\b(running|runs|ghost\s+flush(?:ing)?|keeps?\s+flushing|won't stop|flushing\s+(?:by\s+itself|on\s+its\s+own))\b/i.test(text)) return "running_toilet";
  // no_hot_water: hot water problems, water heater, cold-only, lukewarm
  if (/\b(no hot water|water heater|cold water only|lukewarm)\b/i.test(text)) return "no_hot_water";
  if (/\b(hot water)\b/i.test(text) && /\b(isn't|not|won't|stopped|doesn't|runs?\s+out)\b/i.test(text)) return "no_hot_water";
  if (/\b(only|just|nothing but)\b/i.test(text) && /\b(cold water)\b/i.test(text)) return "no_hot_water";
  // water_pressure: pressure/flow problems
  if (/\b(low\s+(?:water\s+)?pressure|no pressure|weak\s+(?:water\s+)?flow|no water|barely\s+(?:any\s+)?(?:water|flow|comes?\s+out|trickle))\b/i.test(text)) return "water_pressure";
  if (/\b(water pressure)\b/i.test(text) && /\b(low|weak|poor|no|barely|bad)\b/i.test(text)) return "water_pressure";
  // clog: blockage, overflow, won't drain
  if (/\b(clog|clogged|backed\s+up|backup|backing\s+up|blocked|slow drain|plugged|overflow|overflowing)\b/i.test(text)) return "clog";
  if (/\b(drain)\b/i.test(text) && /\b(slow|won't|can't|not|isn't|blocked|standing)\b/i.test(text)) return "clog";
  if (/\b(standing\s+water|water\s+standing)\b/i.test(text)) return "clog";
  // leak: water escape, drips, flooding, burst, puddle
  if (/\b(leak|leaking|leaky|drip|dripping|drips|flood|flooding|flooded|burst|puddle)\b/i.test(text)) return "leak";
  if (/\b(water\s+coming\s+from)\b/i.test(text)) return "leak";
  // broken_fixture: mechanical failure (catch-all for fixture issues)
  if (/\b(broken|snapped|cracked|handle|knob|stuck|jammed|won't flush|not flushing|won't turn)\b/i.test(text)) return "broken_fixture";
  return null;
}

// ── Structural subcategory classification ──

/**
 * Classify structural subcategory from text.
 * Returns "window" if the text mentions window/screen keywords, null otherwise.
 */
export function classifyStructural(text: string): string | null {
  if (/\b(window|windows|screen|screens)\b/i.test(text)) return "window";
  return null;
}

export { CATEGORY_OPTIONS };
