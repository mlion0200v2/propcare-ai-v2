/**
 * Phase 2B — Grounded troubleshooting step generation.
 *
 * Uses OpenAI chat completion to generate tenant-safe steps
 * from retrieved SOP snippets with [SOP-N] citations.
 * Falls back to getFallbackSOP() when retrieval is empty or low-confidence.
 *
 * Output is conversational — friendly intro, grouped steps in plain language.
 */

import OpenAI from "openai";
import type { GatheredInfo, TroubleshootingStep, GuidedStep, GuidedStepKind } from "./types";
import type { RetrievalSnippet } from "../retrieval/types";
import { getFallbackSOP } from "./sop-fallback";
import { getEquipmentAliases, ALL_APPLIANCE_NAMES } from "./extract-details";

const WEB_SEARCH_SYSTEM_PROMPT = `You are a friendly property maintenance assistant helping a tenant troubleshoot an issue in their rental unit. Search the web for practical advice, then generate 3-6 safe, tenant-appropriate troubleshooting steps.

Rules:
- Steps must be safe for a non-professional (no electrical work, gas line work, or structural repairs)
- Write in a warm, conversational tone
- Return ONLY the numbered steps, one per line
- Always end with a note that the property manager has been notified
- Focus on apartment/rental maintenance — not homeowner DIY`;

const SYSTEM_PROMPT = `You are a friendly property maintenance assistant helping a tenant. Generate 3-6 practical troubleshooting steps based ONLY on the retrieved SOP snippets below.

Rules:
- Use ONLY information from the provided snippets
- Cite each step using [SOP-N] format matching the snippet number
- Do NOT invent, assume, or add information not in the snippets
- Keep steps simple, safe, and tenant-appropriate (no professional-level repairs)
- Write in a warm, conversational tone — like a helpful neighbor explaining what to try
- Return ONLY the numbered steps, one per line, with citations
- Always end with a note that the property manager has been notified and will follow up

Equipment-specific rules:
- Focus steps on the specific equipment type mentioned — do NOT include steps for unrelated appliances
- If the issue is about a range hood, do NOT include refrigerator, dishwasher, or oven checks

Pest-specific rules:
- NEVER mix insect guidance with rodent guidance — match advice to the specific pest type
- For insects: recommend bait traps, sanitation — NOT snap traps
- For rodents: recommend snap traps along walls — NOT insect bait or spray
- Do NOT ask tenants to seal holes, caulk gaps, or perform repairs — note these for the property manager instead
- If an entry point has been reported, note it for the property manager but do NOT ask the tenant to seal it`;

// Emergency safety text (prepended BEFORE grounded steps)
const EMERGENCY_SAFETY_LINES = [
  "**SAFETY ALERT**: Your issue has been flagged as a potential emergency.",
  "",
  "**IMMEDIATE ACTIONS:**",
  "1. If you smell gas, leave the unit immediately and contact the FortisBC gas emergency line.",
  "2. If there's flooding, turn off the main water valve if it is safe to do so.",
  "3. If there's a fire or smoke, evacuate and call 911.",
  "4. Do NOT re-enter the unit until cleared by emergency services or your property manager.",
  "",
  "Your ticket has been escalated to your property manager for urgent review. The property manager should contact you within 2 hours.",
  "",
  "---",
  "",
];

export interface GroundedResult {
  reply: string;
  steps: TroubleshootingStep[];
  usedFallback: boolean;
  usedWebSearch?: boolean;
}

/**
 * Format troubleshooting steps conversationally.
 * Strips raw citation tokens and media request steps from user-facing text.
 */
function formatConversationalTroubleshooting(
  stepsText: string,
  sourcesFooter: string,
  isEmergency: boolean
): string {
  const replyParts: string[] = [];

  if (isEmergency) {
    replyParts.push(...EMERGENCY_SAFETY_LINES);
    replyParts.push(
      "In the meantime, here are some things that may help:",
      ""
    );
  } else {
    replyParts.push(
      "Let's try a couple quick things that may help while your property manager reviews this.",
      ""
    );
  }

  // Strip citation tokens and duplicate media requests from step text
  const cleanSteps = filterMediaStepLines(stripCitations(stepsText));
  replyParts.push(cleanSteps);
  replyParts.push(sourcesFooter);
  replyParts.push(
    "",
    "Your ticket has been submitted and your property manager will follow up. Let us know if anything changes in the meantime."
  );

  return replyParts.join("\n");
}

/**
 * Filter out numbered step lines about taking/sending photos/videos.
 * Used to avoid duplicate media requests (tenant already passed through AWAITING_MEDIA).
 */
