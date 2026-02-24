/**
 * Test 4: Enum Validation (DB-generated types vs app constants)
 * Run:  npx tsx tests/integration/test-enums.ts
 */
import {
  createRunner,
  printSection,
  arraysEqual,
  runStandalone,
  type TestResult,
  type SupabaseClient,
  type Database,
} from "./helpers";

import { Constants } from "../../src/lib/supabase/database-generated";

import {
  TICKET_CATEGORIES,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  PROPERTY_TYPES,
  UNIT_STATUSES,
  USER_ROLES,
  MEDIA_TYPES,
} from "../../src/lib/utils/constants";

export async function testEnums(
  client?: SupabaseClient<Database> | null
): Promise<TestResult> {
  printSection("Enum Validation (DB-generated vs app constants)");
  const { pass, fail, result } = createRunner();

  const dbEnums = Constants.public.Enums;

  const checks: Array<{
    name: string;
    dbValues: readonly string[];
    appValues: readonly string[];
  }> = [
    { name: "user_role", dbValues: dbEnums.user_role, appValues: USER_ROLES },
    { name: "property_type", dbValues: dbEnums.property_type, appValues: PROPERTY_TYPES },
    { name: "unit_status", dbValues: dbEnums.unit_status, appValues: UNIT_STATUSES },
    { name: "ticket_status", dbValues: dbEnums.ticket_status, appValues: TICKET_STATUSES },
    { name: "ticket_priority", dbValues: dbEnums.ticket_priority, appValues: TICKET_PRIORITIES },
    { name: "ticket_category", dbValues: dbEnums.ticket_category, appValues: TICKET_CATEGORIES },
    { name: "media_type", dbValues: dbEnums.media_type, appValues: MEDIA_TYPES },
  ];

  for (const { name, dbValues, appValues } of checks) {
    if (arraysEqual(dbValues, appValues)) {
      pass(`${name} — DB ↔ app constants match (${dbValues.length} values)`);
    } else {
      fail(`${name} — MISMATCH`);
      console.log(`     DB:  [${[...dbValues].sort().join(", ")}]`);
      console.log(`     App: [${[...appValues].sort().join(", ")}]`);
    }
  }

  // Verify enum filtering works at the DB level (requires Supabase connection)
  if (client) {
    try {
      const { error } = await client
        .from("tickets")
        .select("id", { head: true })
        .eq("status", "open")
        .eq("priority", "emergency")
        .eq("category", "plumbing");
      if (error) throw error;
      pass("DB enum filtering works (status + priority + category)");
    } catch (e) {
      fail("DB enum filtering failed", e);
    }
  }

  return result;
}

// Standalone
const isMain = process.argv[1]?.replace(/\.ts$/, "").endsWith("test-enums");
if (isMain) runStandalone(() => testEnums());
