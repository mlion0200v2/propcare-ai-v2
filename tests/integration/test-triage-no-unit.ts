/**
 * Phase 2A — Triage no-unit flow integration test.
 *
 * Tests two things:
 * 1. State machine: COLLECT_TENANT_INFO → GATHER_INFO → DONE (pure)
 * 2. Persistence: after each tenant-info answer the classification JSONB
 *    reflects the latest tenant_info (requires RUN_INTEGRATION=1)
 * 3. Resume: GET /api/triage/chat returns messages + state (pure simulation)
 */

import {
  createRunner,
  printSection,
  isIntegrationEnabled,
  getAdminClient,
  createTestUser,
  getAuthenticatedClient,
  cleanupTestUser,
  TEST_PASSWORD,
  type TestResult,
  type SupabaseClient,
  type Database,
} from "./helpers";
import {
  step,
  buildInitialGathered,
  buildInitialTenantInfo,
  buildTenantInfoInitialReply,
  stepTenantInfo,
} from "../../src/lib/triage/state-machine";
import type { TriageClassification, TenantInfo } from "../../src/lib/triage/types";

export async function testTriageNoUnit(): Promise<TestResult> {
  printSection("Triage — No-Unit Flow");
  const { pass, fail, skip, result } = createRunner();

  // ── Part 1: Pure state machine test (always runs) ──

  try {
    let tenantInfo = buildInitialTenantInfo();
    let currentQuestion: string | null = "reported_address";

    // Turn 1: address
    let tiResult = stepTenantInfo(tenantInfo, currentQuestion, "123 Main St, Unit 4B, Anytown");
    tenantInfo = tiResult.tenant_info;
    currentQuestion = tiResult.current_question;

    if (tiResult.next_state === "COLLECT_TENANT_INFO" && currentQuestion === "contact_phone") {
      pass("pure: address collected, asks phone next");
    } else {
      fail("pure: unexpected state after address", { state: tiResult.next_state, q: currentQuestion });
    }

    // Turn 2: phone
    tiResult = stepTenantInfo(tenantInfo, currentQuestion, "555-123-4567");
    tenantInfo = tiResult.tenant_info;
    currentQuestion = tiResult.current_question;

    // Turn 3: email → transition
    tiResult = stepTenantInfo(tenantInfo, currentQuestion, "jane@example.com");
    tenantInfo = tiResult.tenant_info;

    if (tiResult.next_state === "GATHER_INFO") {
      pass("pure: COLLECT_TENANT_INFO → GATHER_INFO after 3 fields");
    } else {
      fail("pure: expected GATHER_INFO", tiResult.next_state);
    }

    // Full flow through GATHER_INFO → DONE
    let gathered = tiResult.gathered ?? buildInitialGathered();
    currentQuestion = tiResult.current_question;

    let stepResult = step(
      { triage_state: "GATHER_INFO", description: "Sink leaking", gathered, current_question: currentQuestion },
      "1"
    );
    gathered = stepResult.gathered;
    currentQuestion = stepResult.current_question;

    stepResult = step(
      { triage_state: "GATHER_INFO", description: "Sink leaking", gathered, current_question: currentQuestion },
      "Kitchen"
    );
    gathered = stepResult.gathered;
    currentQuestion = stepResult.current_question;

    stepResult = step(
      { triage_state: "GATHER_INFO", description: "Sink leaking", gathered, current_question: currentQuestion },
      "Yesterday"
    );
    gathered = stepResult.gathered;
    currentQuestion = stepResult.current_question;

    stepResult = step(
      { triage_state: "GATHER_INFO", description: "Sink leaking", gathered, current_question: currentQuestion },
      "no"
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

    if (finalClassification.tenant_info?.reported_address === "123 Main St, Unit 4B, Anytown") {
      pass("pure: tenant_info preserved through full flow");
    } else {
      fail("pure: tenant_info lost");
    }
  } catch (e) {
    fail("pure flow threw", e);
  }

  // ── Part 2: DB persistence test (integration only) ──

  if (!isIntegrationEnabled()) {
    skip("DB persistence test (RUN_INTEGRATION not set)", "set RUN_INTEGRATION=1");
    skip("Resume test (RUN_INTEGRATION not set)", "set RUN_INTEGRATION=1");
    return result;
  }

  const admin = getAdminClient();
  if (!admin) {
    skip("DB persistence test (no admin client)");
    return result;
  }

  let tenantUserId: string | undefined;

  try {
    // Create a tenant with NO unit
    const { userId, email } = await createTestUser(admin, "nounit-tenant", "tenant");
    tenantUserId = userId;
    const tenantClient = await getAuthenticatedClient(email, TEST_PASSWORD);

    // Step A: Create ticket (simulates first POST — no unit)
    const initialGathered = buildInitialGathered();
    const initialTenantInfo = buildInitialTenantInfo();
    const initialClassification: TriageClassification = {
      gathered: initialGathered,
      current_question: "reported_address",
      tenant_info: initialTenantInfo,
    };

    const { data: ticket, error: ticketErr } = await tenantClient
      .from("tickets")
      .insert({
        title: "Test leaky faucet",
        description: "My faucet is leaking",
        tenant_id: userId,
        unit_id: null,
        triage_state: "COLLECT_TENANT_INFO",
        classification: initialClassification as unknown as import("../../src/lib/supabase/database-generated").Json,
      })
      .select("id, triage_state, classification")
      .single();

    if (ticketErr || !ticket) {
      fail("DB: ticket creation failed", ticketErr?.message);
      return result;
    }
    pass("DB: created ticket with unit_id=null");

    // Insert initial messages
    await tenantClient.from("messages").insert({
      ticket_id: ticket.id,
      sender_id: userId,
      body: "My faucet is leaking",
      is_bot_reply: false,
    });
    await tenantClient.from("messages").insert({
      ticket_id: ticket.id,
      sender_id: userId,
      body: buildTenantInfoInitialReply(),
      is_bot_reply: true,
    });

    // Step B: Answer address → verify persisted
    let stored = ticket.classification as unknown as TriageClassification;
    let tiResult = stepTenantInfo(
      stored.tenant_info ?? buildInitialTenantInfo(),
      stored.current_question,
      "456 Oak Ave, Unit 7"
    );

    let updatedClassification: TriageClassification = {
      gathered: tiResult.gathered ?? stored.gathered ?? buildInitialGathered(),
      current_question: tiResult.current_question,
      tenant_info: tiResult.tenant_info,
    };

    const { data: afterAddr, error: addrErr } = await tenantClient
      .from("tickets")
      .update({
        triage_state: tiResult.next_state,
        classification: updatedClassification as unknown as import("../../src/lib/supabase/database-generated").Json,
      })
      .eq("id", ticket.id)
      .select("id, triage_state, classification")
      .single();

    if (addrErr || !afterAddr) {
      fail("DB: address update failed", addrErr?.message);
      return result;
    }

    const addrStored = afterAddr.classification as unknown as TriageClassification;
    if (addrStored.tenant_info?.reported_address === "456 Oak Ave, Unit 7") {
      pass("DB: reported_address persisted after update");
    } else {
      fail("DB: reported_address not persisted", addrStored.tenant_info);
    }

    if (afterAddr.triage_state === "COLLECT_TENANT_INFO") {
      pass("DB: triage_state still COLLECT_TENANT_INFO");
    } else {
      fail("DB: unexpected triage_state", afterAddr.triage_state);
    }

    // Step C: Answer phone → verify persisted
    stored = addrStored;
    tiResult = stepTenantInfo(
      stored.tenant_info ?? buildInitialTenantInfo(),
      stored.current_question,
      "555-999-1234"
    );

    updatedClassification = {
      gathered: tiResult.gathered ?? stored.gathered ?? buildInitialGathered(),
      current_question: tiResult.current_question,
      tenant_info: tiResult.tenant_info,
    };

    const { data: afterPhone, error: phoneErr } = await tenantClient
      .from("tickets")
      .update({
        triage_state: tiResult.next_state,
        classification: updatedClassification as unknown as import("../../src/lib/supabase/database-generated").Json,
      })
      .eq("id", ticket.id)
      .select("id, triage_state, classification")
      .single();

    if (phoneErr || !afterPhone) {
      fail("DB: phone update failed", phoneErr?.message);
      return result;
    }

    const phoneStored = afterPhone.classification as unknown as TriageClassification;
    if (phoneStored.tenant_info?.contact_phone === "555-999-1234") {
      pass("DB: contact_phone persisted after update");
    } else {
      fail("DB: contact_phone not persisted", phoneStored.tenant_info);
    }

    // Verify address is still there (not overwritten)
    if (phoneStored.tenant_info?.reported_address === "456 Oak Ave, Unit 7") {
      pass("DB: reported_address preserved after phone update");
    } else {
      fail("DB: reported_address lost after phone update", phoneStored.tenant_info);
    }

    // Step D: Answer email → should transition to GATHER_INFO
    stored = phoneStored;
    tiResult = stepTenantInfo(
      stored.tenant_info ?? buildInitialTenantInfo(),
      stored.current_question,
      "test@example.com"
    );

    updatedClassification = {
      gathered: tiResult.gathered ?? stored.gathered ?? buildInitialGathered(),
      current_question: tiResult.current_question,
      tenant_info: tiResult.tenant_info,
    };

    const { data: afterEmail, error: emailErr } = await tenantClient
      .from("tickets")
      .update({
        triage_state: tiResult.next_state,
        classification: updatedClassification as unknown as import("../../src/lib/supabase/database-generated").Json,
      })
      .eq("id", ticket.id)
      .select("id, triage_state, classification")
      .single();

    if (emailErr || !afterEmail) {
      fail("DB: email update failed", emailErr?.message);
      return result;
    }

    if (afterEmail.triage_state === "GATHER_INFO") {
      pass("DB: triage_state transitioned to GATHER_INFO");
    } else {
      fail("DB: expected GATHER_INFO", afterEmail.triage_state);
    }

    const emailStored = afterEmail.classification as unknown as TriageClassification;
    if (
      emailStored.tenant_info?.reported_address === "456 Oak Ave, Unit 7" &&
      emailStored.tenant_info?.contact_phone === "555-999-1234" &&
      emailStored.tenant_info?.contact_email === "test@example.com"
    ) {
      pass("DB: all 3 tenant_info fields persisted correctly");
    } else {
      fail("DB: tenant_info incomplete", emailStored.tenant_info);
    }

    // ── Part 3: Resume test — verify messages can be loaded ──

    // Insert messages for the last turn
    await tenantClient.from("messages").insert({
      ticket_id: ticket.id,
      sender_id: userId,
      body: "test@example.com",
      is_bot_reply: false,
    });
    await tenantClient.from("messages").insert({
      ticket_id: ticket.id,
      sender_id: userId,
      body: tiResult.reply,
      is_bot_reply: true,
    });

    // Simulate GET resume: load ticket + messages
    const { data: resumeTicket } = await tenantClient
      .from("tickets")
      .select("id, triage_state, classification")
      .eq("id", ticket.id)
      .single();

    const { data: resumeMessages } = await tenantClient
      .from("messages")
      .select("id, body, is_bot_reply, created_at")
      .eq("ticket_id", ticket.id)
      .order("created_at", { ascending: true });

    if (resumeTicket && resumeTicket.triage_state === "GATHER_INFO") {
      pass("resume: ticket state loaded correctly");
    } else {
      fail("resume: ticket state wrong", resumeTicket?.triage_state);
    }

    if (resumeMessages && resumeMessages.length >= 4) {
      pass(`resume: ${resumeMessages.length} messages loaded`);
    } else {
      fail("resume: expected at least 4 messages", resumeMessages?.length);
    }

    const resumeClassification = resumeTicket?.classification as unknown as TriageClassification;
    if (resumeClassification?.tenant_info?.contact_email === "test@example.com") {
      pass("resume: classification.tenant_info available on reload");
    } else {
      fail("resume: classification.tenant_info missing on reload");
    }

    // Cleanup: delete ticket + messages
    await admin.from("messages").delete().eq("ticket_id", ticket.id);
    await admin.from("tickets").delete().eq("id", ticket.id);
  } catch (e) {
    fail("integration test threw", e);
  } finally {
    if (tenantUserId) {
      await cleanupTestUser(admin, tenantUserId);
    }
  }

  return result;
}

// Allow standalone execution
if (require.main === module) {
  const { runStandalone } = require("./helpers");
  runStandalone(testTriageNoUnit);
}
