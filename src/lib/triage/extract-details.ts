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
