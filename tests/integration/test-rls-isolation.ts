/**
 * Test: RLS Isolation (multi-user)
 * Run:  RUN_INTEGRATION=1 npx tsx tests/integration/test-rls-isolation.ts
 *
 * Creates 3 test users (managerA, tenantA, tenantB) and verifies
 * that RLS policies correctly isolate data between users.
 */
import {
  createRunner,
  printSection,
  getAdminClient,
  getAuthenticatedClient,
  createTestUser,
  cleanupTestUser,
  isIntegrationEnabled,
  runStandalone,
  TEST_PASSWORD,
  type TestResult,
  type SupabaseClient,
  type Database,
} from "./helpers";

export async function testRLSIsolation(
  adminClient?: SupabaseClient<Database> | null
): Promise<TestResult> {
  printSection("RLS Isolation (Multi-User)");
  const { pass, fail, skip, result } = createRunner();

  if (!isIntegrationEnabled()) {
    skip("RLS isolation tests", "RUN_INTEGRATION !== 1");
    return result;
  }

  const admin = adminClient ?? getAdminClient();
  if (!admin) {
    skip("RLS isolation tests", "missing Supabase credentials");
    return result;
  }

  const userIds: string[] = [];

  try {
    // ── Setup: Create 3 test users ──
    const managerA = await createTestUser(admin, "rls-mgr-a", "manager");
    userIds.push(managerA.userId);

    const tenantA = await createTestUser(admin, "rls-ten-a", "tenant");
    userIds.push(tenantA.userId);

    const tenantB = await createTestUser(admin, "rls-ten-b", "tenant");
    userIds.push(tenantB.userId);

    pass("Setup: 3 test users created (managerA, tenantA, tenantB)");

    // ── Setup: Create property + units via admin ──
    const { data: property, error: propErr } = await admin
      .from("properties")
      .insert({
        manager_id: managerA.userId,
        address_line1: "100 RLS Isolation Blvd",
        city: "TestCity",
        state: "TX",
        zip: "78701",
        property_type: "multi_unit",
      })
      .select()
      .single();
    if (propErr) throw new Error(`Property: ${propErr.message}`);

    const { data: unitA, error: unitAErr } = await admin
      .from("units")
      .insert({
        property_id: property.id,
        unit_number: "A-101",
        tenant_id: tenantA.userId,
        status: "occupied",
      })
      .select()
      .single();
    if (unitAErr) throw new Error(`UnitA: ${unitAErr.message}`);

    const { data: unitB, error: unitBErr } = await admin
      .from("units")
      .insert({
        property_id: property.id,
        unit_number: "B-102",
        tenant_id: tenantB.userId,
        status: "occupied",
      })
      .select()
      .single();
    if (unitBErr) throw new Error(`UnitB: ${unitBErr.message}`);

    // ── Setup: Create tickets via admin ──
    const { data: ticketA, error: ticketAErr } = await admin
      .from("tickets")
      .insert({
        unit_id: unitA.id,
        tenant_id: tenantA.userId,
        title: "TenantA Leak",
        description: "RLS isolation test — tenantA's ticket",
        category: "plumbing",
        priority: "medium",
        status: "open",
      })
      .select()
      .single();
    if (ticketAErr) throw new Error(`TicketA: ${ticketAErr.message}`);

    const { data: ticketB, error: ticketBErr } = await admin
      .from("tickets")
      .insert({
        unit_id: unitB.id,
        tenant_id: tenantB.userId,
        title: "TenantB Electrical",
        description: "RLS isolation test — tenantB's ticket",
        category: "electrical",
        priority: "low",
        status: "open",
      })
      .select()
      .single();
    if (ticketBErr) throw new Error(`TicketB: ${ticketBErr.message}`);

    // ── Setup: Create messages via admin ──
    const { error: msgAErr } = await admin.from("messages").insert({
      ticket_id: ticketA.id,
      sender_id: tenantA.userId,
      body: "TenantA message on ticketA",
    });
    if (msgAErr) throw new Error(`MessageA: ${msgAErr.message}`);

    const { error: msgBErr } = await admin.from("messages").insert({
      ticket_id: ticketB.id,
      sender_id: tenantB.userId,
      body: "TenantB message on ticketB",
    });
    if (msgBErr) throw new Error(`MessageB: ${msgBErr.message}`);

    pass("Setup: property, 2 units, 2 tickets, 2 messages created");

    // ── Get authenticated clients ──
    const clientA = await getAuthenticatedClient(tenantA.email, TEST_PASSWORD);
    const clientB = await getAuthenticatedClient(tenantB.email, TEST_PASSWORD);
    const clientMgr = await getAuthenticatedClient(managerA.email, TEST_PASSWORD);

    // ── Test 1: Ticket isolation — tenantA sees own ticket only ──
    {
      const { data } = await clientA.from("tickets").select("id");
      const ids = (data ?? []).map((r) => r.id);
      if (ids.includes(ticketA.id) && !ids.includes(ticketB.id)) {
        pass("TenantA sees own ticket, not tenantB's ticket");
      } else {
        fail("TenantA ticket isolation failed", { saw: ids, expected: [ticketA.id] });
      }
    }

    // ── Test 2: Ticket isolation — tenantB sees own ticket only ──
    {
      const { data } = await clientB.from("tickets").select("id");
      const ids = (data ?? []).map((r) => r.id);
      if (ids.includes(ticketB.id) && !ids.includes(ticketA.id)) {
        pass("TenantB sees own ticket, not tenantA's ticket");
      } else {
        fail("TenantB ticket isolation failed", { saw: ids, expected: [ticketB.id] });
      }
    }

    // ── Test 3: Manager sees both tickets ──
    {
      const { data } = await clientMgr.from("tickets").select("id");
      const ids = (data ?? []).map((r) => r.id);
      if (ids.includes(ticketA.id) && ids.includes(ticketB.id)) {
        pass("ManagerA sees both tickets in their property");
      } else {
        fail("ManagerA ticket visibility failed", { saw: ids, expected: [ticketA.id, ticketB.id] });
      }
    }

    // ── Test 4: Message isolation — tenantA sees own messages only ──
    {
      const { data } = await clientA.from("messages").select("id, ticket_id");
      const ticketIds = [...new Set((data ?? []).map((r) => r.ticket_id))];
      if (ticketIds.length === 1 && ticketIds[0] === ticketA.id) {
        pass("TenantA sees messages on own tickets only");
      } else {
        fail("TenantA message isolation failed", { ticketIds });
      }
    }

    // ── Test 5: Message isolation — tenantB sees own messages only ──
    {
      const { data } = await clientB.from("messages").select("id, ticket_id");
      const ticketIds = [...new Set((data ?? []).map((r) => r.ticket_id))];
      if (ticketIds.length === 1 && ticketIds[0] === ticketB.id) {
        pass("TenantB sees messages on own tickets only");
      } else {
        fail("TenantB message isolation failed", { ticketIds });
      }
    }

    // ── Test 6: Manager sees messages on both tickets ──
    {
      const { data } = await clientMgr.from("messages").select("id, ticket_id");
      const ticketIds = [...new Set((data ?? []).map((r) => r.ticket_id))];
      if (ticketIds.includes(ticketA.id) && ticketIds.includes(ticketB.id)) {
        pass("ManagerA sees messages on both tickets");
      } else {
        fail("ManagerA message visibility failed", { ticketIds });
      }
    }

    // ── Test 7: Tenant status transition restriction ──
    // TenantA should NOT be able to set status to 'resolved'.
    // The update policy USING clause checks status IN ('open', 'awaiting_tenant').
    // The implicit WITH CHECK (same as USING) also validates the NEW row,
    // so 'resolved' fails the WITH CHECK.
    {
      const { error: resolveErr } = await clientA
        .from("tickets")
        .update({ status: "resolved" })
        .eq("id", ticketA.id);

      if (resolveErr) {
        pass("TenantA blocked from setting status to 'resolved'");
      } else {
        // Supabase may return success with 0 affected rows — verify via admin
        const { data: check } = await admin
          .from("tickets")
          .select("status")
          .eq("id", ticketA.id)
          .single();
        if (check?.status === "open") {
          pass("TenantA blocked from setting status to 'resolved' (no-op update)");
        } else {
          fail("TenantA was able to set status to 'resolved'!");
          await admin.from("tickets").update({ status: "open" }).eq("id", ticketA.id);
        }
      }
    }

    // ── Test 8: Tenant CAN update own open ticket (valid field change) ──
    {
      const { error } = await clientA
        .from("tickets")
        .update({ description: "Updated by tenantA — RLS test" })
        .eq("id", ticketA.id);

      if (!error) {
        pass("TenantA can update own open ticket description");
      } else {
        fail("TenantA could not update own open ticket", error);
      }
    }

    // ── Test 9: TenantA cannot update tenantB's ticket ──
    {
      const { data, error } = await clientA
        .from("tickets")
        .update({ description: "Hacked by tenantA" })
        .eq("id", ticketB.id)
        .select();

      if (error || !data || data.length === 0) {
        pass("TenantA cannot update tenantB's ticket");
      } else {
        fail("TenantA was able to update tenantB's ticket!");
      }
    }

    // ── Test 10: Unit isolation — tenantA sees own unit only ──
    {
      const { data } = await clientA.from("units").select("id");
      const ids = (data ?? []).map((r) => r.id);
      if (ids.includes(unitA.id) && !ids.includes(unitB.id)) {
        pass("TenantA sees own unit only");
      } else {
        fail("TenantA unit isolation failed", { saw: ids, expected: [unitA.id] });
      }
    }

    // ── Test 11: Profile isolation — tenantA sees own profile only ──
    {
      const { data } = await clientA.from("profiles").select("id");
      const ids = (data ?? []).map((r) => r.id);
      if (ids.includes(tenantA.userId) && !ids.includes(tenantB.userId)) {
        pass("TenantA sees own profile, not tenantB's");
      } else {
        fail("TenantA profile isolation failed", { saw: ids });
      }
    }

    // ── Test 12: Manager can see tenant profiles in their property ──
    {
      const { data } = await clientMgr.from("profiles").select("id");
      const ids = (data ?? []).map((r) => r.id);
      if (ids.includes(tenantA.userId) && ids.includes(tenantB.userId)) {
        pass("ManagerA can see tenant profiles in their property");
      } else {
        fail("ManagerA tenant profile visibility failed", { saw: ids });
      }
    }

  } catch (e) {
    fail("RLS isolation test failed", e);
  } finally {
    for (const userId of userIds) {
      try {
        await cleanupTestUser(admin, userId);
      } catch {
        // Best-effort cleanup
      }
    }
  }

  return result;
}

// Standalone
const isMain = process.argv[1]?.replace(/\.ts$/, "").endsWith("test-rls-isolation");
if (isMain) runStandalone(() => testRLSIsolation());