export function filterMediaStepLines(text: string): string {
  return text
    .split("\n")
    .filter((line) => {
      const stripped = line.replace(/^\d+[\.\)]\s*/, "").trim();
      if (!stripped) return true; // keep blank lines
      const hasMediaAction = /\b(take|send|upload|attach)\b/i.test(stripped);
      const hasMediaNoun = /\b(photo|picture|image|video)\b/i.test(stripped);
      return !(hasMediaAction && hasMediaNoun);
    })
    .join("\n");
}

/**
 * Format fallback steps conversationally.
 * Filters out media request steps (tenant already passed through AWAITING_MEDIA).
 */
function formatConversationalFallback(
  sopDisplay: string,
  isEmergency: boolean
): string {
  const replyParts: string[] = [];

  if (isEmergency) {
    replyParts.push(...EMERGENCY_SAFETY_LINES);
    replyParts.push(
      "In the meantime, here are some general steps that may help:",
      ""
    );
  } else {
    replyParts.push(
      "Let's try a couple quick things that may help while your property manager reviews this.",
      ""
    );
  }

  // Filter out duplicate media request steps
  replyParts.push(filterMediaStepLines(sopDisplay));

  replyParts.push(
    "",
    "Your ticket has been submitted and your property manager will follow up. Let us know if anything changes in the meantime."
  );

  return replyParts.join("\n");
}

/**
 * Generate troubleshooting steps using OpenAI web search.
 * Used as a fallback when Pinecone retrieval returns no results or low confidence.
 * Returns null if the call fails or returns no parseable steps.
 */
export async function generateWebSearchSteps(
  gathered: GatheredInfo,
  isEmergency: boolean
): Promise<GroundedResult | null> {
  const category = gathered.category ?? "general";

  const userPrompt = [
    `Category: ${category}`,
    gathered.subcategory ? `Subcategory: ${gathered.subcategory}` : null,
    `Location: ${gathered.location_in_unit ?? "unknown"}`,
    `Issue status: ${gathered.current_status ?? "unknown"}`,
    gathered.equipment ? `Equipment type: ${gathered.equipment}` : null,
    gathered.brand_model ? `Brand/model: ${gathered.brand_model}` : null,
    "",
    "Please search for practical troubleshooting advice for this rental maintenance issue and provide numbered steps.",
  ]
    .filter((line) => line !== null)
    .join("\n");

  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.2,
      max_tokens: 600,
      web_search_options: { search_context_size: "low" },
      messages: [
        { role: "system", content: WEB_SEARCH_SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
    });

    const stepsText = completion.choices[0]?.message?.content?.trim() ?? "";

    const stepLines = stepsText
      .split("\n")
      .filter((line) => /^\d+[\.\)]/.test(line.trim()));

    if (stepLines.length === 0) return null;

    const steps: TroubleshootingStep[] = stepLines.map((line, i) => ({
      step: i + 1,
      description: line.replace(/^\d+[\.\)]\s*/, "").trim(),
      completed: false,
    }));

    const reply = formatConversationalFallback(
      stepLines.join("\n"),
      isEmergency
    );

    return {
      reply,
      steps,
      usedFallback: false,
      usedWebSearch: true,
    };
  } catch (err) {
    console.error("[grounding] web search fallback failed:", err);
    return null;
  }
}

/**
 * Generate grounded troubleshooting steps from retrieved snippets.
 *
 * If snippets are empty or low-confidence, falls back to hardcoded SOP.
 * If emergency, safety guidance is prepended BEFORE any steps.
 */
export async function generateGroundedSteps(
  gathered: GatheredInfo,
  snippets: RetrievalSnippet[],
  isEmergency: boolean,
  lowConfidence: boolean
): Promise<GroundedResult> {
  const category = gathered.category ?? "general";

  // Fallback path: no snippets or low confidence
  if (snippets.length === 0 || lowConfidence) {
    // Try web search before falling back to hardcoded SOP
    const webResult = await generateWebSearchSteps(gathered, isEmergency);
    if (webResult) return webResult;

    // Web search failed or returned nothing — use hardcoded SOP
    const sop = getFallbackSOP(category, isEmergency, gathered.subcategory, gathered.equipment);

    return {
      reply: formatConversationalFallback(sop.display, isEmergency),
      steps: sop.steps,
      usedFallback: true,
    };
  }

  // Build snippet context for the LLM
  const snippetContext = snippets
    .map(
      (s, i) =>
        `[SOP-${i + 1}] "${s.title}" (score: ${s.score.toFixed(2)})\n${s.content}`
    )
    .join("\n\n");

  const userPrompt = [
    `Category: ${category}`,
    gathered.subcategory ? `Pest type: ${gathered.subcategory}` : null,
    `Location: ${gathered.location_in_unit ?? "unknown"}`,
    `Issue status: ${gathered.current_status ?? "unknown"}`,
    gathered.equipment ? `Equipment type: ${gathered.equipment}` : null,
    gathered.brand_model ? `Brand/model: ${gathered.brand_model}` : null,
    gathered.entry_point ? `Entry point reported: ${gathered.entry_point}` : null,
    "",
    "Retrieved SOP snippets:",
    snippetContext,
  ]
    .filter((line) => line !== null)
    .join("\n");

  // Call OpenAI
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.2,
    max_tokens: 600,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
  });

  const stepsText = completion.choices[0]?.message?.content?.trim() ?? "";

  // Parse numbered steps from LLM output
  const stepLines = stepsText
    .split("\n")
    .filter((line) => /^\d+[\.\)]/.test(line.trim()));

  const steps: TroubleshootingStep[] = stepLines.map((line, i) => ({
    step: i + 1,
    description: line.replace(/^\d+[\.\)]\s*/, "").trim(),
    completed: false,
  }));

  // Build sources footer
  const sourcesFooter = [
    "",
    "Sources:",
    ...snippets.map(
      (s, i) => `[SOP-${i + 1}] "${s.title}" (score: ${s.score.toFixed(2)})`
    ),
  ].join("\n");

  return {
    reply: formatConversationalTroubleshooting(stepsText, sourcesFooter, isEmergency),
    steps:
      steps.length > 0
        ? steps
        : // Fallback if LLM output couldn't be parsed
          getFallbackSOP(category, isEmergency, gathered.subcategory, gathered.equipment).steps,
    usedFallback: false,
  };
}

