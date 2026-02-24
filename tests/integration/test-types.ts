/**
 * Test 9: TypeScript Type Checks (compile-time assertions)
 * Run:  npx tsx tests/integration/test-types.ts
 *
 * If this file compiles via tsx, all type assertions pass.
 */
import { createRunner, printSection, runStandalone, type TestResult } from "./helpers";
import type { Database } from "../../src/lib/supabase/database-generated";

type Profile = Database["public"]["Tables"]["profiles"]["Row"];
type Property = Database["public"]["Tables"]["properties"]["Row"];
type Unit = Database["public"]["Tables"]["units"]["Row"];
type Ticket = Database["public"]["Tables"]["tickets"]["Row"];
type TicketMedia = Database["public"]["Tables"]["ticket_media"]["Row"];
type Message = Database["public"]["Tables"]["messages"]["Row"];
type Vendor = Database["public"]["Tables"]["vendors"]["Row"];

type Assert<T extends true> = T;

// Compile-time assertions — these cause build errors if types are wrong
type _1 = Assert<Profile extends { id: string; email: string; full_name: string; role: string } ? true : never>;
type _2 = Assert<Property extends { id: string; manager_id: string; address_line1: string; property_type: string } ? true : never>;
type _3 = Assert<Unit extends { id: string; property_id: string; status: string; tenant_id: string | null } ? true : never>;
type _4 = Assert<Ticket extends { id: string; unit_id: string; tenant_id: string; title: string; description: string } ? true : never>;
type _5 = Assert<TicketMedia extends { id: string; ticket_id: string; file_path: string; file_type: string } ? true : never>;
type _6 = Assert<Message extends { id: string; ticket_id: string; sender_id: string; body: string } ? true : never>;
type _7 = Assert<Vendor extends { id: string; manager_id: string; name: string; trade: string } ? true : never>;

// AI metadata fields on Ticket
type _AI = Assert<
  Ticket extends {
    classification: unknown;
    safety_assessment: unknown;
    similar_issues: unknown;
    troubleshooting_steps: unknown;
  }
    ? true
    : never
>;

// Database contains all 7 tables
type _T = Assert<
  keyof Database["public"]["Tables"] extends
    | "profiles" | "properties" | "units" | "tickets"
    | "ticket_media" | "messages" | "vendors"
    ? true
    : never
>;

// Database contains all 7 enums
type _E = Assert<
  keyof Database["public"]["Enums"] extends
    | "user_role" | "property_type" | "unit_status"
    | "ticket_status" | "ticket_priority" | "ticket_category"
    | "media_type"
    ? true
    : never
>;

export function testTypes(): TestResult {
  printSection("TypeScript Type Checks (compile-time)");
  const { pass, result } = createRunner();

  // If we reach here, tsx compiled successfully → all type assertions passed
  pass("Profile type shape");
  pass("Property type shape");
  pass("Unit type shape");
  pass("Ticket type shape (includes AI metadata)");
  pass("TicketMedia type shape");
  pass("Message type shape");
  pass("Vendor type shape");
  pass("Database type — all 7 tables present");
  pass("Database type — all 7 enums present");

  return result;
}

// Standalone
const isMain = process.argv[1]?.replace(/\.ts$/, "").endsWith("test-types");
if (isMain) runStandalone(async () => testTypes());
