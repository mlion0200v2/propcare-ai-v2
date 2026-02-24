/**
 * Test: Database Triggers
 * Run:  RUN_INTEGRATION=1 npx tsx tests/integration/test-triggers.ts
 *
 * Verifies:
 * - updated_at auto-update triggers on profiles, tickets, vendors
 * - check_media_limits trigger (max 5 photos, max 1 video per ticket)
 * - Photo replacement works after deletion (count rechecked)
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

export async function testTriggers(
  adminClient?: SupabaseClient<Database> | null
): Promise<TestResult> {
  printSection("Database Triggers");
  const { pass, fail, skip, result } = createRunner();

  if (!isIntegrationEnabled()) {
    skip("Trigger tests", "RUN_INTEGRATION !== 1");
    return result;
  }

  const admin = adminClient ?? getAdminClient();
  if (!admin) {
    skip("Trigger tests", "missing Supabase credentials");
    return result;
  }

  const userIds: string[] = [];

  try {
    // ── Setup ──
    const manager = await createTestUser(admin, "trig-mgr", "manager");
    userIds.push(manager.userId);

    const tenant = await createTestUser(admin, "trig-ten", "tenant");
    userIds.push(tenant.userId);

    const { data: prop } = await admin
      .from("properties")
      .insert({
        manager_id: manager.userId,
        address_line1: "300 Trigger Test Ln",
        city: "TestCity",
        state: "TX",
        zip: "78701",
        property_type: "single_family",
      })
      .select()
      .single();
    if (!prop) throw new Error("Failed to create property");

    const { data: unit } = await admin
      .from("units")
      .insert({
        property_id: prop.id,
        tenant_id: tenant.userId,
        status: "occupied",
      })
      .select()
      .single();
    if (!unit) throw new Error("Failed to create unit");

    const { data: ticket } = await admin
      .from("tickets")
      .insert({
        unit_id: unit.id,
        tenant_id: tenant.userId,
        title: "Trigger Test Ticket",
        description: "Testing updated_at and media limit triggers",
        category: "general",
        priority: "low",
        status: "open",
      })
      .select()
      .single();
    if (!ticket) throw new Error("Failed to create ticket");

    pass("Setup: trigger test data created");

    // ── Test 1: updated_at trigger on profiles ──
    {
      const { data: before } = await admin
        .from("profiles")
        .select("updated_at")
        .eq("id", tenant.userId)
        .single();

      // Wait to ensure timestamp difference
      await new Promise((r) => setTimeout(r, 1100));

      await admin
        .from("profiles")
        .update({ full_name: "Trigger Updated Name" })
        .eq("id", tenant.userId);

      const { data: after } = await admin
        .from("profiles")
        .select("updated_at")
        .eq("id", tenant.userId)
        .single();

      if (before && after && new Date(after.updated_at) > new Date(before.updated_at)) {
        pass("Trigger: profiles.updated_at auto-updates on modification");
      } else {
        fail("Trigger: profiles.updated_at did not update", {
          before: before?.updated_at,
          after: after?.updated_at,
        });
      }
    }

    // ── Test 2: updated_at trigger on tickets ──
    {
      const { data: before } = await admin
        .from("tickets")
        .select("updated_at")
        .eq("id", ticket.id)
        .single();

      await new Promise((r) => setTimeout(r, 1100));

      await admin
        .from("tickets")
        .update({ title: "Trigger Updated Title" })
        .eq("id", ticket.id);

      const { data: after } = await admin
        .from("tickets")
        .select("updated_at")
        .eq("id", ticket.id)
        .single();

      if (before && after && new Date(after.updated_at) > new Date(before.updated_at)) {
        pass("Trigger: tickets.updated_at auto-updates on modification");
      } else {
        fail("Trigger: tickets.updated_at did not update", {
          before: before?.updated_at,
          after: after?.updated_at,
        });
      }
    }

    // ── Test 3: updated_at trigger on vendors ──
    {
      const { data: vendor } = await admin
        .from("vendors")
        .insert({
          manager_id: manager.userId,
          name: "Trigger Test Vendor",
          trade: "plumbing",
        })
        .select()
        .single();
      if (!vendor) throw new Error("Failed to create vendor");

      const beforeTs = vendor.updated_at;

      await new Promise((r) => setTimeout(r, 1100));

      await admin
        .from("vendors")
        .update({ name: "Trigger Updated Vendor" })
        .eq("id", vendor.id);

      const { data: after } = await admin
        .from("vendors")
        .select("updated_at")
        .eq("id", vendor.id)
        .single();

      if (after && new Date(after.updated_at) > new Date(beforeTs)) {
        pass("Trigger: vendors.updated_at auto-updates on modification");
      } else {
        fail("Trigger: vendors.updated_at did not update");
      }
    }

    // ── Test 4: check_media_limits — max 5 photos ──
    {
      let insertedCount = 0;
      for (let i = 1; i <= 5; i++) {
        const { error } = await admin.from("ticket_media").insert({
          ticket_id: ticket.id,
          file_path: `trigger-test/photo-${i}.jpg`,
          file_type: "photo",
          mime_type: "image/jpeg",
          file_size: 1024 * i,
          display_order: i,
          uploaded_by: tenant.userId,
        });
        if (error) {
          fail(`Trigger: photo ${i}/5 insert failed unexpectedly`, error);
          break;
        }
        insertedCount++;
      }

      if (insertedCount === 5) {
        pass("Trigger: 5 photos inserted successfully");
      }

      // 6th photo should be blocked
      const { error: sixthErr } = await admin.from("ticket_media").insert({
        ticket_id: ticket.id,
        file_path: "trigger-test/photo-6.jpg",
        file_type: "photo",
        mime_type: "image/jpeg",
        file_size: 1024,
        display_order: 6,
        uploaded_by: tenant.userId,
      });

      if (sixthErr) {
        pass("Trigger: 6th photo blocked (max 5 enforced)");
      } else {
        fail("Trigger: 6th photo was accepted — limit NOT enforced!");
      }
    }

    // ── Test 5: check_media_limits — max 1 video ──
    {
      const { error: firstVideo } = await admin.from("ticket_media").insert({
        ticket_id: ticket.id,
        file_path: "trigger-test/video-1.mp4",
        file_type: "video",
        mime_type: "video/mp4",
        file_size: 5 * 1024 * 1024,
        display_order: 1,
        uploaded_by: tenant.userId,
      });

      if (firstVideo) {
        fail("Trigger: 1st video insert failed unexpectedly", firstVideo);
      } else {
        pass("Trigger: 1st video inserted successfully");
      }

      // 2nd video should be blocked
      const { error: secondVideo } = await admin.from("ticket_media").insert({
        ticket_id: ticket.id,
        file_path: "trigger-test/video-2.mp4",
        file_type: "video",
        mime_type: "video/mp4",
        file_size: 5 * 1024 * 1024,
        display_order: 2,
        uploaded_by: tenant.userId,
      });

      if (secondVideo) {
        pass("Trigger: 2nd video blocked (max 1 enforced)");
      } else {
        fail("Trigger: 2nd video was accepted — limit NOT enforced!");
      }
    }

    // ── Test 6: Photo replacement after deletion ──
    {
      const { data: photos } = await admin
        .from("ticket_media")
        .select("id")
        .eq("ticket_id", ticket.id)
        .eq("file_type", "photo")
        .limit(1);

      if (photos && photos.length > 0) {
        await admin.from("ticket_media").delete().eq("id", photos[0].id);

        // Now inserting a photo should succeed (4 < 5)
        const { error } = await admin.from("ticket_media").insert({
          ticket_id: ticket.id,
          file_path: "trigger-test/photo-replacement.jpg",
          file_type: "photo",
          mime_type: "image/jpeg",
          file_size: 2048,
          display_order: 1,
          uploaded_by: tenant.userId,
        });

        if (!error) {
          pass("Trigger: photo replacement works after deletion (count rechecked)");
        } else {
          fail("Trigger: photo replacement blocked despite deletion", error);
        }
      } else {
        skip("Photo replacement test", "no photos found to delete");
      }
    }

  } catch (e) {
    fail("Trigger test failed", e);
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
const isMain = process.argv[1]?.replace(/\.ts$/, "").endsWith("test-triggers");
if (isMain) runStandalone(() => testTriggers());
