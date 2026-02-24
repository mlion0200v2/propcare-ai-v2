/**
 * Test: Foreign Key Constraints
 * Run:  RUN_INTEGRATION=1 npx tsx tests/integration/test-fk-constraints.ts
 *
 * Verifies FK constraints prevent orphaned rows and that cascade / SET NULL
 * behavior matches the schema definition.
 */
import {
  createRunner,
  printSection,
  getAdminClient,
  createTestUser,
  cleanupTestUser,
  isIntegrationEnabled,
  runStandalone,
  type TestResult,
  type SupabaseClient,
  type Database,
} from "./helpers";

export async function testFKConstraints(
  adminClient?: SupabaseClient<Database> | null
): Promise<TestResult> {
  printSection("Foreign Key Constraints");
  const { pass, fail, skip, result } = createRunner();

  if (!isIntegrationEnabled()) {
    skip("FK constraint tests", "RUN_INTEGRATION !== 1");
    return result;
  }

  const admin = adminClient ?? getAdminClient();
  if (!admin) {
    skip("FK constraint tests", "missing Supabase credentials");
    return result;
  }

  const userIds: string[] = [];

  try {
    // ── Test 1: Orphan prevention — property with fake manager_id ──
    {
      const { error } = await admin.from("properties").insert({
        manager_id: "00000000-0000-0000-0000-000000000099",
        address_line1: "Orphan Blvd",
        city: "Nowhere",
        state: "TX",
        zip: "00000",
        property_type: "single_family",
      });
      if (error) {
        pass("FK: property with non-existent manager_id rejected");
      } else {
        fail("FK: property with non-existent manager_id was accepted!");
        await admin.from("properties").delete().eq("address_line1", "Orphan Blvd");
      }
    }

    // ── Test 2: Orphan prevention — unit with fake property_id ──
    {
      const { error } = await admin.from("units").insert({
        property_id: "00000000-0000-0000-0000-000000000099",
        unit_number: "ORPHAN-1",
        status: "vacant",
      });
      if (error) {
        pass("FK: unit with non-existent property_id rejected");
      } else {
        fail("FK: unit with non-existent property_id was accepted!");
      }
    }

    // ── Test 3: Orphan prevention — ticket with fake unit_id ──
    {
      const manager = await createTestUser(admin, "fk-mgr", "manager");
      userIds.push(manager.userId);

      const { error } = await admin.from("tickets").insert({
        unit_id: "00000000-0000-0000-0000-000000000099",
        tenant_id: manager.userId,
        title: "Orphan ticket",
        description: "Should be rejected by FK constraint",
        category: "general",
        priority: "low",
        status: "open",
      });
      if (error) {
        pass("FK: ticket with non-existent unit_id rejected");
      } else {
        fail("FK: ticket with non-existent unit_id was accepted!");
      }
    }

    // ── Setup for cascade / SET NULL tests ──
    const managerId = userIds[0]; // fk-mgr created above

    const tenant = await createTestUser(admin, "fk-tenant", "tenant");
    userIds.push(tenant.userId);

    const tenant2 = await createTestUser(admin, "fk-tenant2", "tenant");
    userIds.push(tenant2.userId);

    const { data: prop } = await admin
      .from("properties")
      .insert({
        manager_id: managerId,
        address_line1: "200 FK Test Ave",
        city: "TestCity",
        state: "TX",
        zip: "78701",
        property_type: "multi_unit",
      })
      .select()
      .single();
    if (!prop) throw new Error("Failed to create property for FK tests");

    const { data: unit } = await admin
      .from("units")
      .insert({
        property_id: prop.id,
        unit_number: "FK-101",
        tenant_id: tenant.userId,
        status: "occupied",
      })
      .select()
      .single();
    if (!unit) throw new Error("Failed to create unit for FK tests");

    const { data: ticket } = await admin
      .from("tickets")
      .insert({
        unit_id: unit.id,
        tenant_id: tenant.userId,
        title: "FK Test Ticket",
        description: "Testing FK cascade behavior",
        category: "general",
        priority: "low",
        status: "open",
      })
      .select()
      .single();
    if (!ticket) throw new Error("Failed to create ticket for FK tests");

    const { error: msgErr } = await admin.from("messages").insert({
      ticket_id: ticket.id,
      sender_id: tenant.userId,
      body: "FK test message",
    });
    if (msgErr) throw new Error(`Failed to create message: ${msgErr.message}`);

    pass("Setup: FK test data chain created (property → unit → ticket → message)");

    // ── Test 4: ON DELETE SET NULL — tenant_id on unit ──
    {
      const { data: unit2 } = await admin
        .from("units")
        .insert({
          property_id: prop.id,
          unit_number: "FK-102",
          tenant_id: tenant2.userId,
          status: "occupied",
        })
        .select()
        .single();
      if (!unit2) throw new Error("Failed to create unit2 for SET NULL test");

      // Delete tenant2's auth user (cascades to profile deletion)
      await admin.auth.admin.deleteUser(tenant2.userId);
      const idx = userIds.indexOf(tenant2.userId);
      if (idx !== -1) userIds.splice(idx, 1);

      // Check that unit2.tenant_id is now NULL
      const { data: updatedUnit } = await admin
        .from("units")
        .select("tenant_id")
        .eq("id", unit2.id)
        .single();

      if (updatedUnit && updatedUnit.tenant_id === null) {
        pass("FK: units.tenant_id SET NULL on tenant profile deletion");
      } else {
        fail("FK: units.tenant_id not set to NULL after tenant deletion", updatedUnit);
      }

      // Clean up orphaned unit
      await admin.from("units").delete().eq("id", unit2.id);
    }

    // ── Test 5: ON DELETE SET NULL — assigned_to on ticket ──
    {
      const assignee = await createTestUser(admin, "fk-assignee", "manager");

      await admin
        .from("tickets")
        .update({ assigned_to: assignee.userId })
        .eq("id", ticket.id);

      // Verify assigned_to is set
      const { data: before } = await admin
        .from("tickets")
        .select("assigned_to")
        .eq("id", ticket.id)
        .single();
      if (before?.assigned_to !== assignee.userId) {
        throw new Error("Failed to set assigned_to for SET NULL test");
      }

      // Delete assignee
      await cleanupTestUser(admin, assignee.userId);

      // Verify assigned_to is now NULL
      const { data: after } = await admin
        .from("tickets")
        .select("assigned_to")
        .eq("id", ticket.id)
        .single();

      if (after && after.assigned_to === null) {
        pass("FK: tickets.assigned_to SET NULL on assignee deletion");
      } else {
        fail("FK: tickets.assigned_to not set to NULL after assignee deletion", after);
      }
    }

    // ── Test 6: ON DELETE CASCADE — property → units → tickets → messages ──
    {
      const propId = prop.id;
      const unitId = unit.id;
      const ticketId = ticket.id;

      // Delete property
      await admin.from("properties").delete().eq("id", propId);

      // Verify cascade: unit should be gone
      const { data: unitCheck } = await admin
        .from("units")
        .select("id")
        .eq("id", unitId);

      // Verify cascade: ticket should be gone
      const { data: ticketCheck } = await admin
        .from("tickets")
        .select("id")
        .eq("id", ticketId);

      // Verify cascade: messages should be gone
      const { data: msgCheck } = await admin
        .from("messages")
        .select("id")
        .eq("ticket_id", ticketId);

      const unitGone = !unitCheck || unitCheck.length === 0;
      const ticketGone = !ticketCheck || ticketCheck.length === 0;
      const msgGone = !msgCheck || msgCheck.length === 0;

      if (unitGone && ticketGone && msgGone) {
        pass("FK: property deletion cascades to units → tickets → messages");
      } else {
        fail("FK: cascade deletion incomplete", { unitGone, ticketGone, msgGone });
      }
    }

  } catch (e) {
    fail("FK constraint test failed", e);
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
const isMain = process.argv[1]?.replace(/\.ts$/, "").endsWith("test-fk-constraints");
if (isMain) runStandalone(() => testFKConstraints());
