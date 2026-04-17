/**
 * Validation loop — Pure tests.
 *
 * Tests validateGroundedResult() across all branching paths:
 * - valid grounded output with citations + good scores
 * - missing citations when snippets exist
 * - emergency without safety guidance
 * - low retrieval confidence scores
 * - zero-step grounding output
 * - fallback path (no snippets)
 */

import {
  createRunner,
  printSection,
  type TestResult,
} from "./helpers";
import { validateGroundedResult } from "../../src/lib/triage/validate";
import type { GatheredInfo } from "../../src/lib/triage/types";
import type { GroundedResult } from "../../src/lib/triage/grounding";
import type { RetrievalSnippet } from "../../src/lib/retrieval/types";

// ── Test data factories ──

function makeGathered(overrides: Partial<GatheredInfo> = {}): GatheredInfo {
  return {
    category: "plumbing",
    location_in_unit: "kitchen",
    started_when: "today",
    is_emergency: false,
    current_status: "still leaking",
    brand_model: null,
    subcategory: null,
    entry_point: null,
    equipment: null,
    ...overrides,
  };
}

function makeSnippets(count: number): RetrievalSnippet[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `sop-${i + 1}`,
    score: 0.55,
    title: `SOP ${i + 1}`,
    content: `Step content for SOP ${i + 1}`,
    metadata: { category: "plumbing" },
  }));
}

function makeGroundedResult(overrides: Partial<GroundedResult> = {}): GroundedResult {
  return {
    reply: "1. Turn off the valve [SOP-1]\n2. Place bucket under leak [SOP-2]\n\nSources:\n[SOP-1] \"SOP 1\"\n[SOP-2] \"SOP 2\"",
    steps: [
      { step: 1, description: "Turn off the valve [SOP-1]", completed: false },
      { step: 2, description: "Place bucket under leak [SOP-2]", completed: false },
    ],
    usedFallback: false,
    ...overrides,
  };
}

// ── Tests ──

