/**
 * Phase 2B — Integration tests for gather-issue, grounding, and summary.
 *
 * Pure tests — no external service calls.
 * Tests extended field gathering, isGatherComplete, summary template.
 */

import {
  createRunner,
  printSection,
  type TestResult,
} from "./helpers";
import {
  isGatherComplete,
  isExtendedField,
  getNextExtendedQuestion,
  getExtendedQuestionText,
  processExtendedAnswer,
} from "../../src/lib/triage/gather-issue";
import { generateTicketSummary } from "../../src/lib/triage/summary";
import type { GatheredInfo, TroubleshootingStep } from "../../src/lib/triage/types";
import { buildInitialGathered } from "../../src/lib/triage/state-machine";

export function testPhase2B(): TestResult {
  printSection("Phase 2B — Gather Issue + Summary");
  const { pass, fail, result } = createRunner();

  // ══════════════════════════════════════════════════════
  // isExtendedField
  // ══════════════════════════════════════════════════════

  try {
    if (isExtendedField("current_status")) {
      pass("isExtendedField: current_status is extended");
    } else {
      fail("isExtendedField: current_status should be extended");
    }
    if (isExtendedField("brand_model")) {
      pass("isExtendedField: brand_model is extended");
    } else {
      fail("isExtendedField: brand_model should be extended");
    }
    if (!isExtendedField("category")) {
      pass("isExtendedField: category is NOT extended");
    } else {
      fail("isExtendedField: category should not be extended");
    }
    if (!isExtendedField("is_emergency")) {
      pass("isExtendedField: is_emergency is NOT extended");
    } else {
      fail("isExtendedField: is_emergency should not be extended");
    }
  } catch (e) {
    fail("isExtendedField threw", e);
  }

  // ══════════════════════════════════════════════════════
  // isGatherComplete
  // ══════════════════════════════════════════════════════

  // ── All nulls → incomplete ──
  try {
    const g = buildInitialGathered();
    if (!isGatherComplete(g)) {
      pass("isGatherComplete: all nulls → false");
    } else {
      fail("isGatherComplete: all nulls should be false");
    }
  } catch (e) {
    fail("isGatherComplete all nulls threw", e);
  }

  // ── Base 4 filled, no extended → incomplete ──
  try {
    const g: GatheredInfo = {
      category: "plumbing",
      location_in_unit: "kitchen",
      started_when: "today",
      is_emergency: false,
      current_status: null,
      brand_model: null,
    };
    if (!isGatherComplete(g)) {
      pass("isGatherComplete: base 4 only → false (missing current_status)");
    } else {
      fail("isGatherComplete: base 4 only should be false");
    }
  } catch (e) {
    fail("isGatherComplete base 4 only threw", e);
  }

  // ── Non-appliance/hvac complete (no brand_model needed) ──
  try {
    const g: GatheredInfo = {
      category: "plumbing",
      location_in_unit: "kitchen",
      started_when: "today",
      is_emergency: false,
      current_status: "still leaking",
      brand_model: null,
    };
    if (isGatherComplete(g)) {
      pass("isGatherComplete: plumbing + current_status → true (no brand_model needed)");
    } else {
      fail("isGatherComplete: plumbing with current_status should be complete");
    }
  } catch (e) {
    fail("isGatherComplete plumbing threw", e);
  }

  // ── Appliance without brand_model → incomplete ──
  try {
    const g: GatheredInfo = {
      category: "appliance",
      location_in_unit: "kitchen",
      started_when: "today",
      is_emergency: false,
      current_status: "not running",
      brand_model: null,
    };
    if (!isGatherComplete(g)) {
      pass("isGatherComplete: appliance without brand_model → false");
    } else {
      fail("isGatherComplete: appliance without brand_model should be false");
    }
  } catch (e) {
    fail("isGatherComplete appliance no brand threw", e);
  }

  // ── Appliance with brand_model → complete ──
  try {
    const g: GatheredInfo = {
      category: "appliance",
      location_in_unit: "kitchen",
      started_when: "today",
      is_emergency: false,
      current_status: "not running",
      brand_model: "GE Profile",
    };
    if (isGatherComplete(g)) {
      pass("isGatherComplete: appliance with brand_model → true");
    } else {
      fail("isGatherComplete: appliance with brand_model should be complete");
    }
  } catch (e) {
    fail("isGatherComplete appliance with brand threw", e);
  }

  // ── HVAC without brand_model → incomplete ──
  try {
    const g: GatheredInfo = {
      category: "hvac",
      location_in_unit: "bedroom",
      started_when: "today",
      is_emergency: true,
      current_status: "no heat",
      brand_model: null,
    };
    if (!isGatherComplete(g)) {
      pass("isGatherComplete: hvac without brand_model → false");
    } else {
      fail("isGatherComplete: hvac without brand_model should be false");
    }
  } catch (e) {
    fail("isGatherComplete hvac no brand threw", e);
  }

  // ── HVAC with brand_model → complete ──
  try {
    const g: GatheredInfo = {
      category: "hvac",
      location_in_unit: "bedroom",
      started_when: "today",
      is_emergency: true,
      current_status: "no heat",
      brand_model: "Carrier AC",
    };
    if (isGatherComplete(g)) {
      pass("isGatherComplete: hvac with brand_model → true");
    } else {
      fail("isGatherComplete: hvac with brand_model should be complete");
    }
  } catch (e) {
    fail("isGatherComplete hvac with brand threw", e);
  }

  // ══════════════════════════════════════════════════════
  // getNextExtendedQuestion
  // ══════════════════════════════════════════════════════

  try {
    const g: GatheredInfo = {
      category: "plumbing",
      location_in_unit: "kitchen",
      started_when: "today",
      is_emergency: false,
      current_status: null,
      brand_model: null,
    };
    const next = getNextExtendedQuestion(g);
    if (next === "current_status") {
      pass("getNextExtendedQuestion: asks current_status first");
    } else {
      fail("getNextExtendedQuestion: expected current_status", next);
    }
  } catch (e) {
    fail("getNextExtendedQuestion threw", e);
  }

  try {
    const g: GatheredInfo = {
      category: "appliance",
      location_in_unit: "kitchen",
      started_when: "today",
      is_emergency: false,
      current_status: "not working",
      brand_model: null,
    };
    const next = getNextExtendedQuestion(g);
    if (next === "brand_model") {
      pass("getNextExtendedQuestion: asks brand_model for appliance");
    } else {
      fail("getNextExtendedQuestion: expected brand_model", next);
    }
  } catch (e) {
    fail("getNextExtendedQuestion brand_model threw", e);
  }

  try {
    const g: GatheredInfo = {
      category: "plumbing",
      location_in_unit: "kitchen",
      started_when: "today",
      is_emergency: false,
      current_status: "still leaking",
      brand_model: null,
    };
    const next = getNextExtendedQuestion(g);
    if (next === null) {
      pass("getNextExtendedQuestion: null for plumbing (no brand_model needed)");
    } else {
      fail("getNextExtendedQuestion: expected null for plumbing", next);
    }
  } catch (e) {
    fail("getNextExtendedQuestion plumbing complete threw", e);
  }

  // ══════════════════════════════════════════════════════
  // getExtendedQuestionText
  // ══════════════════════════════════════════════════════

  try {
    const text = getExtendedQuestionText("current_status");
    if (text.includes("current status")) {
      pass("getExtendedQuestionText: current_status has question text");
    } else {
      fail("getExtendedQuestionText: current_status missing text", text);
    }
  } catch (e) {
    fail("getExtendedQuestionText current_status threw", e);
  }

  try {
    const text = getExtendedQuestionText("brand_model");
    if (text.includes("brand") && text.includes("model")) {
      pass("getExtendedQuestionText: brand_model has question text");
    } else {
      fail("getExtendedQuestionText: brand_model missing text", text);
    }
  } catch (e) {
    fail("getExtendedQuestionText brand_model threw", e);
  }

  // ══════════════════════════════════════════════════════
  // processExtendedAnswer
  // ══════════════════════════════════════════════════════

  try {
    const g: GatheredInfo = {
      category: "plumbing",
      location_in_unit: "kitchen",
      started_when: "today",
      is_emergency: false,
      current_status: null,
      brand_model: null,
    };
    const updated = processExtendedAnswer(g, "current_status", "  still dripping  ");
    if (updated.current_status === "still dripping") {
      pass("processExtendedAnswer: trims and stores current_status");
    } else {
      fail("processExtendedAnswer: current_status", updated.current_status);
    }
    // Original unchanged (immutable)
    if (g.current_status === null) {
      pass("processExtendedAnswer: original unchanged (immutable)");
    } else {
      fail("processExtendedAnswer: mutated original", g.current_status);
    }
  } catch (e) {
    fail("processExtendedAnswer current_status threw", e);
  }

  try {
    const g: GatheredInfo = {
      category: "appliance",
      location_in_unit: "kitchen",
      started_when: "today",
      is_emergency: false,
      current_status: "broken",
      brand_model: null,
    };
    const updated = processExtendedAnswer(g, "brand_model", "Unknown");
    if (updated.brand_model === "unknown") {
      pass("processExtendedAnswer: 'Unknown' normalized to 'unknown'");
    } else {
      fail("processExtendedAnswer: brand_model normalization", updated.brand_model);
    }
  } catch (e) {
    fail("processExtendedAnswer unknown brand threw", e);
  }

  try {
    const g: GatheredInfo = {
      category: "appliance",
      location_in_unit: "kitchen",
      started_when: "today",
      is_emergency: false,
      current_status: "broken",
      brand_model: null,
    };
    const updated = processExtendedAnswer(g, "brand_model", "GE Profile dishwasher");
    if (updated.brand_model === "GE Profile dishwasher") {
      pass("processExtendedAnswer: stores actual brand_model value");
    } else {
      fail("processExtendedAnswer: brand_model value", updated.brand_model);
    }
  } catch (e) {
    fail("processExtendedAnswer brand value threw", e);
  }

  // ══════════════════════════════════════════════════════
  // Extended field gathering order (simulated flow)
  // ══════════════════════════════════════════════════════

  try {
    // Simulate: base 4 complete, now asking extended
    let g: GatheredInfo = {
      category: "appliance",
      location_in_unit: "kitchen",
      started_when: "today",
      is_emergency: false,
      current_status: null,
      brand_model: null,
    };

    // Step 1: should ask current_status
    let next = getNextExtendedQuestion(g);
    if (next !== "current_status") {
      fail("Extended flow: expected current_status first", next);
    } else {
      pass("Extended flow: step 1 asks current_status");
    }

    g = processExtendedAnswer(g, "current_status", "not running");

    // Step 2: should ask brand_model (appliance category)
    next = getNextExtendedQuestion(g);
    if (next !== "brand_model") {
      fail("Extended flow: expected brand_model second", next);
    } else {
      pass("Extended flow: step 2 asks brand_model");
    }

    g = processExtendedAnswer(g, "brand_model", "GE Profile");

    // Step 3: should be complete
    if (isGatherComplete(g)) {
      pass("Extended flow: complete after all fields");
    } else {
      fail("Extended flow: should be complete");
    }
    next = getNextExtendedQuestion(g);
    if (next === null) {
      pass("Extended flow: no more questions");
    } else {
      fail("Extended flow: unexpected next question", next);
    }
  } catch (e) {
    fail("Extended field flow threw", e);
  }

  // ══════════════════════════════════════════════════════
  // Summary generation
  // ══════════════════════════════════════════════════════

  printSection("Phase 2B — Summary Generation");

  try {
    const steps: TroubleshootingStep[] = [
      { step: 1, description: "Turn off water valve", completed: false },
      { step: 2, description: "Place bucket under leak", completed: false },
    ];

    const summary = generateTicketSummary({
      ticketId: "ticket-123",
      traceId: "trace-456",
      description: "Kitchen faucet leaking",
      gathered: {
        category: "plumbing",
        location_in_unit: "kitchen",
        started_when: "yesterday",
        is_emergency: false,
        current_status: "still dripping",
        brand_model: null,
      },
      tenantInfo: {
        reported_address: "123 Main St",
        reported_unit_number: "Apt 4B",
        contact_phone: "555-1234",
        contact_email: "tenant@test.com",
      },
      steps,
      mediaCount: 0,
      timestamp: "2024-01-15T12:00:00.000Z",
    });

    if (summary.includes("MAINTENANCE REQUEST")) {
      pass("Summary: includes header");
    } else {
      fail("Summary: missing header", summary.slice(0, 100));
    }
    if (summary.includes("Plumbing")) {
      pass("Summary: includes category");
    } else {
      fail("Summary: missing category");
    }
    if (summary.includes("123 Main St")) {
      pass("Summary: includes address");
    } else {
      fail("Summary: missing address");
    }
    if (summary.includes("Apt 4B")) {
      pass("Summary: includes unit");
    } else {
      fail("Summary: missing unit");
    }
    if (summary.includes("Kitchen faucet leaking")) {
      pass("Summary: includes description");
    } else {
      fail("Summary: missing description");
    }
    if (summary.includes("kitchen")) {
      pass("Summary: includes location_in_unit");
    } else {
      fail("Summary: missing location");
    }
    if (summary.includes("yesterday")) {
      pass("Summary: includes started_when");
    } else {
      fail("Summary: missing started_when");
    }
    if (summary.includes("still dripping")) {
      pass("Summary: includes current_status");
    } else {
      fail("Summary: missing current_status");
    }
    if (summary.includes("N/A")) {
      pass("Summary: shows N/A for null brand_model");
    } else {
      fail("Summary: missing N/A for brand_model");
    }
    if (summary.includes("Emergency: No")) {
      pass("Summary: includes emergency status");
    } else {
      fail("Summary: missing emergency status");
    }
    if (summary.includes("medium")) {
      pass("Summary: includes priority");
    } else {
      fail("Summary: missing priority");
    }
    if (summary.includes("Turn off water valve")) {
      pass("Summary: includes troubleshooting steps");
    } else {
      fail("Summary: missing steps");
    }
    if (summary.includes("None uploaded yet")) {
      pass("Summary: shows no media");
    } else {
      fail("Summary: missing media status");
    }
    if (summary.includes("ticket-123")) {
      pass("Summary: includes ticket_id");
    } else {
      fail("Summary: missing ticket_id");
    }
    if (summary.includes("trace-456")) {
      pass("Summary: includes trace_id");
    } else {
      fail("Summary: missing trace_id");
    }
  } catch (e) {
    fail("Summary generation threw", e);
  }

  // ── Summary with emergency ──
  try {
    const summary = generateTicketSummary({
      ticketId: "ticket-789",
      traceId: "trace-012",
      description: "Gas smell in kitchen",
      gathered: {
        category: "plumbing",
        location_in_unit: "kitchen",
        started_when: "just now",
        is_emergency: true,
        current_status: "ongoing",
        brand_model: null,
      },
      tenantInfo: null,
      steps: [],
      mediaCount: 2,
      timestamp: "2024-01-15T12:00:00.000Z",
    });

    if (summary.includes("Emergency: Yes")) {
      pass("Summary emergency: shows Yes");
    } else {
      fail("Summary emergency: missing Yes");
    }
    if (summary.includes("emergency")) {
      pass("Summary emergency: priority is emergency");
    } else {
      fail("Summary emergency: missing emergency priority");
    }
    if (summary.includes("2 file(s) uploaded")) {
      pass("Summary emergency: shows media count");
    } else {
      fail("Summary emergency: missing media count");
    }
  } catch (e) {
    fail("Summary emergency threw", e);
  }

  return result;
}

// Allow standalone execution
if (require.main === module) {
  const { runStandalone } = require("./helpers");
  runStandalone(testPhase2B);
}
