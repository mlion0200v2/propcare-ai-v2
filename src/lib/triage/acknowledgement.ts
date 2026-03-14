/**
 * Friendly acknowledgement for the initial issue report.
 *
 * Template-driven — no LLM calls. Generates a warm, empathetic
 * first response that reflects understanding of the issue.
 */

/**
 * Build a friendly acknowledgement message from the tenant's initial description.
 *
 * Extracts the core issue and generates a conversational response.
 * The follow-up question is appended by the caller.
 *
 * @param extras — optional pre-extracted timing and status to reflect in the acknowledgement
 */
export function buildAcknowledgement(
  description: string,
  extras?: { timing?: string | null; status?: string | null }
): string {
  const issuePhrase = extractIssuePhrase(description);

  // Build context suffix from extracted timing/status (e.g. " — started yesterday, still happening")
  const contextParts: string[] = [];
  if (extras?.timing) contextParts.push(`started ${extras.timing}`);
  if (extras?.status) contextParts.push(extras.status);
  const contextSuffix =
    contextParts.length > 0 ? ` — ${contextParts.join(", ")}` : "";

  if (issuePhrase) {
    return [
      `I'm sorry to hear that. It sounds like ${issuePhrase}${contextSuffix}.`,
      "",
      "Let me ask a couple quick questions so we can help faster.",
    ].join("\n");
  }

  return [
    `Thanks for letting us know about this.${contextSuffix ? ` Got it${contextSuffix}.` : ""} I want to make sure we get this handled for you.`,
    "",
    "Let me ask a couple quick questions so we can help faster.",
  ].join("\n");
}

// ── Issue phrase extraction (deterministic pattern matching) ──

interface ExtractionPattern {
  pattern: RegExp;
  template: (match: RegExpMatchArray) => string;
}

const EXTRACTION_PATTERNS: ExtractionPattern[] = [
  // "my X is leaking/broken/not working"
  {
    pattern: /\bmy\s+(\w[\w\s]{0,20}?)\s+is\s+(leaking|broken|not working|clogged|stuck|making noise|dripping|running|overflowing|buzzing|flickering)\b/i,
    template: (m) => `your ${m[1].trim()} is ${m[2].toLowerCase()}`,
  },
  // "the X is leaking/broken/etc"
  {
    pattern: /\bthe\s+(\w[\w\s]{0,20}?)\s+is\s+(leaking|broken|not working|clogged|stuck|making noise|dripping|running|overflowing|buzzing|flickering)\b/i,
    template: (m) => `your ${m[1].trim()} is ${m[2].toLowerCase()}`,
  },
  // "X leaking/dripping" (without "is")
  {
    pattern: /\b(\w[\w\s]{0,15}?)\s+(leaking|dripping|flooding|overflowing)\b/i,
    template: (m) => `you have a ${m[1].trim().toLowerCase()} that's ${m[2].toLowerCase()}`,
  },
  // "no X" (no heat, no hot water, no power)
  {
    pattern: /\b(no|don't have|lost)\s+(heat|hot water|power|electricity|water|ac|air conditioning|cooling)\b/i,
    template: (m) => `you have ${m[1].toLowerCase()} ${m[2].toLowerCase()}`,
  },
  // "X won't Y"
  {
    pattern: /\b(\w[\w\s]{0,15}?)\s+won'?t\s+(turn on|turn off|start|stop|close|open|flush|drain|work)\b/i,
    template: (m) => `your ${m[1].trim().toLowerCase()} won't ${m[2].toLowerCase()}`,
  },
  // "there is/are X" (there is a leak, there are ants)
  {
    pattern: /\bthere(?:'s| is| are)\s+(?:a\s+)?(\w[\w\s]{0,20}?)\s+(?:in|on|under|near|from)\b/i,
    template: (m) => `there's ${m[1].trim().toLowerCase()} in your unit`,
  },
  // "I see/found/noticed X"
  {
    pattern: /\bI\s+(?:see|found|noticed|have|got)\s+(?:a\s+)?(\w[\w\s]{0,25})\b/i,
    template: (m) => `you've noticed ${m[1].trim().toLowerCase()}`,
  },
];

function extractIssuePhrase(description: string): string | null {
  for (const { pattern, template } of EXTRACTION_PATTERNS) {
    const match = description.match(pattern);
    if (match) {
      const phrase = template(match);
      // Truncate if too long
      return phrase.length > 80 ? phrase.slice(0, 77) + "..." : phrase;
    }
  }
  return null;
}