export function testValidateGroundedResult(): TestResult {
  printSection("Validation Loop — validateGroundedResult");
  const { pass, fail, result } = createRunner();

  // ══════════════════════════════════════════════════════
  // 1. Valid: citations present + good scores + no emergency
  // ══════════════════════════════════════════════════════
  try {
    const v = validateGroundedResult(
      makeGroundedResult(),
      makeSnippets(2),
      makeGathered(),
      0.55,
      0.52
    );
    if (v.is_valid) {
      pass("Valid: grounded output with citations + good scores => valid");
    } else {
      fail("Valid: expected is_valid=true", v.reasons);
    }
    if (!v.missing_citations) {
      pass("Valid: missing_citations=false");
    } else {
      fail("Valid: expected missing_citations=false");
    }
    if (!v.low_confidence) {
      pass("Valid: low_confidence=false");
    } else {
      fail("Valid: expected low_confidence=false");
    }
    if (!v.missing_safety_guidance) {
      pass("Valid: missing_safety_guidance=false");
    } else {
      fail("Valid: expected missing_safety_guidance=false");
    }
    if (v.reasons.length === 0) {
      pass("Valid: no reasons");
    } else {
      fail("Valid: expected empty reasons", v.reasons);
    }
  } catch (e) {
    fail("Valid case threw", e);
  }

  // ══════════════════════════════════════════════════════
  // 2. Missing citations: snippets provided but no [SOP-N]
  // ══════════════════════════════════════════════════════
  try {
    const noCiteResult = makeGroundedResult({
      reply: "1. Turn off the valve\n2. Place bucket under leak",
      steps: [
        { step: 1, description: "Turn off the valve", completed: false },
        { step: 2, description: "Place bucket under leak", completed: false },
      ],
    });
    const v = validateGroundedResult(
      noCiteResult,
      makeSnippets(2),
      makeGathered(),
      0.55,
      0.52
    );
    if (!v.is_valid) {
      pass("Missing citations: invalid when snippets exist but no citations");
    } else {
      fail("Missing citations: expected is_valid=false");
    }
    if (v.missing_citations) {
      pass("Missing citations: missing_citations=true");
    } else {
      fail("Missing citations: expected missing_citations=true");
    }
    if (v.reasons.some((r) => r.includes("no_citations"))) {
      pass("Missing citations: reason recorded");
    } else {
      fail("Missing citations: expected citation reason", v.reasons);
    }
  } catch (e) {
    fail("Missing citations case threw", e);
  }

  // ══════════════════════════════════════════════════════
  // 3. Fallback: no snippets + fallback path = valid (no citation check)
  // ══════════════════════════════════════════════════════
  try {
    const fallbackResult = makeGroundedResult({
      reply: "1. General step\n2. Take a photo",
      steps: [
        { step: 1, description: "General step", completed: false },
        { step: 2, description: "Take a photo", completed: false },
      ],
      usedFallback: true,
    });
    const v = validateGroundedResult(
      fallbackResult,
      [],           // no snippets
      makeGathered(),
      0,            // no scores
      0
    );
    if (v.is_valid) {
      pass("Fallback: valid when no snippets and using fallback");
    } else {
      fail("Fallback: expected is_valid=true", v.reasons);
    }
    if (!v.missing_citations) {
      pass("Fallback: missing_citations=false (no snippets to cite)");
    } else {
      fail("Fallback: expected missing_citations=false");
    }
  } catch (e) {
    fail("Fallback case threw", e);
  }

  // ══════════════════════════════════════════════════════
  // 4. Emergency without safety guidance
  // ══════════════════════════════════════════════════════
  try {
    const noSafetyResult = makeGroundedResult({
      reply: "1. Check the thermostat [SOP-1]",
      steps: [{ step: 1, description: "Check the thermostat [SOP-1]", completed: false }],
    });
    const v = validateGroundedResult(
      noSafetyResult,
      makeSnippets(1),
      makeGathered({ is_emergency: true }),
      0.55,
      0.52
    );
    if (!v.is_valid) {
      pass("Emergency no safety: invalid");
    } else {
      fail("Emergency no safety: expected is_valid=false");
    }
    if (v.missing_safety_guidance) {
      pass("Emergency no safety: missing_safety_guidance=true");
    } else {
      fail("Emergency no safety: expected missing_safety_guidance=true");
    }
  } catch (e) {
    fail("Emergency no safety case threw", e);
  }

  // ══════════════════════════════════════════════════════
  // 5. Emergency WITH safety guidance => valid
  // ══════════════════════════════════════════════════════
  try {
    const safeResult = makeGroundedResult({
      reply: "**SAFETY ALERT**: call 911 if in immediate danger.\n\n1. Check the valve [SOP-1]",
      steps: [{ step: 1, description: "Check the valve [SOP-1]", completed: false }],
    });
    const v = validateGroundedResult(
      safeResult,
      makeSnippets(1),
      makeGathered({ is_emergency: true }),
      0.55,
      0.52
    );
    if (v.is_valid) {
      pass("Emergency with safety: valid");
    } else {
      fail("Emergency with safety: expected is_valid=true", v.reasons);
    }
    if (!v.missing_safety_guidance) {
      pass("Emergency with safety: missing_safety_guidance=false");
    } else {
      fail("Emergency with safety: expected missing_safety_guidance=false");
    }
  } catch (e) {
    fail("Emergency with safety case threw", e);
  }

  // ══════════════════════════════════════════════════════
  // 6. Low confidence: scores below thresholds
  // ══════════════════════════════════════════════════════
  try {
    const v = validateGroundedResult(
      makeGroundedResult(),
      makeSnippets(2),
      makeGathered(),
      0.30,  // below 0.45 threshold
      0.25   // below 0.40 threshold
    );
    if (!v.is_valid) {
      pass("Low confidence: invalid with low scores");
    } else {
      fail("Low confidence: expected is_valid=false");
    }
    if (v.low_confidence) {
      pass("Low confidence: low_confidence=true");
    } else {
      fail("Low confidence: expected low_confidence=true");
    }
    if (v.reasons.some((r) => r.includes("scores_below_threshold"))) {
      pass("Low confidence: reason includes score details");
    } else {
      fail("Low confidence: expected score reason", v.reasons);
    }
  } catch (e) {
    fail("Low confidence case threw", e);
  }

  // ══════════════════════════════════════════════════════
  // 7. Low confidence not triggered for fallback results
  // ══════════════════════════════════════════════════════
  try {
    const fallbackResult = makeGroundedResult({ usedFallback: true });
    const v = validateGroundedResult(
      fallbackResult,
      makeSnippets(1),
      makeGathered(),
      0.30,
      0.25
    );
    if (!v.low_confidence) {
      pass("Fallback bypass: low_confidence=false when usedFallback=true");
    } else {
      fail("Fallback bypass: expected low_confidence=false");
    }
  } catch (e) {
    fail("Fallback bypass case threw", e);
  }

  // ══════════════════════════════════════════════════════
  // 8. Zero parseable steps with snippets
  // ══════════════════════════════════════════════════════
  try {
    const emptyStepsResult = makeGroundedResult({
      reply: "We don't have specific guidance [SOP-1]",
      steps: [],
    });
    const v = validateGroundedResult(
      emptyStepsResult,
      makeSnippets(1),
      makeGathered(),
      0.55,
      0.52
    );
    if (!v.is_valid) {
      pass("Zero steps: invalid when snippets exist but no steps parsed");
    } else {
      fail("Zero steps: expected is_valid=false");
    }
    if (v.reasons.some((r) => r.includes("zero_parseable_steps"))) {
      pass("Zero steps: reason recorded");
    } else {
      fail("Zero steps: expected zero_steps reason", v.reasons);
    }
  } catch (e) {
    fail("Zero steps case threw", e);
  }

  // ══════════════════════════════════════════════════════
  // 9. Scores stored in result
  // ══════════════════════════════════════════════════════
  try {
    const v = validateGroundedResult(
      makeGroundedResult(),
      makeSnippets(1),
      makeGathered(),
      0.55,
      0.52
    );
    if (v.highest_score === 0.55) {
      pass("Scores stored: highest_score=0.55");
    } else {
      fail("Scores stored: wrong highest_score", v.highest_score);
    }
    if (v.average_score === 0.52) {
      pass("Scores stored: average_score=0.52");
    } else {
      fail("Scores stored: wrong average_score", v.average_score);
    }
  } catch (e) {
    fail("Scores stored case threw", e);
  }

  // ══════════════════════════════════════════════════════
  // 10. action_taken defaults to "none"
  // ══════════════════════════════════════════════════════
  try {
    const v = validateGroundedResult(
      makeGroundedResult(),
      makeSnippets(1),
      makeGathered(),
      0.55,
      0.52
    );
    if (v.action_taken === "none") {
      pass("action_taken: defaults to 'none'");
    } else {
      fail("action_taken: expected 'none'", v.action_taken);
    }
  } catch (e) {
    fail("action_taken case threw", e);
  }

  return result;
}

// Allow standalone execution
if (require.main === module) {
  const { runStandalone } = require("./helpers");
  runStandalone(testValidateGroundedResult);
}
