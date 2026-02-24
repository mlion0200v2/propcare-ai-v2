/**
 * Test: End-to-End Workflow
 * Run:  RUN_INTEGRATION=1 npx tsx tests/integration/test-e2e.ts
 *
 * Creates a full data chain (user → profile → property → unit → ticket →
 * message → AI metadata → vendor), verifies nested reads, then cleans up.
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

export async function testE2E(
  adminClient?: SupabaseClient<Database> | null
): Promise<TestResult> {
  printSection("End-to-End Workflow");
  const { pass, fail, skip, result } = createRunner();

  if (!isIntegrationEnabled()) {
    skip("E2E tests", "RUN_INTEGRATION !== 1");
    return result;
  }

  const client = adminClient ?? getAdminClient();
  if (!client) {
    skip("E2E tests", "no Supabase connection");
    return result;
  }

  const userIds: string[] = [];

  try {
    // a. Create test user via helper
    const manager = await createTestUser(client, "e2e-mgr", "manager");
    userIds.push(manager.userId);
    pass(`Auth user + profile created (${manager.email})`);

    // b. Create property
    const { data: property, error: propErr } = await client
      .from("properties")
      .insert({
        manager_id: manager.userId,
        address_line1: "100 E2E Blvd",
        city: "Austin",
        state: "TX",
        zip: "78701",
        property_type: "multi_unit",
      })
      .select()
      .single();
    if (propErr) throw new Error(`Property: ${propErr.message}`);
    pass(`Property created (${property.id.slice(0, 8)}...)`);

    // c. Create unit
    const { data: unit, error: unitErr } = await client
      .from("units")
      .insert({
        property_id: property.id,
        unit_number: "E2E-101",
        tenant_id: manager.userId,
        status: "occupied",
      })
      .select()
      .single();
    if (unitErr) throw new Error(`Unit: ${unitErr.message}`);
    pass(`Unit created (${unit.id.slice(0, 8)}...)`);

    // d. Create ticket
    const { data: ticket, error: ticketErr } = await client
      .from("tickets")
      .insert({
        unit_id: unit.id,
        tenant_id: manager.userId,
        title: "E2E Validation Test Ticket",
        description: "Automated Phase 1 validation — safe to delete",
        category: "plumbing",
        priority: "low",
        status: "open",
      })
      .select()
      .single();
    if (ticketErr) throw new Error(`Ticket: ${ticketErr.message}`);
    pass(`Ticket created (${ticket.id.slice(0, 8)}...)`);

    // e. Create message
    const { error: msgErr } = await client.from("messages").insert({
      ticket_id: ticket.id,
      sender_id: manager.userId,
      body: "Phase 1 E2E validation message",
    });
    if (msgErr) throw new Error(`Message: ${msgErr.message}`);
    pass("Message created");

    // f. Update ticket with AI triage metadata
    const { error: aiErr } = await client
      .from("tickets")
      .update({
        classification: {
          category: "plumbing",
          confidence: 0.95,
          reasoning: "Keyword match: faucet, leak",
        },
        safety_assessment: {
          is_emergency: false,
          risk_level: "low",
          reasoning: "No safety hazard detected",
        },
        similar_issues: [
          {
            ticket_id: "00000000-0000-0000-0000-000000000001",
            score: 0.87,
            summary: "Similar leak in unit 203",
          },
        ],
        troubleshooting_steps: [
          { step: 1, description: "Check faucet handle tightness", completed: false },
          { step: 2, description: "Inspect washer for wear", completed: false },
        ],
        status: "resolved",
        resolved_at: new Date().toISOString(),
      })
      .eq("id", ticket.id);
    if (aiErr) throw new Error(`AI update: ${aiErr.message}`);
    pass("Ticket updated with AI metadata + resolved");

    // g. Read back with nested joins
    const { data: full, error: readErr } = await client
      .from("tickets")
      .select(
        `
        *,
        unit:units ( id, unit_number, property:properties ( id, address_line1, city ) ),
        messages ( id, body, created_at )
      `
      )
      .eq("id", ticket.id)
      .single();

    if (readErr) throw new Error(`Read-back: ${readErr.message}`);

    const checks = {
      hasTicket: !!full.id,
      hasClassification: !!full.classification,
      hasSafetyAssessment: !!full.safety_assessment,
      hasSimilarIssues: Array.isArray(full.similar_issues),
      hasTroubleshooting: Array.isArray(full.troubleshooting_steps),
      hasUnit: !!(full as any).unit,
      hasMessages: !!((full as any).messages?.length > 0),
      isResolved: full.status === "resolved",
      hasResolvedAt: !!full.resolved_at,
    };

    if (Object.values(checks).every(Boolean)) {
      pass("Data chain: ticket → AI metadata (4 JSONB fields)");
      pass("Data chain: ticket → unit → property (nested join)");
      pass("Data chain: ticket → messages");
      pass("Data chain: status = resolved, resolved_at set");
    } else {
      fail("Data chain incomplete", JSON.stringify(checks, null, 2));
    }

    // h. Create vendor
    const { error: vendorErr } = await client.from("vendors").insert({
      manager_id: manager.userId,
      name: "E2E Test Plumber",
      trade: "plumbing",
      phone: "512-555-0000",
      email: "e2e-vendor@test.local",
      rating: 4.5,
    });
    if (vendorErr) throw new Error(`Vendor: ${vendorErr.message}`);
    pass("Vendor created (manager → vendor relationship)");

  } catch (e) {
    fail("E2E workflow failed", e);
  } finally {
    for (const userId of userIds) {
      try {
        await cleanupTestUser(client, userId);
      } catch (e) {
        fail("Cleanup failed — manual cleanup may be needed", e);
      }
    }
    if (userIds.length > 0) {
      pass("Cleanup complete (test users + cascade data removed)");
    }
  }

  return result;
}

// Standalone
const isMain = process.argv[1]?.replace(/\.ts$/, "").endsWith("test-e2e");
if (isMain) runStandalone(() => testE2E());
