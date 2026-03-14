/**
 * Phase 2A — Triage state machine unit tests.
 *
 * Pure tests — no Supabase, no network calls.
 * Tests the deterministic state machine step() function.
 *
 * Updated for conversational triage refactor:
 * - Category is now pre-set by classifier (not via numbered list in step())
 * - Safety is detected separately (not via generic YES/NO in step())
 * - step() now handles: location_in_unit, started_when
 */

import {
  createRunner,
  printSection,
  type TestResult,
} from "./helpers";
import {
  step,
  buildInitialReply,
  buildInitialGathered,
  buildInitialTenantInfo,
  buildTenantInfoInitialReply,
  buildConfirmProfileReply,
  stepTenantInfo,
  QUESTIONS,
} from "../../src/lib/triage/state-machine";
import { getFallbackSOP } from "../../src/lib/triage/sop-fallback";
import { buildAcknowledgement } from "../../src/lib/triage/acknowledgement";
import type { TriageContext } from "../../src/lib/triage/types";

export function testTriageChatBasic(): TestResult {
  printSection("Triage State Machine — Basic");
  const { pass, fail, result } = createRunner();

  // ── buildInitialReply ──

  try {
    const ack = buildAcknowledgement("my faucet is leaking");
    const reply = buildInitialReply(ack, QUESTIONS.location_in_unit);
    if (reply.includes("Where in your unit")) {
      pass("buildInitialReply includes location question");
    } else {
      fail("buildInitialReply missing location question", reply.slice(0, 200));
    }
    if (!reply.includes("Reply with a number")) {
      pass("buildInitialReply does NOT include numbered category menu");
    } else {
      fail("buildInitialReply still has category menu", reply.slice(0, 200));
    }
  } catch (e) {
    fail("buildInitialReply threw", e);
  }

  // ── buildInitialGathered ──

  try {
    const g = buildInitialGathered();
    if (
      g.category === null &&
      g.location_in_unit === null &&
      g.started_when === null &&
      g.is_emergency === null &&
      g.current_status === null &&
      g.brand_model === null
    ) {
      pass("buildInitialGathered returns all nulls (6 fields)");
    } else {
      fail("buildInitialGathered has non-null fields", g);
    }
  } catch (e) {
    fail("buildInitialGathered threw", e);
  }

  // ── step: location then started_when (with category pre-set) ──

  try {
    const gathered = buildInitialGathered();
    gathered.category = "plumbing"; // Pre-set by classifier

    const ctx: TriageContext = {
      triage_state: "GATHER_INFO",
      description: "My sink is leaking",
      gathered,
      current_question: "location_in_unit",
    };
    const r = step(ctx, "Kitchen");
    if (r.gathered.location_in_unit === "Kitchen") {
      pass("step: location_in_unit = Kitchen collected");
    } else {
      fail("step: location not collected", r.gathered.location_in_unit);
    }
    if (r.current_question === "started_when") {
      pass("step: after location, asks started_when");
    } else {
      fail("step: expected started_when next", r.current_question);
    }
  } catch (e) {
    fail("step: location collection threw", e);
  }

  // ── step: category still works if passed as current_question (legacy support) ──

  try {
    const ctx: TriageContext = {
      triage_state: "GATHER_INFO",
      description: "AC not working",
      gathered: buildInitialGathered(),
      current_question: "category",
    };
    const r = step(ctx, "hvac");
    if (r.gathered.category === "hvac") {
      pass("step: category by name 'hvac' still works (legacy)");
    } else {
      fail("step: category by name expected hvac", r.gathered.category);
    }
  } catch (e) {
    fail("step: category by name threw", e);
  }

  // ── step: full flow with pre-set category + is_emergency (2 turns → DONE) ──

  try {
    const gathered = buildInitialGathered();
    gathered.category = "plumbing";
    gathered.is_emergency = false;

    let ctx: TriageContext = {
      triage_state: "GATHER_INFO",
      description: "Leaking faucet",
      gathered,
      current_question: "location_in_unit",
    };

    // Turn 1: location
    let r = step(ctx, "Kitchen");
    ctx = {
      triage_state: r.next_state,
      description: ctx.description,
      gathered: r.gathered,
      current_question: r.current_question,
    };

    // Turn 2: started_when → DONE
    r = step(ctx, "Yesterday");

    if (r.next_state === "DONE") {
      pass("step: full flow ends in DONE after 2 turns (with pre-set fields)");
    } else {
      fail("step: full flow expected DONE", r.next_state);
    }

    if (r.gathered.category === "plumbing") {
      pass("step: full flow gathered category=plumbing");
    } else {
      fail("step: full flow category", r.gathered.category);
    }

    if (r.gathered.location_in_unit === "Kitchen") {
      pass("step: full flow gathered location=Kitchen");
    } else {
      fail("step: full flow location", r.gathered.location_in_unit);
    }

    if (r.gathered.is_emergency === false) {
      pass("step: full flow gathered is_emergency=false");
    } else {
      fail("step: full flow is_emergency", r.gathered.is_emergency);
    }

    if (r.troubleshooting_steps && r.troubleshooting_steps.length > 0) {
      pass(`step: full flow includes ${r.troubleshooting_steps.length} troubleshooting steps`);
    } else {
      fail("step: full flow missing troubleshooting_steps");
    }

    if (r.reply.includes("Troubleshooting Steps")) {
      pass("step: full flow reply includes troubleshooting display");
    } else {
      fail("step: full flow reply missing troubleshooting content", r.reply.slice(0, 100));
    }
  } catch (e) {
    fail("step: full flow threw", e);
  }

  // ── step: emergency keyword auto-detection ──

  try {
    const gathered = buildInitialGathered();
    gathered.category = "plumbing";

    const ctx: TriageContext = {
      triage_state: "GATHER_INFO",
      description: "I smell gas in my kitchen",
      gathered,
      current_question: "location_in_unit",
    };
    // User mentions gas leak while answering location
    const r = step(ctx, "Kitchen — I think there's a gas leak");
    if (r.gathered.is_emergency === true) {
      pass("step: emergency keyword 'gas leak' auto-detected");
    } else {
      fail("step: emergency keyword not detected", r.gathered.is_emergency);
    }
  } catch (e) {
    fail("step: emergency keyword threw", e);
  }

  // ── step: emergency flow reaches DONE with escalation ──

  try {
    const gathered = buildInitialGathered();
    gathered.category = "plumbing";
    gathered.location_in_unit = "Kitchen";
    gathered.is_emergency = true; // Pre-detected

    const ctx: TriageContext = {
      triage_state: "GATHER_INFO",
      description: "Gas smell",
      gathered,
      current_question: "started_when",
    };
    const r = step(ctx, "Just now");

    if (r.next_state === "DONE") {
      pass("step: emergency flow ends in DONE");
    } else {
      fail("step: emergency flow expected DONE", r.next_state);
    }

    if (r.reply.includes("SAFETY ALERT")) {
      pass("step: emergency reply includes SAFETY ALERT");
    } else {
      fail("step: emergency reply missing SAFETY ALERT", r.reply.slice(0, 100));
    }
  } catch (e) {
    fail("step: emergency flow threw", e);
  }

  // ── getFallbackSOP: non-emergency ──

  try {
    const sop = getFallbackSOP("plumbing", false);
    if (sop.steps.length > 0 && sop.display.includes("Troubleshooting Steps")) {
      pass(`getFallbackSOP: plumbing non-emergency returns ${sop.steps.length} steps`);
    } else {
      fail("getFallbackSOP: plumbing non-emergency missing steps", sop);
    }
  } catch (e) {
    fail("getFallbackSOP threw", e);
  }

  // ── getFallbackSOP: emergency includes prefix steps ──

  try {
    const sop = getFallbackSOP("electrical", true);
    if (sop.display.includes("IMMEDIATE ACTIONS")) {
      pass("getFallbackSOP: emergency includes IMMEDIATE ACTIONS");
    } else {
      fail("getFallbackSOP: emergency missing IMMEDIATE ACTIONS", sop.display.slice(0, 100));
    }
    if (sop.steps.length > 5) {
      pass(`getFallbackSOP: emergency has ${sop.steps.length} steps (prefix + category)`);
    } else {
      fail("getFallbackSOP: emergency too few steps", sop.steps.length);
    }
  } catch (e) {
    fail("getFallbackSOP emergency threw", e);
  }

  // ── getFallbackSOP: unknown category falls back to general ──

  try {
    const sop = getFallbackSOP("nonexistent_category", false);
    if (sop.steps.length > 0) {
      pass("getFallbackSOP: unknown category falls back to general");
    } else {
      fail("getFallbackSOP: unknown category returned empty");
    }
  } catch (e) {
    fail("getFallbackSOP unknown category threw", e);
  }

  // ══════════════════════════════════════════════════════
  // Tenant Info (no-unit flow) tests
  // ══════════════════════════════════════════════════════

  printSection("Triage State Machine — Tenant Info (no-unit flow)");

  // ── buildInitialTenantInfo ──

  try {
    const ti = buildInitialTenantInfo();
    if (
      ti.reported_address === null &&
      ti.reported_unit_number === null &&
      ti.contact_phone === null &&
      ti.contact_email === null
    ) {
      pass("buildInitialTenantInfo returns all nulls (4 fields)");
    } else {
      fail("buildInitialTenantInfo has non-null fields", ti);
    }
  } catch (e) {
    fail("buildInitialTenantInfo threw", e);
  }

  // ── buildTenantInfoInitialReply ──

  try {
    const reply = buildTenantInfoInitialReply();
    if (reply.includes("address")) {
      pass("buildTenantInfoInitialReply asks for address");
    } else {
      fail("buildTenantInfoInitialReply missing address question", reply.slice(0, 200));
    }
    if (reply.includes("don't have your address on file")) {
      pass("buildTenantInfoInitialReply explains no address on file");
    } else {
      fail("buildTenantInfoInitialReply missing explanation", reply.slice(0, 200));
    }
  } catch (e) {
    fail("buildTenantInfoInitialReply threw", e);
  }

  // ── stepTenantInfo: full flow (4 turns → transitions to GATHER_INFO) ──

  try {
    let info = buildInitialTenantInfo();
    let currentQ: string | null = "reported_address";

    // Turn 1: address
    let r = stepTenantInfo(info, currentQ, "123 Main St, Anytown");
    info = r.tenant_info;
    currentQ = r.current_question;
    if (info.reported_address === "123 Main St, Anytown") {
      pass("stepTenantInfo: collected address");
    } else {
      fail("stepTenantInfo: address", info.reported_address);
    }
    if (currentQ === "reported_unit_number") {
      pass("stepTenantInfo: asks unit number next");
    } else {
      fail("stepTenantInfo: expected unit number next", currentQ);
    }

    // Turn 2: unit number
    r = stepTenantInfo(info, currentQ, "Unit 4B");
    info = r.tenant_info;
    currentQ = r.current_question;
    if (info.reported_unit_number === "Unit 4B") {
      pass("stepTenantInfo: collected unit number");
    } else {
      fail("stepTenantInfo: unit number", info.reported_unit_number);
    }
    if (currentQ === "contact_phone") {
      pass("stepTenantInfo: asks phone next");
    } else {
      fail("stepTenantInfo: expected phone next", currentQ);
    }

    // Turn 3: phone
    r = stepTenantInfo(info, currentQ, "555-123-4567");
    info = r.tenant_info;
    currentQ = r.current_question;
    if (info.contact_phone === "555-123-4567") {
      pass("stepTenantInfo: collected phone");
    } else {
      fail("stepTenantInfo: phone", info.contact_phone);
    }

    // Turn 4: email → transitions to GATHER_INFO
    r = stepTenantInfo(info, currentQ, "jane@example.com");
    info = r.tenant_info;
    currentQ = r.current_question;

    if (r.next_state === "GATHER_INFO") {
      pass("stepTenantInfo: transitions to GATHER_INFO after all 4 fields");
    } else {
      fail("stepTenantInfo: expected GATHER_INFO", r.next_state);
    }

    // Updated: transition reply now asks location, not category menu
    if (r.reply.includes("Where in your unit") || r.current_question === "location_in_unit") {
      pass("stepTenantInfo: transition asks location (not category menu)");
    } else {
      fail("stepTenantInfo: transition reply unexpected", r.reply.slice(0, 100));
    }

    if (r.gathered) {
      pass("stepTenantInfo: transition returns initial gathered info");
    } else {
      fail("stepTenantInfo: transition missing gathered info");
    }
  } catch (e) {
    fail("stepTenantInfo full flow threw", e);
  }

  // ── stepTenantInfo: phone validation rejects bad input ──

  try {
    const info = buildInitialTenantInfo();
    info.reported_address = "123 Main St";
    info.reported_unit_number = "Unit 4B";

    const r = stepTenantInfo(info, "contact_phone", "not-a-phone");
    if (r.next_state === "COLLECT_TENANT_INFO" && r.current_question === "contact_phone") {
      pass("stepTenantInfo: invalid phone re-asks same question");
    } else {
      fail("stepTenantInfo: invalid phone should re-ask", { state: r.next_state, question: r.current_question });
    }
    if (r.reply.includes("valid phone")) {
      pass("stepTenantInfo: invalid phone shows validation error");
    } else {
      fail("stepTenantInfo: invalid phone missing error message", r.reply.slice(0, 100));
    }
    // Phone should remain null
    if (r.tenant_info.contact_phone === null) {
      pass("stepTenantInfo: invalid phone doesn't save value");
    } else {
      fail("stepTenantInfo: invalid phone saved value", r.tenant_info.contact_phone);
    }
  } catch (e) {
    fail("stepTenantInfo phone validation threw", e);
  }

  // ── stepTenantInfo: email validation rejects bad input ──

  try {
    const info = buildInitialTenantInfo();
    info.reported_address = "123 Main St";
    info.reported_unit_number = "Unit 4B";
    info.contact_phone = "555-123-4567";

    const r = stepTenantInfo(info, "contact_email", "not-an-email");
    if (r.next_state === "COLLECT_TENANT_INFO" && r.current_question === "contact_email") {
      pass("stepTenantInfo: invalid email re-asks same question");
    } else {
      fail("stepTenantInfo: invalid email should re-ask", { state: r.next_state, question: r.current_question });
    }
    if (r.reply.includes("valid email")) {
      pass("stepTenantInfo: invalid email shows validation error");
    } else {
      fail("stepTenantInfo: invalid email missing error message", r.reply.slice(0, 100));
    }
  } catch (e) {
    fail("stepTenantInfo email validation threw", e);
  }

  // ── stepTenantInfo: accepts international phone formats ──

  try {
    const info = buildInitialTenantInfo();
    info.reported_address = "123 Main St";
    info.reported_unit_number = "Unit 4B";

    const r = stepTenantInfo(info, "contact_phone", "+1 (555) 123-4567");
    if (r.tenant_info.contact_phone === "+1 (555) 123-4567") {
      pass("stepTenantInfo: accepts international phone format");
    } else {
      fail("stepTenantInfo: rejected valid phone", r.tenant_info.contact_phone);
    }
  } catch (e) {
    fail("stepTenantInfo international phone threw", e);
  }

  // ══════════════════════════════════════════════════════
  // buildConfirmProfileReply tests
  // ══════════════════════════════════════════════════════

  printSection("Triage State Machine — buildConfirmProfileReply");

  // ── buildConfirmProfileReply includes phone and email ──

  try {
    const tenantInfo = {
      reported_address: "456 Oak Ave",
      reported_unit_number: "Apt 7",
      contact_phone: "555-987-6543",
      contact_email: "returning@example.com",
    };
    const reply = buildConfirmProfileReply(tenantInfo);
    if (reply.includes("456 Oak Ave")) {
      pass("buildConfirmProfileReply includes reported_address value");
    } else {
      fail("buildConfirmProfileReply missing address", reply);
    }
    if (reply.includes("Apt 7")) {
      pass("buildConfirmProfileReply includes reported_unit_number value");
    } else {
      fail("buildConfirmProfileReply missing unit", reply);
    }
    if (reply.includes("555-987-6543")) {
      pass("buildConfirmProfileReply includes contact_phone value");
    } else {
      fail("buildConfirmProfileReply missing phone", reply);
    }
    if (reply.includes("returning@example.com")) {
      pass("buildConfirmProfileReply includes contact_email value");
    } else {
      fail("buildConfirmProfileReply missing email", reply);
    }
    if (reply.includes("Is this still correct?")) {
      pass("buildConfirmProfileReply asks for confirmation");
    } else {
      fail("buildConfirmProfileReply missing confirmation question", reply);
    }
  } catch (e) {
    fail("buildConfirmProfileReply threw", e);
  }

  return result;
}

// Allow standalone execution
if (require.main === module) {
  const { runStandalone } = require("./helpers");
  runStandalone(testTriageChatBasic);
}
