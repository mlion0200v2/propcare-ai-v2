/**
 * Phase 2A — Triage no-unit flow integration test.
 *
 * Tests:
 * 1. State machine: COLLECT_TENANT_INFO → GATHER_INFO → DONE (pure, 4 fields)
 * 2. Persistence: after each tenant-info answer the classification JSONB
 *    reflects the latest tenant_info (requires RUN_INTEGRATION=1)
 * 3. Resume: GET /api/triage/chat returns messages + state (pure simulation)
 * 4. Profile defaults: phone + address + unit persisted to profiles
 * 5. CONFIRM_PROFILE "yes": all 4 fields filled → GATHER_INFO directly
 * 6. CONFIRM_PROFILE "change": clears address/unit/phone, keeps email
 * 7. RLS: cross-tenant profile isolation (phone + default_* columns)
 */

import { createRunner, printSection, type TestResult } from "./helpers";
import {
  step,
  buildInitialGathered,
  buildInitialTenantInfo,
  stepTenantInfo,
  getNextMissingTenantInfo,
} from "../../src/lib/triage/state-machine";
import type { TriageClassification, TenantInfo } from "../../src/lib/triage/types";

export async function testTriageNoUnit(): Promise<TestResult> {
  printSection("Triage — No-Unit Flow");
  const { pass, fail, result } = createRunner();

  // ── Part 1: Pure state machine test (always runs) ──

  try {
    let tenantInfo = buildInitialTenantInfo();
    let currentQuestion: string | null = "reported_address";

    // Turn 1: address
    let tiResult = stepTenantInfo(tenantInfo, currentQuestion, "123 Main St, Anytown");
    tenantInfo = tiResult.tenant_info;
    currentQuestion = tiResult.current_question;

    if (tiResult.next_state === "COLLECT_TENANT_INFO" && currentQuestion === "reported_unit_number") {
      pass("pure: address collected, asks unit number next");
    } else {
      fail("pure: unexpected state after address", { state: tiResult.next_state, q: currentQuestion });
    }

    // Turn 2: unit number
    tiResult = stepTenantInfo(tenantInfo, currentQuestion, "Unit 4B");
    tenantInfo = tiResult.tenant_info;
    currentQuestion = tiResult.current_question;

    if (tiResult.next_state === "COLLECT_TENANT_INFO" && currentQuestion === "contact_phone") {
      pass("pure: unit collected, asks phone next");
    } else {
      fail("pure: unexpected state after unit", { state: tiResult.next_state, q: currentQuestion });
    }

    // Turn 3: phone
    tiResult = stepTenantInfo(tenantInfo, currentQuestion, "555-123-4567");
    tenantInfo = tiResult.tenant_info;
    currentQuestion = tiResult.current_question;

    // Turn 4: email → transition
    tiResult = stepTenantInfo(tenantInfo, currentQuestion, "jane@example.com");
    tenantInfo = tiResult.tenant_info;

    if (tiResult.next_state === "GATHER_INFO") {
      pass("pure: COLLECT_TENANT_INFO → GATHER_INFO after 4 fields");
    } else {
      fail("pure: expected GATHER_INFO", tiResult.next_state);
    }

    // Full flow through GATHER_INFO → DONE
    // Pre-set category and is_emergency (as the route handler does via auto-classification)
    let gathered = tiResult.gathered ?? buildInitialGathered();
    gathered.category = "plumbing";
    gathered.is_emergency = false;
    currentQuestion = tiResult.current_question;

    // currentQuestion is now "location_in_unit" (not "category")
    let stepResult = step(
      { triage_state: "GATHER_INFO", description: "Sink leaking", gathered, current_question: currentQuestion },
      "Kitchen"
    );
    gathered = stepResult.gathered;
    currentQuestion = stepResult.current_question;

    stepResult = step(
      { triage_state: "GATHER_INFO", description: "Sink leaking", gathered, current_question: currentQuestion },
      "Yesterday"
    );

    if (stepResult.next_state === "DONE") {
      pass("pure: full flow ends DONE");
    } else {
      fail("pure: expected DONE", stepResult.next_state);
    }

    const finalClassification: TriageClassification = {
      gathered: stepResult.gathered,
      current_question: null,
      tenant_info: tenantInfo,
    };

    if (
      finalClassification.tenant_info?.reported_address === "123 Main St, Anytown" &&
      finalClassification.tenant_info?.reported_unit_number === "Unit 4B"
    ) {
      pass("pure: tenant_info (address + unit) preserved through full flow");
    } else {
      fail("pure: tenant_info lost", finalClassification.tenant_info);
    }
  } catch (e) {
    fail("pure flow threw", e);
  }

  // ── Pure: stepTenantInfo with all fields pre-filled → GATHER_INFO immediately ──

  try {
    const prefilled: TenantInfo = {
      reported_address: "456 Oak Ave",
      reported_unit_number: "Apt 7",
      contact_phone: "555-999-1234",
      contact_email: "test@example.com",
    };
    const r = stepTenantInfo(prefilled, null, "");
    if (r.next_state === "GATHER_INFO") {
      pass("pure: stepTenantInfo with all fields pre-filled → GATHER_INFO");
    } else {
      fail("pure: expected GATHER_INFO for pre-filled", r.next_state);
    }
    if (r.current_question === "location_in_unit") {
      pass("pure: pre-filled transition asks location_in_unit");
    } else {
      fail("pure: pre-filled transition wrong question", r.current_question);
    }
  } catch (e) {
    fail("pure: pre-filled stepTenantInfo threw", e);
  }

  // ── Pure: getNextMissingTenantInfo ──

  try {
    const full: TenantInfo = {
      reported_address: "a", reported_unit_number: "b",
      contact_phone: "c", contact_email: "d",
    };
    if (getNextMissingTenantInfo(full) === null) {
      pass("pure: getNextMissingTenantInfo returns null when all filled");
    } else {
      fail("pure: expected null for full info");
    }

    const partial: TenantInfo = {
      reported_address: "a", reported_unit_number: null,
      contact_phone: "c", contact_email: "d",
    };
    if (getNextMissingTenantInfo(partial) === "reported_unit_number") {
      pass("pure: getNextMissingTenantInfo finds first null (unit)");
    } else {
      fail("pure: expected reported_unit_number", getNextMissingTenantInfo(partial));
    }
  } catch (e) {
    fail("pure: getNextMissingTenantInfo threw", e);
  }

  // ── Part 2 (DB persistence) moved: tickets now require a unit's tenancy,
  // and database behaviour is tested in test-workspace-rls.ts (PGlite). ──

  return result;
}

// Allow standalone execution
if (require.main === module) {
  const { runStandalone } = require("./helpers");
  runStandalone(testTriageNoUnit);
}
