/**
 * Test: Row Level Security (basic)
 * Run:  RUN_INTEGRATION=1 npx tsx tests/integration/test-rls.ts
 *
 * Seeds one row per table via admin, then confirms anon sees 0 rows
 * while admin sees > 0. This eliminates the ambiguity of checking
 * an empty table (which would return 0 rows regardless of RLS).
 */
import {
  createRunner,
  printSection,
  getAdminClient,
  getAnonClient,
  createTestUser,
  cleanupTestUser,
  isIntegrationEnabled,
  runStandalone,
  type TestResult,
  type SupabaseClient,
  type Database,
} from "./helpers";

export async function testRLS(
  adminClient?: SupabaseClient<Database> | null
): Promise<TestResult> {
  printSection("Row Level Security");
  const { pass, fail, skip, result } = createRunner();

  if (!isIntegrationEnabled()) {
    skip("RLS tests", "RUN_INTEGRATION !== 1");
    return result;
  }

  const admin = adminClient ?? getAdminClient();
  const anon = getAnonClient();

  if (!admin || !anon) {
    skip("RLS tests", "missing Supabase credentials");
    return result;
  }

  const userIds: string[] = [];

  try {
    // ── Seed test data via admin so tables are non-empty ──
    const manager = await createTestUser(admin, "rls-mgr", "manager");
    userIds.push(manager.userId);

    const tenant = await createTestUser(admin, "rls-ten", "tenant");
    userIds.push(tenant.userId);

    const { data: prop } = await admin
      .from("properties")
      .insert({
        manager_id: manager.userId,
        address_line1: "500 RLS Test Rd",
        city: "TestCity",
        state: "TX",
        zip: "78701",
        property_type: "single_family",
      })
      .select()
      .single();
    if (!prop) throw new Error("Seed: property insert failed");

    const { data: unit } = await admin
      .from("units")
      .insert({
        property_id: prop.id,
        tenant_id: tenant.userId,
        status: "occupied",
      })
      .select()
      .single();
    if (!unit) throw new Error("Seed: unit insert failed");

    const { data: ticket } = await admin
      .from("tickets")
      .insert({
        unit_id: unit.id,
        tenant_id: tenant.userId,
        title: "RLS seed ticket",
        description: "Seeded for RLS verification",
        category: "general",
        priority: "low",
        status: "open",
      })
      .select()
      .single();
    if (!ticket) throw new Error("Seed: ticket insert failed");

    await admin.from("ticket_media").insert({
      ticket_id: ticket.id,
      file_path: "rls-test/photo.jpg",
      file_type: "photo",
      mime_type: "image/jpeg",
      file_size: 1024,
      display_order: 1,
      uploaded_by: tenant.userId,
    });

    await admin.from("messages").insert({
      ticket_id: ticket.id,
      sender_id: tenant.userId,
      body: "RLS seed message",
    });

    await admin.from("vendors").insert({
      manager_id: manager.userId,
      name: "RLS Test Vendor",
      trade: "plumbing",
    });

    pass("Seeded test data in all 7 tables");

    // ── Verify anon sees 0 rows in each table ──
    const tables = [
      "profiles", "properties", "units", "tickets",
      "ticket_media", "messages", "vendors",
    ] as const;

    for (const table of tables) {
      try {
        // Admin count (should be > 0 since we just seeded)
        const { count: adminCount } = await admin
          .from(table)
          .select("*", { count: "exact", head: true });

        // Anon query
        const { data, error } = await anon
          .from(table)
          .select("id")
          .limit(1);

        if (error) {
          pass(`${table} — RLS active (query denied: ${error.code})`);
        } else if (!data || data.length === 0) {
          if (adminCount && adminCount > 0) {
            pass(`${table} — RLS active (anon sees 0 of ${adminCount} rows)`);
          } else {
            fail(`${table} — seed data missing (admin count: ${adminCount})`);
          }
        } else {
          fail(`${table} — RLS may be DISABLED (anon read ${data.length} rows)`);
        }
      } catch (e) {
        fail(`${table} — RLS check error`, e);
      }
    }

    // ── Verify anon INSERT is blocked ──
    try {
      const { error } = await anon.from("profiles").insert({
        id: "00000000-0000-0000-0000-000000000000",
        email: "rls-anon-insert@test.local",
        full_name: "RLS Anon Test",
        role: "tenant",
      } as any);

      if (error) {
        pass("Anon INSERT blocked on profiles");
      } else {
        fail("RLS FAILURE — anon INSERT succeeded on profiles!");
        await admin.from("profiles").delete().eq("email", "rls-anon-insert@test.local");
      }
    } catch {
      pass("Anon INSERT blocked on profiles (exception)");
    }

  } catch (e) {
    fail("RLS test setup failed", e);
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
const isMain = process.argv[1]?.replace(/\.ts$/, "").endsWith("test-rls");
if (isMain) runStandalone(() => testRLS());