// ── Heuristic keyword sets for guided step enrichment ──

const VALVE_SHUTOFF_KEYWORDS = [
  /\b(shut[- ]?off|shut off|turn off|close)\b/i,
  /\b(valve|main|supply|water main)\b/i,
];

const LEAK_CRITICAL_KEYWORDS = [
  /\b(leak|leaking|drip|dripping|water damage|burst|rupture)\b/i,
  /\b(pipe|joint|fitting|connection|seal)\b/i,
];

const MEDIA_REQUEST_KEYWORDS = [
  /\b(photo|picture|image|video|record|show|document)\b/i,
  /\b(take a|send a|upload|attach)\b/i,
];

// ── Step kind detection ──

const OBSERVATION_KEYWORDS = [
  /\b(check|see|observe|look|verify|confirm|monitor|watch)\b.*\b(if|whether)\b/i,
  /\b(whether|if)\b.*\b(stop|slow|change|still|continu)\b/i,
  /\b(tell me|let me know)\b.*\b(whether|if|stop|slow)\b/i,
];

const TERMINAL_KEYWORDS = [
  /\b(avoid|don'?t use|do not use|refrain|please don'?t|stay away)\b/i,
  /\b(until (maintenance|repair|a (plumber|technician|professional)|someone))\b/i,
  /\b(do not attempt|leave it|don'?t touch)\b/i,
];

// Steps that are inappropriate for tenants — reclassified to "terminal" so they
// appear only in the PM completion summary, not as interactive guided steps.
const TENANT_INAPPROPRIATE_KEYWORDS = [
  /\b(seal|caulk|caulking)\b.*\b(gaps?|holes?|cracks?|openings?|pipes?|baseboards?|doorframes?|windows?)\b/i,
  /\b(gaps?|holes?|cracks?|openings?)\b.*\b(seal|caulk|caulking)\b/i,
  /\b(repair|fix|replace|install|disassembl|reassembl)\b/i,
  /\b(steel wool)\b/i,
  /\bconsider sealing\b/i,
];

// Steps that are info-gathering meta-prompts, not real troubleshooting.
// These duplicate already-collected info and should not trigger guided mode.
const INFO_GATHERING_KEYWORDS = [
  /^describe (the|your) (issue|problem)\b/i,
  /^note (when|where|what)\b/i,
  /^take photos?\b/i,
  /\bproperty manager will (review|determine|assess|assign)\b/i,
  /\byou'?re unsure of the category\b/i,
];

function detectStepKind(desc: string): GuidedStepKind {
  if (MEDIA_REQUEST_KEYWORDS.some((p) => p.test(desc))) return "media_request";
  if (TERMINAL_KEYWORDS.some((p) => p.test(desc))) return "terminal";
  if (TENANT_INAPPROPRIATE_KEYWORDS.some((p) => p.test(desc))) return "terminal";
  if (INFO_GATHERING_KEYWORDS.some((p) => p.test(desc))) return "terminal";
  if (OBSERVATION_KEYWORDS.some((p) => p.test(desc))) return "observation";
  return "action";
}

/**
 * Determine whether troubleshooting steps should use guided (step-by-step) mode.
 *
 * Decision is SOP-driven, not category-driven:
 * - Needs at least one safe, actionable step (action or observation)
 * - Emergency issues skip guided mode (safety guidance is more important)
 * - Professional-only SOPs (all terminal steps) skip guided mode
 *
 * Works identically for grounded steps and fallback SOPs.
 */
export function shouldUseGuidedTroubleshooting(
  guidedSteps: GuidedStep[],
  isEmergency: boolean
): boolean {
  if (isEmergency) return false;
  if (guidedSteps.length === 0) return false;

  return guidedSteps.some(
    (s) => s.step_kind === "action" || s.step_kind === "observation"
  );
}

/**
 * Strip raw citation tokens from user-facing text.
 * Keeps citations in the structured citation field for audit/validation.
 * Safe for multi-line text — preserves newlines.
 */
export function stripCitations(text: string): string {
  return text
    .replace(/ *_?\(?\[SOP-\d+\]\)?_?/gi, "")
    .replace(/ *\[sop[_-]?\d+\]/gi, "")
    .replace(/ {2,}/g, " ")
    .trim();
}

/**
 * Convert grounded TroubleshootingStep[] into enriched GuidedStep[] for
 * step-by-step presentation. Extracts [SOP-N] citations, strips them from
 * user-facing description, detects step_kind, and sets dependency metadata.
 */
export function convertToGuidedSteps(
  steps: TroubleshootingStep[]
): GuidedStep[] {
  const result: GuidedStep[] = steps.map((s, i) => {
    const rawDesc = s.description;

    // Extract [SOP-N] citation before stripping
    const citationMatch = rawDesc.match(/\[SOP-\d+\]/);
    const citation = citationMatch ? citationMatch[0] : null;

    // Strip citations from user-facing description
    const desc = stripCitations(rawDesc);

    const stepKind = detectStepKind(desc);

    // Heuristic flags
    const stopIfUnsure =
      VALVE_SHUTOFF_KEYWORDS.some((p) => p.test(desc)) ||
      /\b(careful|caution|safely|safe to)\b/i.test(desc);

    const escalationIfFailed =
      LEAK_CRITICAL_KEYWORDS.every((p) => p.test(desc));

    const requestMediaAfter =
      MEDIA_REQUEST_KEYWORDS.some((p) => p.test(desc));

    return {
      index: i,
      description: desc,
      citation,
      step_kind: stepKind,
      depends_on: null as number | null,
      stop_if_unsure: stopIfUnsure,
      escalation_if_failed: escalationIfFailed,
      request_media_after: requestMediaAfter,
    };
  });

  // Set depends_on: observation steps depend on the most recent action step
  for (let i = 0; i < result.length; i++) {
    if (result[i].step_kind === "observation" && i > 0) {
      for (let j = i - 1; j >= 0; j--) {
        if (result[j].step_kind === "action") {
          result[i].depends_on = j;
          break;
        }
      }
    }
  }

  return result;
}

/**
 * Filter grounded steps to remove those mentioning unrelated appliances.
 *
 * Logic:
 * 1. If no equipment known or usedFallback → return unchanged
 * 2. Build alias pattern for current equipment
 * 3. For each step: if it mentions an appliance that does NOT match the alias → remove it
 * 4. Steps mentioning no specific appliance → keep (generic steps)
 * 5. If ALL steps filtered out → fall back to getFallbackSOP
 */
export function filterStepsByEquipment(
  result: GroundedResult,
  equipment: string | null,
  category: string,
  isEmergency: boolean,
  subcategory?: string | null
): GroundedResult {
  if (!equipment) {
    return result;
  }

  const aliases = getEquipmentAliases(equipment);
  if (!aliases) {
    return result; // Unknown equipment type — don't filter
  }

  // Build regex patterns
  const aliasPattern = new RegExp(
    `\\b(${aliases.map(escapeRegex).join("|")})\\b`,
    "i"
  );
  const anyAppliancePattern = new RegExp(
    `\\b(${ALL_APPLIANCE_NAMES.map(escapeRegex).join("|")})\\b`,
    "i"
  );

  const filteredSteps = result.steps.filter((step) => {
    const desc = step.description;
    const mentionsAnyAppliance = anyAppliancePattern.test(desc);

    if (!mentionsAnyAppliance) {
      return true; // Generic step — keep
    }

    // Step mentions an appliance: keep only if it matches our equipment
    return aliasPattern.test(desc);
  });

  if (filteredSteps.length === 0) {
    // All steps filtered out — fall back to equipment-specific SOP
    console.log("[filter] all steps filtered out for equipment:", equipment, "— using equipment-specific fallback");
    const sop = getFallbackSOP(category, isEmergency, subcategory, equipment);
    return {
      reply: sop.display,
      steps: sop.steps,
      usedFallback: true,
    };
  }

  // Re-number steps
  const renumbered = filteredSteps.map((step, i) => ({
    ...step,
    step: i + 1,
  }));

  return {
    ...result,
    steps: renumbered,
  };
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
