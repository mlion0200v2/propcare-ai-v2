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
  buildConfirmProfileReply,
  stepTenantInfo,
  getNextMissingTenantInfo,
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
    if (r.current_question === "category") {
      pass("pure: pre-filled transition asks category");
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
      "456 Oak Ave"
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
    if (addrStored.tenant_info?.reported_address === "456 Oak Ave") {
      pass("DB: reported_address persisted after update");
    } else {
      fail("DB: reported_address not persisted", addrStored.tenant_info);
    }

    if (afterAddr.triage_state === "COLLECT_TENANT_INFO") {
      pass("DB: triage_state still COLLECT_TENANT_INFO");
    } else {
      fail("DB: unexpected triage_state", afterAddr.triage_state);
    }

    // Step B2: Answer unit number → verify persisted
    stored = addrStored;
    tiResult = stepTenantInfo(
      stored.tenant_info ?? buildInitialTenantInfo(),
      stored.current_question,
      "Unit 7"
    );

    updatedClassification = {
      gathered: tiResult.gathered ?? stored.gathered ?? buildInitialGathered(),
      current_question: tiResult.current_question,
      tenant_info: tiResult.tenant_info,
    };

    const { data: afterUnit, error: unitErr } = await tenantClient
      .from("tickets")
      .update({
        triage_state: tiResult.next_state,
        classification: updatedClassification as unknown as import("../../src/lib/supabase/database-generated").Json,
      })
      .eq("id", ticket.id)
      .select("id, triage_state, classification")
      .single();

    if (unitErr || !afterUnit) {
      fail("DB: unit update failed", unitErr?.message);
      return result;
    }

    const unitStored = afterUnit.classification as unknown as TriageClassification;
    if (unitStored.tenant_info?.reported_unit_number === "Unit 7") {
      pass("DB: reported_unit_number persisted after update");
    } else {
      fail("DB: reported_unit_number not persisted", unitStored.tenant_info);
    }

    // Step C: Answer phone → verify persisted
    stored = unitStored;
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

    // Verify address + unit still there (not overwritten)
    if (
      phoneStored.tenant_info?.reported_address === "456 Oak Ave" &&
      phoneStored.tenant_info?.reported_unit_number === "Unit 7"
    ) {
      pass("DB: address + unit preserved after phone update");
    } else {
      fail("DB: address/unit lost after phone update", phoneStored.tenant_info);
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
      emailStored.tenant_info?.reported_address === "456 Oak Ave" &&
      emailStored.tenant_info?.reported_unit_number === "Unit 7" &&
      emailStored.tenant_info?.contact_phone === "555-999-1234" &&
      emailStored.tenant_info?.contact_email === "test@example.com"
    ) {
      pass("DB: all 4 tenant_info fields persisted correctly");
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

    // ── Part 4: Profile persistence — phone + address + unit saved to profiles ──

    printSection("Triage — Profile Persistence");

    // Simulate: tenant info collection completed → persist defaults to profile
    const { error: defaultsPersistErr } = await tenantClient
      .from("profiles")
      .update({
        phone: "555-999-1234",
        default_property_address: "456 Oak Ave",
        default_unit_number: "Unit 7",
      })
      .eq("id", userId)
      .select("id")
      .single();

    if (!defaultsPersistErr) {
      pass("DB: phone + address + unit persisted to profiles table");
    } else {
      fail("DB: profile defaults persist failed", defaultsPersistErr.message);
    }

    // Verify via admin read
    const { data: profileAfter } = await admin
      .from("profiles")
      .select("phone, email, default_property_address, default_unit_number")
      .eq("id", userId)
      .single();

    if (profileAfter?.phone === "555-999-1234") {
      pass("DB: profiles.phone matches contact_phone from triage");
    } else {
      fail("DB: profiles.phone mismatch", profileAfter?.phone);
    }

    if (profileAfter?.default_property_address === "456 Oak Ave") {
      pass("DB: profiles.default_property_address matches reported_address");
    } else {
      fail("DB: profiles.default_property_address mismatch", profileAfter?.default_property_address);
    }

    if (profileAfter?.default_unit_number === "Unit 7") {
      pass("DB: profiles.default_unit_number matches reported_unit_number");
    } else {
      fail("DB: profiles.default_unit_number mismatch", profileAfter?.default_unit_number);
    }

    if (profileAfter?.email === email) {
      pass("DB: profiles.email unchanged (auth email preserved)");
    } else {
      fail("DB: profiles.email changed unexpectedly", profileAfter?.email);
    }

    // ── Part 5: CONFIRM_PROFILE on second ticket — "yes" → GATHER_INFO directly ──

    printSection("Triage — CONFIRM_PROFILE Flow (yes → GATHER_INFO)");

    // Load profile (simulates what handleFirstMessage does)
    const { data: profile2 } = await tenantClient
      .from("profiles")
      .select("phone, email, default_property_address, default_unit_number")
      .eq("id", userId)
      .single();

    if (profile2?.phone && profile2?.default_property_address && profile2?.default_unit_number) {
      pass("CONFIRM_PROFILE: all profile defaults set for returning tenant");
    } else {
      fail("CONFIRM_PROFILE: profile defaults not set", profile2);
    }

    // Build tenant info seeded from profile (all 4 fields filled)
    const seededTenantInfo: TenantInfo = {
      reported_address: profile2?.default_property_address ?? null,
      reported_unit_number: profile2?.default_unit_number ?? null,
      contact_phone: profile2?.phone ?? null,
      contact_email: profile2?.email ?? null,
    };

    // Verify all fields filled → no missing
    if (getNextMissingTenantInfo(seededTenantInfo) === null) {
      pass("CONFIRM_PROFILE: all 4 fields filled, no missing");
    } else {
      fail("CONFIRM_PROFILE: unexpected missing field", getNextMissingTenantInfo(seededTenantInfo));
    }

    // Create second ticket with CONFIRM_PROFILE state
    const { data: ticket2, error: ticket2Err } = await tenantClient
      .from("tickets")
      .insert({
        title: "Test second ticket",
        description: "Another issue",
        tenant_id: userId,
        unit_id: null,
        triage_state: "CONFIRM_PROFILE",
        classification: {
          gathered: buildInitialGathered(),
          current_question: null,
          tenant_info: seededTenantInfo,
        } as unknown as import("../../src/lib/supabase/database-generated").Json,
      })
      .select("id, triage_state, classification")
      .single();

    if (ticket2Err || !ticket2) {
      fail("CONFIRM_PROFILE: ticket2 creation failed", ticket2Err?.message);
    } else {
      if (ticket2.triage_state === "CONFIRM_PROFILE") {
        pass("CONFIRM_PROFILE: ticket2 created with CONFIRM_PROFILE state");
      } else {
        fail("CONFIRM_PROFILE: ticket2 wrong state", ticket2.triage_state);
      }

      // Simulate "yes" via stepTenantInfo(seeded, null, "") — should go to GATHER_INFO
      const yesResult = stepTenantInfo(seededTenantInfo, null, "");

      if (yesResult.next_state === "GATHER_INFO") {
        pass("CONFIRM_PROFILE yes: stepTenantInfo → GATHER_INFO directly (all 4 filled)");
      } else {
        fail("CONFIRM_PROFILE yes: expected GATHER_INFO", yesResult.next_state);
      }

      if (yesResult.current_question === "category") {
        pass("CONFIRM_PROFILE yes: next question is category");
      } else {
        fail("CONFIRM_PROFILE yes: wrong next question", yesResult.current_question);
      }

      // Verify all 4 fields preserved
      if (
        yesResult.tenant_info.reported_address === seededTenantInfo.reported_address &&
        yesResult.tenant_info.reported_unit_number === seededTenantInfo.reported_unit_number &&
        yesResult.tenant_info.contact_phone === seededTenantInfo.contact_phone &&
        yesResult.tenant_info.contact_email === seededTenantInfo.contact_email
      ) {
        pass("CONFIRM_PROFILE yes: all 4 tenant_info fields preserved");
      } else {
        fail("CONFIRM_PROFILE yes: tenant_info mismatch", yesResult.tenant_info);
      }

      // Persist the "yes" transition to DB
      const yesClassification: TriageClassification = {
        gathered: yesResult.gathered ?? buildInitialGathered(),
        current_question: yesResult.current_question,
        tenant_info: yesResult.tenant_info,
      };

      const { data: afterYes, error: yesErr } = await tenantClient
        .from("tickets")
        .update({
          triage_state: yesResult.next_state,
          classification: yesClassification as unknown as import("../../src/lib/supabase/database-generated").Json,
        })
        .eq("id", ticket2.id)
        .select("id, triage_state, classification")
        .single();

      if (yesErr || !afterYes) {
        fail("CONFIRM_PROFILE yes: DB update failed", yesErr?.message);
      } else {
        if (afterYes.triage_state === "GATHER_INFO") {
          pass("CONFIRM_PROFILE yes: DB state is GATHER_INFO (skipped COLLECT_TENANT_INFO)");
        } else {
          fail("CONFIRM_PROFILE yes: DB state wrong", afterYes.triage_state);
        }
      }

      // ── Part 6: "change" path — clears address/unit/phone, keeps email ──

      printSection("Triage — CONFIRM_PROFILE Change Path");

      // Reset ticket2 to CONFIRM_PROFILE to test "change"
      await tenantClient
        .from("tickets")
        .update({
          triage_state: "CONFIRM_PROFILE",
          classification: {
            gathered: buildInitialGathered(),
            current_question: null,
            tenant_info: seededTenantInfo,
          } as unknown as import("../../src/lib/supabase/database-generated").Json,
        })
        .eq("id", ticket2.id);

      // Simulate "change" — clear address/unit/phone, keep email
      const clearedInfo: TenantInfo = {
        reported_address: null,
        reported_unit_number: null,
        contact_phone: null,
        contact_email: seededTenantInfo.contact_email,
      };
      const firstMissing = getNextMissingTenantInfo(clearedInfo);

      const changeClassification: TriageClassification = {
        gathered: buildInitialGathered(),
        current_question: firstMissing ?? "reported_address",
        tenant_info: clearedInfo,
      };

      const { data: afterChange, error: changeErr } = await tenantClient
        .from("tickets")
        .update({
          triage_state: "COLLECT_TENANT_INFO",
          classification: changeClassification as unknown as import("../../src/lib/supabase/database-generated").Json,
        })
        .eq("id", ticket2.id)
        .select("id, triage_state, classification")
        .single();

      if (changeErr || !afterChange) {
        fail("CONFIRM_PROFILE change: update failed", changeErr?.message);
      } else {
        if (afterChange.triage_state === "COLLECT_TENANT_INFO") {
          pass("CONFIRM_PROFILE change: transitioned to COLLECT_TENANT_INFO");
        } else {
          fail("CONFIRM_PROFILE change: wrong state", afterChange.triage_state);
        }

        const changeStored = afterChange.classification as unknown as TriageClassification;
        if (
          changeStored.tenant_info?.reported_address === null &&
          changeStored.tenant_info?.reported_unit_number === null &&
          changeStored.tenant_info?.contact_phone === null
        ) {
          pass("CONFIRM_PROFILE change: address/unit/phone cleared");
        } else {
          fail("CONFIRM_PROFILE change: fields not cleared", changeStored.tenant_info);
        }

        if (changeStored.tenant_info?.contact_email === seededTenantInfo.contact_email) {
          pass("CONFIRM_PROFILE change: email preserved from auth");
        } else {
          fail("CONFIRM_PROFILE change: email lost", changeStored.tenant_info?.contact_email);
        }

        if (changeStored.current_question === "reported_address") {
          pass("CONFIRM_PROFILE change: starts at reported_address");
        } else {
          fail("CONFIRM_PROFILE change: wrong current_question", changeStored.current_question);
        }
      }

      // Cleanup ticket2
      await admin.from("messages").delete().eq("ticket_id", ticket2.id);
      await admin.from("tickets").delete().eq("id", ticket2.id);
    }

    // ── Part 7: RLS cross-tenant profile isolation (phone + default_* columns) ──

    printSection("Triage — RLS Profile Isolation");

    let tenantBUserId: string | undefined;
    try {
      const { userId: bUserId, email: bEmail } = await createTestUser(admin, "nounit-tenantB", "tenant");
      tenantBUserId = bUserId;
      const tenantBClient = await getAuthenticatedClient(bEmail, TEST_PASSWORD);

      // TenantB tries to update tenantA's profile phone
      const { data: rlsResult } = await tenantBClient
        .from("profiles")
        .update({ phone: "hacked" })
        .eq("id", userId)
        .select("id");

      if (!rlsResult || rlsResult.length === 0) {
        pass("RLS: tenantB cannot update tenantA's phone (no rows returned)");
      } else {
        fail("RLS: tenantB was able to update tenantA's phone!", rlsResult);
      }

      // TenantB tries to update tenantA's default_property_address
      const { data: rlsAddrResult } = await tenantBClient
        .from("profiles")
        .update({ default_property_address: "hacked address" })
        .eq("id", userId)
        .select("id");

      if (!rlsAddrResult || rlsAddrResult.length === 0) {
        pass("RLS: tenantB cannot update tenantA's default_property_address");
      } else {
        fail("RLS: tenantB updated tenantA's address!", rlsAddrResult);
      }

      // TenantB tries to update tenantA's default_unit_number
      const { data: rlsUnitResult } = await tenantBClient
        .from("profiles")
        .update({ default_unit_number: "hacked unit" })
        .eq("id", userId)
        .select("id");

      if (!rlsUnitResult || rlsUnitResult.length === 0) {
        pass("RLS: tenantB cannot update tenantA's default_unit_number");
      } else {
        fail("RLS: tenantB updated tenantA's unit!", rlsUnitResult);
      }

      // Verify tenantA's profile is unchanged
      const { data: tenantAProfile } = await admin
        .from("profiles")
        .select("phone, default_property_address, default_unit_number")
        .eq("id", userId)
        .single();

      if (
        tenantAProfile?.phone === "555-999-1234" &&
        tenantAProfile?.default_property_address === "456 Oak Ave" &&
        tenantAProfile?.default_unit_number === "Unit 7"
      ) {
        pass("RLS: tenantA's profile unchanged after cross-tenant attempts");
      } else {
        fail("RLS: tenantA's profile was modified!", tenantAProfile);
      }
    } catch (e) {
      fail("RLS isolation test threw", e);
    } finally {
      if (tenantBUserId) {
        await cleanupTestUser(admin, tenantBUserId);
      }
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
