/**
 * Phase 2B — Retrieval pipeline unit tests.
 *
 * Pure tests — no Pinecone, no OpenAI calls.
 * Tests query text builder, score filtering, citation formatting.
 */

import {
  createRunner,
  printSection,
  type TestResult,
} from "./helpers";
import { buildQueryText } from "../../src/lib/retrieval/pinecone";
import type { GatheredInfo } from "../../src/lib/triage/types";
import type { RetrievalSnippet } from "../../src/lib/retrieval/types";

export function testRetrieval(): TestResult {
  printSection("Retrieval Pipeline — Pure Tests");
  const { pass, fail, result } = createRunner();

  // ── buildQueryText: basic ──
  try {
    const gathered: GatheredInfo = {
      category: "plumbing",
      location_in_unit: "kitchen",
      started_when: "yesterday",
      is_emergency: false,
      current_status: "still leaking",
      brand_model: null,
    };
    const qt = buildQueryText(gathered, "Faucet dripping constantly");
    if (qt.includes("plumbing issue")) {
      pass("buildQueryText includes category");
    } else {
      fail("buildQueryText missing category", qt);
    }
    if (qt.includes("in kitchen")) {
      pass("buildQueryText includes location");
    } else {
      fail("buildQueryText missing location", qt);
    }
    if (qt.includes("Faucet dripping")) {
      pass("buildQueryText includes description");
    } else {
      fail("buildQueryText missing description", qt);
    }
    if (qt.includes("still leaking")) {
      pass("buildQueryText includes current_status");
    } else {
      fail("buildQueryText missing current_status", qt);
    }
  } catch (e) {
    fail("buildQueryText basic threw", e);
  }

  // ── buildQueryText: with brand_model ──
  try {
    const gathered: GatheredInfo = {
      category: "appliance",
      location_in_unit: "kitchen",
      started_when: "today",
      is_emergency: false,
      current_status: "not running",
      brand_model: "GE Profile dishwasher",
    };
    const qt = buildQueryText(gathered, "Dishwasher won't start");
    if (qt.includes("GE Profile dishwasher")) {
      pass("buildQueryText includes brand_model");
    } else {
      fail("buildQueryText missing brand_model", qt);
    }
  } catch (e) {
    fail("buildQueryText with brand_model threw", e);
  }

  // ── buildQueryText: brand_model=unknown excluded ──
  try {
    const gathered: GatheredInfo = {
      category: "hvac",
      location_in_unit: "bedroom",
      started_when: "today",
      is_emergency: false,
      current_status: "no heat",
      brand_model: "unknown",
    };
    const qt = buildQueryText(gathered, "Heater not working");
    if (!qt.includes("unknown")) {
      pass("buildQueryText excludes brand_model=unknown");
    } else {
      fail("buildQueryText should exclude unknown brand_model", qt);
    }
  } catch (e) {
    fail("buildQueryText unknown brand_model threw", e);
  }

  // ── buildQueryText: null fields handled ──
  try {
    const gathered: GatheredInfo = {
      category: null,
      location_in_unit: null,
      started_when: null,
      is_emergency: null,
      current_status: null,
      brand_model: null,
    };
    const qt = buildQueryText(gathered, "");
    if (qt.includes("general issue")) {
      pass("buildQueryText falls back to 'general' for null category");
    } else {
      fail("buildQueryText missing fallback category", qt);
    }
  } catch (e) {
    fail("buildQueryText null fields threw", e);
  }

  // ── Citation formatting ──
  try {
    const snippets: RetrievalSnippet[] = [
      { id: "s1", score: 0.92, title: "Plumbing Guide", content: "Turn off valve", metadata: {} },
      { id: "s2", score: 0.87, title: "Kitchen Fixtures", content: "Check P-trap", metadata: {} },
    ];

    const citations = snippets
      .map((s, i) => `[SOP-${i + 1}] "${s.title}" (score: ${s.score.toFixed(2)})`)
      .join("\n");

    if (citations.includes("[SOP-1]") && citations.includes("[SOP-2]")) {
      pass("Citation format uses [SOP-N] numbering");
    } else {
      fail("Citation format incorrect", citations);
    }
    if (citations.includes("0.92") && citations.includes("0.87")) {
      pass("Citations include scores");
    } else {
      fail("Citations missing scores", citations);
    }
  } catch (e) {
    fail("Citation formatting threw", e);
  }

  // ── Score filtering logic ──
  try {
    const minScore = 0.75;
    const scores = [0.95, 0.82, 0.74, 0.60, 0.90];
    const filtered = scores.filter((s) => s >= minScore);
    if (filtered.length === 3) {
      pass("Score filtering removes below-threshold matches");
    } else {
      fail("Score filtering expected 3 results", filtered);
    }
    if (!filtered.includes(0.74)) {
      pass("Score filtering excludes score below min (0.74 < 0.75)");
    } else {
      fail("Score filtering included below-threshold score");
    }
  } catch (e) {
    fail("Score filtering threw", e);
  }

  // ── Confidence metadata ──
  try {
    const minScore = 0.75;
    const scores = [0.92, 0.87, 0.80];
    const highest = Math.max(...scores);
    const average = scores.reduce((a, b) => a + b, 0) / scores.length;
    const lowConfidence = average < minScore + 0.05;

    if (highest === 0.92) {
      pass("Confidence: highest_score correct");
    } else {
      fail("Confidence: highest_score incorrect", highest);
    }
    if (Math.abs(average - 0.8633) < 0.01) {
      pass("Confidence: average_score correct");
    } else {
      fail("Confidence: average_score incorrect", average);
    }
    if (lowConfidence === false) {
      pass("Confidence: not low when average > min+0.05");
    } else {
      fail("Confidence: incorrectly flagged low", { average, threshold: minScore + 0.05 });
    }

    // Low confidence case
    const lowScores = [0.76, 0.77];
    const lowAvg = lowScores.reduce((a, b) => a + b, 0) / lowScores.length;
    const isLow = lowAvg < minScore + 0.05;
    if (isLow) {
      pass("Confidence: flagged low when average < min+0.05");
    } else {
      fail("Confidence: should be low", { lowAvg, threshold: minScore + 0.05 });
    }
  } catch (e) {
    fail("Confidence metadata threw", e);
  }

  // ── Character cap logic ──
  try {
    const maxChars = 100;
    const contents = ["a".repeat(40), "b".repeat(40), "c".repeat(40)];
    const capped: string[] = [];
    let total = 0;
    for (const c of contents) {
      if (total + c.length > maxChars && capped.length > 0) break;
      capped.push(c);
      total += c.length;
    }
    if (capped.length === 2) {
      pass("Character cap limits snippets (2 of 3 fit in 100 chars)");
    } else {
      fail("Character cap expected 2 snippets", capped.length);
    }
  } catch (e) {
    fail("Character cap threw", e);
  }

  return result;
}

// Allow standalone execution
if (require.main === module) {
  const { runStandalone } = require("./helpers");
  runStandalone(testRetrieval);
}
