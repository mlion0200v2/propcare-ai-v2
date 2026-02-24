/**
 * Test 2–3: Supabase Connectivity + Table Schema
 * Run:  npx tsx tests/integration/test-supabase.ts
 */
import {
  createRunner,
  printSection,
  getAdminClient,
  isIntegrationEnabled,
  runStandalone,
  type TestResult,
  type SupabaseClient,
  type Database,
} from "./helpers";

// ── 2. Connectivity ──

export async function testSupabaseConnection(): Promise<
  TestResult & { client: SupabaseClient<Database> | null }
> {
  printSection("Supabase Connectivity");
  const { pass, fail, skip, result } = createRunner();

  if (!isIntegrationEnabled()) {
    skip("Supabase connectivity", "RUN_INTEGRATION !== 1");
    return { ...result, client: null };
  }

  const client = getAdminClient();

  if (!client) {
    skip("Supabase connectivity", "missing SUPABASE_URL or SERVICE_ROLE_KEY");
    return { ...result, client: null };
  }

  try {
    const { count, error } = await client
      .from("profiles")
      .select("*", { count: "exact", head: true });

    if (error) throw error;
    pass(`Connected to Supabase (profiles row count: ${count ?? 0})`);
    return { ...result, client };
  } catch (e) {
    fail("Connection failed", e);
    return { ...result, client: null };
  }
}

// ── 3. Table Schema ──

export async function testTableSchema(
  client: SupabaseClient<Database> | null
): Promise<TestResult> {
  printSection("Table Schema Validation (7 tables)");
  const { pass, fail, skip, result } = createRunner();

  if (!client) {
    skip("Schema validation", "no Supabase connection");
    return result;
  }

  const expectedSchema: Record<string, string[]> = {
    profiles: [
      "id", "email", "full_name", "phone", "role",
      "avatar_url", "created_at", "updated_at",
    ],
    properties: [
      "id", "manager_id", "address_line1", "address_line2",
      "city", "state", "zip", "property_type",
      "created_at", "updated_at",
    ],
    units: [
      "id", "property_id", "unit_number", "tenant_id",
      "status", "created_at", "updated_at",
    ],
    tickets: [
      "id", "unit_id", "tenant_id", "assigned_to",
      "title", "description", "category", "priority", "status",
      "classification", "safety_assessment",
      "similar_issues", "troubleshooting_steps",
      "created_at", "updated_at", "resolved_at",
    ],
    ticket_media: [
      "id", "ticket_id", "file_path", "file_type",
      "mime_type", "file_size", "display_order",
      "uploaded_by", "created_at",
    ],
    messages: [
      "id", "ticket_id", "sender_id", "body", "created_at",
    ],
    vendors: [
      "id", "manager_id", "name", "trade", "phone",
      "email", "rating", "notes", "created_at", "updated_at",
    ],
  };

  for (const [table, columns] of Object.entries(expectedSchema)) {
    try {
      const { error } = await client
        .from(table as any)
        .select(columns.join(", "), { head: true });

      if (error) throw error;
      pass(`${table} — all ${columns.length} columns present`);
    } catch (e) {
      fail(`${table} — schema mismatch`, e);
    }
  }

  return result;
}

// Standalone
const isMain = process.argv[1]?.replace(/\.ts$/, "").endsWith("test-supabase");
if (isMain) {
  runStandalone(async () => {
    const { client, ...r1 } = await testSupabaseConnection();
    const r2 = await testTableSchema(client);
    return {
      passed: r1.passed + r2.passed,
      failed: r1.failed + r2.failed,
      skipped: r1.skipped + r2.skipped,
    };
  });
}
