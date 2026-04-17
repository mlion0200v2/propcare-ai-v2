/**
 * Extract structured details from a free-text issue description.
 *
 * Deterministic keyword matching — no LLM calls.
 * Used on the initial issue message to pre-fill gathered fields
 * so the system doesn't ask redundant questions.
 */

// Sorted longest-first so "master bathroom" matches before "bathroom"
const LOCATION_KEYWORDS = [
  "master bathroom",
  "master bedroom",
  "guest bathroom",
  "guest bedroom",
  "utility room",
  "laundry room",
  "living room",
  "dining room",
  "front porch",
  "back porch",
  "front door",
  "back door",
  "bathroom",
  "basement",
  "bedroom",
  "kitchen",
  "hallway",
  "balcony",
  "laundry",
  "garage",
  "closet",
  "patio",
  "attic",
  "porch",
] as const;

/**
 * Extract a location from free text, or null if none found.
 *
 * Uses word-boundary-aware matching to avoid false positives
 * (e.g., "bathrobe" should not match "bath").
 */
export function extractLocation(text: string): string | null {
  const lower = text.toLowerCase();

  for (const loc of LOCATION_KEYWORDS) {
    // Use indexOf + boundary check for multi-word and single-word locations
    const idx = lower.indexOf(loc);
    if (idx === -1) continue;

    // Check word boundaries (space, start/end, punctuation)
    const before = idx === 0 || /[\s,.'"\-!(]/.test(lower[idx - 1]);
    const afterIdx = idx + loc.length;
    const after =
      afterIdx >= lower.length || /[\s,.'"\-!)?]/.test(lower[afterIdx]);

    if (before && after) {
      return loc;
    }
  }

  return null;
}

// ── Timing extraction ──

// Sorted longest-first so "a couple of weeks ago" matches before "a week ago"
const TIMING_PHRASES = [
  "a couple of weeks ago",
  "a couple of days ago",
  "a few weeks ago",
  "a couple weeks ago",
  "a few days ago",
  "a couple days ago",
  "about a month ago",
  "about a week ago",
  "this afternoon",
  "earlier today",
  "this morning",
  "this evening",
  "last night",
  "last week",
  "last month",
  "a month ago",
  "a while ago",
  "a week ago",
  "yesterday",
  "recently",
  "tonight",
  "today",
] as const;

const TIMING_REGEX_PATTERNS: Array<{
  pattern: RegExp;
  extract: (m: RegExpMatchArray) => string;
}> = [
  // "since yesterday", "since last week", etc.
  {
    pattern:
      /\bsince\s+(yesterday|today|last\s+(?:night|week|month)|this\s+(?:morning|afternoon|evening)|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
    extract: (m) => `since ${m[1].toLowerCase()}`,
  },
  // "for a few days", "for weeks", "for a while", etc.
  {
    pattern:
      /\bfor\s+(a\s+(?:few|couple(?:\s+of)?)\s+(?:days|weeks|months)|several\s+(?:days|weeks|months)|weeks|months|days|a\s+while|about\s+a\s+(?:week|month)|a\s+(?:week|month|day|year))\b/i,
    extract: (m) => `for ${m[1].toLowerCase()}`,
  },
];

/**
 * Extract a timing phrase from free text, or null if none found.
 *
 * Matches common time references like "yesterday", "last week",
 * "since Monday", "for a few days", etc.
 */
export function extractTiming(text: string): string | null {
  const lower = text.toLowerCase();

  // Check regex patterns first — "since X" and "for X" are more specific
  // than bare keywords and should take priority (e.g. "since yesterday" > "yesterday")
  for (const { pattern, extract } of TIMING_REGEX_PATTERNS) {
    const match = text.match(pattern);
    if (match) return extract(match);
  }

  // Check exact keyword phrases (longest-first ordering)
  for (const phrase of TIMING_PHRASES) {
    const idx = lower.indexOf(phrase);
    if (idx === -1) continue;

    const before = idx === 0 || /[\s,.'"\-!(]/.test(lower[idx - 1]);
    const afterIdx = idx + phrase.length;
    const after =
      afterIdx >= lower.length || /[\s,.'"\-!)?]/.test(lower[afterIdx]);

    if (before && after) return phrase;
  }

  return null;
}

// ── Current status extraction ──

// Sorted longest-first
const STATUS_PHRASES = [
  "not working right now",
  "not working at all",
  "keeps coming back",
  "still going on",
  "still happening",
  "not going away",
  "getting worse",
  "getting louder",
  "getting bigger",
  "still leaking",
  "still dripping",
  "still running",
  "still broken",
  "comes and goes",
  "hasn't stopped",
  "coming back",
  "came back",
  "on and off",
  "intermittent",
  "recurring",
  "non-stop",
  "nonstop",
  "constant",
] as const;

/**
 * Extract a current-status phrase from free text, or null if none found.
 *
 * Matches phrases like "still happening", "comes and goes",
 * "getting worse", "intermittent", etc.
 */
export function extractCurrentStatus(text: string): string | null {
  const lower = text.toLowerCase();

  for (const phrase of STATUS_PHRASES) {
    const idx = lower.indexOf(phrase);
    if (idx === -1) continue;

    const before = idx === 0 || /[\s,.'"\-!(]/.test(lower[idx - 1]);
    const afterIdx = idx + phrase.length;
    const after =
      afterIdx >= lower.length || /[\s,.'"\-!)?]/.test(lower[afterIdx]);

    if (before && after) return phrase;
  }

  return null;
}

// ── Entry point extraction ──

const ENTRY_POINT_PATTERNS: Array<{
  pattern: RegExp;
  extract: (m: RegExpMatchArray) => string;
}> = [
  // "hole/gap/crack/opening under/in/near/behind X"
  {
    pattern: /\b(hole|gap|crack|opening)\s+(under|in|near|behind)\s+(the\s+)?(\w[\w\s]{0,30}?\w)\b/i,
    extract: (m) => `${m[1].toLowerCase()} ${m[2].toLowerCase()} ${m[3] ? "the " : ""}${m[4].toLowerCase()}`.trim(),
  },
  // "crack/gap in the wall/baseboard/floor/window/doorframe"
  {
    pattern: /\b(crack|gap)\s+in\s+the\s+(wall|baseboard|floor|window|doorframe|door\s*frame|ceiling)\b/i,
    extract: (m) => `${m[1].toLowerCase()} in the ${m[2].toLowerCase()}`,
  },
  // "coming/entering from/through X"
  {
    pattern: /\b(coming|entering)\s+(from|through)\s+(the\s+)?(\w[\w\s]{0,30}?\w)\b/i,
    extract: (m) => `entering from ${m[3] ? "the " : ""}${m[4].toLowerCase()}`.trim(),
  },
];

/**
 * Extract an entry point phrase from free text, or null if none found.
 *
 * Matches phrases like "hole under the carpet", "crack in the wall",
 * "coming from under the sink", etc.
 */
export function extractEntryPoint(text: string): string | null {
  for (const { pattern, extract } of ENTRY_POINT_PATTERNS) {
    const match = text.match(pattern);
    if (match) return extract(match);
  }
  return null;
}

// ── Equipment extraction ──

// Sorted longest-first so "range hood" matches before "range", etc.
const EQUIPMENT_KEYWORDS = [
  "washing machine",
  "range hood",
  "hood fan",
  "vent hood",
  "exhaust hood",
  "stove hood",
  "oven hood",
  "garbage disposal",
  "refrigerator",
  "dishwasher",
  "microwave",
  "freezer",
  "fridge",
  "furnace",
  "washer",
  "dryer",
  "stove",
  "range",
  "oven",
] as const;

/**
 * Extract an equipment type from free text, or null if none found.
 *
 * Uses word-boundary-aware matching (same pattern as extractLocation).
 * Normalizes aliases to canonical names (e.g., "fridge" → "refrigerator").
 */
export function extractEquipment(text: string): string | null {
  const lower = text.toLowerCase();

  for (const kw of EQUIPMENT_KEYWORDS) {
    const idx = lower.indexOf(kw);
    if (idx === -1) continue;

    const before = idx === 0 || /[\s,.'"\-!(]/.test(lower[idx - 1]);
    const afterIdx = idx + kw.length;
    const after =
      afterIdx >= lower.length || /[\s,.'"\-!)?]/.test(lower[afterIdx]);

    if (before && after) {
      return normalizeEquipment(kw);
    }
  }

  return null;
}

// ── Equipment alias normalization ──

const EQUIPMENT_ALIASES: Record<string, string> = {
  "hood fan": "range hood",
  "vent hood": "range hood",
  "exhaust hood": "range hood",
  "stove hood": "range hood",
  "oven hood": "range hood",
  "fridge": "refrigerator",
  "washing machine": "washer",
};

function normalizeEquipment(raw: string): string {
  return EQUIPMENT_ALIASES[raw] ?? raw;
}

// ── Equipment alias groups (for step filtering) ──

export const EQUIPMENT_ALIAS_GROUPS: Record<string, string[]> = {
  "range hood": ["range hood", "hood fan", "vent hood", "exhaust hood", "stove hood", "oven hood"],
  "refrigerator": ["refrigerator", "fridge", "freezer"],
  "dishwasher": ["dishwasher"],
  "oven": ["oven", "stove", "range"],
  "microwave": ["microwave"],
  "washer": ["washer", "washing machine"],
  "dryer": ["dryer"],
  "garbage disposal": ["garbage disposal"],
  "furnace": ["furnace"],
};

// All known appliance names (flattened from alias groups)
export const ALL_APPLIANCE_NAMES: string[] = Object.values(EQUIPMENT_ALIAS_GROUPS).flat();

/**
 * Resolve an equipment name to its canonical (EQUIPMENT_ALIAS_GROUPS key) form.
 * e.g. "stove" → "oven", "fridge" → "refrigerator", "oven" → "oven"
 * Returns the input unchanged if not found in any alias group.
 */
export function getCanonicalEquipment(equipment: string): string {
  if (EQUIPMENT_ALIAS_GROUPS[equipment]) return equipment;
  for (const [canonical, aliases] of Object.entries(EQUIPMENT_ALIAS_GROUPS)) {
    if (aliases.includes(equipment)) return canonical;
  }
  return equipment;
}

/**
 * Get the alias pattern (array of names) for a given equipment type.
 * Returns null if equipment is not a known appliance.
 */
export function getEquipmentAliases(equipment: string): string[] | null {
  // Direct match
  if (EQUIPMENT_ALIAS_GROUPS[equipment]) {
    return EQUIPMENT_ALIAS_GROUPS[equipment];
  }
  // Reverse lookup: find which group contains this equipment
  for (const [canonical, aliases] of Object.entries(EQUIPMENT_ALIAS_GROUPS)) {
    if (aliases.includes(equipment)) {
      return EQUIPMENT_ALIAS_GROUPS[canonical];
    }
  }
  return null;
}

// ── Equipment correction detection ──

const NEGATION_PATTERNS = [
  /\b(?:it'?s\s+)?not\s+(?:a\s+|the\s+)?(\w[\w\s]*?\w)\b/i,
  /\bthis\s+isn'?t\s+(?:a\s+|the\s+|about\s+the\s+)?(\w[\w\s]*?\w)\b/i,
  /\bnot\s+(?:a\s+|the\s+)?(\w[\w\s]*?\w)\s*[,;.!-]/i,
];

/**
 * Detect if the user is correcting the equipment type during guided troubleshooting.
 *
 * Matches patterns like:
 * - "it's not a refrigerator, it's a range hood"
 * - "this isn't about the oven"
 * - "not a dishwasher"
 *
 * Returns the corrected equipment if found in the rest of the message.
 */
export function detectEquipmentCorrection(
  message: string,
  currentEquipment: string | null
): { detected: boolean; equipment: string | null } {
  const lower = message.toLowerCase();

  // Check if message contains a negation of an appliance name
  let hasNegation = false;
  for (const pattern of NEGATION_PATTERNS) {
    const match = lower.match(pattern);
    if (match) {
      const negatedThing = match[1].trim();
      // Check if the negated thing is an appliance name
      if (ALL_APPLIANCE_NAMES.some((name) => negatedThing.includes(name))) {
        hasNegation = true;
        break;
      }
    }
  }

  if (!hasNegation) {
    return { detected: false, equipment: null };
  }

  // Try to extract the correct equipment from the full message
  // The user typically says "it's not X, it's Y" — extract Y
  const correctedEquipment = extractEquipment(
    // Remove the negation part to avoid re-matching the negated appliance
    lower.replace(/\b(?:it'?s\s+)?not\s+(?:a\s+|the\s+)?[\w\s]+?(?=[,;.!-]|$)/i, "")
  );

  if (correctedEquipment && correctedEquipment !== currentEquipment) {
    return { detected: true, equipment: correctedEquipment };
  }

  // Fallback: try full message — the correct equipment might still be extractable
  const fullExtract = extractEquipment(message);
  if (fullExtract && fullExtract !== currentEquipment) {
    return { detected: true, equipment: fullExtract };
  }

  return { detected: true, equipment: null };
}

// ── Appliance → Location inference ──

// Sorted longest-first so "washing machine" matches before "washer", etc.
const EQUIPMENT_LOCATION_MAP: Array<{ keywords: string[]; location: string }> = [
  {
    keywords: [
      "range hood", "garbage disposal", "stove", "oven", "range",
      "refrigerator", "fridge", "freezer", "dishwasher", "microwave",
    ],
    location: "kitchen",
  },
  {
    keywords: ["bathtub", "shower", "toilet"],
    location: "bathroom",
  },
  {
    keywords: ["washing machine", "washer", "dryer"],
    location: "laundry room",
  },
  {
    keywords: ["furnace"],
    location: "basement",
  },
];

// Pre-sorted longest-first for correct matching
const EQUIPMENT_LOCATION_ENTRIES: Array<{ keyword: string; location: string }> =
  EQUIPMENT_LOCATION_MAP.flatMap(({ keywords, location }) =>
    keywords.map((keyword) => ({ keyword, location }))
  ).sort((a, b) => b.keyword.length - a.keyword.length);

/**
 * Infer a location from appliance/fixture keywords in text.
 * e.g. "stove is not working" → "kitchen", "toilet handle is broken" → "bathroom"
 * Returns null if no appliance implies a location.
 */
export function inferLocationFromEquipment(text: string): string | null {
  const lower = text.toLowerCase();

  for (const { keyword, location } of EQUIPMENT_LOCATION_ENTRIES) {
    const idx = lower.indexOf(keyword);
    if (idx === -1) continue;

    const before = idx === 0 || /[\s,.'"\-!(]/.test(lower[idx - 1]);
    const afterIdx = idx + keyword.length;
    const after =
      afterIdx >= lower.length || /[\s,.'"\-!)?]/.test(lower[afterIdx]);

    if (before && after) return location;
  }

  return null;
}
