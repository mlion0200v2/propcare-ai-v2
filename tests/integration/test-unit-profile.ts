/**
 * Test: unit profiles, chat hints, address confirmation
 * Run:  npx tsx tests/integration/test-unit-profile.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { createRunner, printSection, runStandalone, type TestResult } from "./helpers";
import { buildChatHints } from "../../src/assistant/triage/hints";
import { fixtureLines, parseFixtureLines, profileFromForm, readUnitProfile } from "../../src/lib/units/profile";
import { createTestDatabase, queryAs, tryAs, type Actor } from "../db/pglite-supabase";

const SRC = join(__dirname, "..", "..", "src");

async function authUser(db: PGlite, label: string): Promise<string> {
  const id = (await db.query<{ id: string }>("select gen_random_uuid() as id")).rows[0].id;
  await db.query("insert into auth.users (id, email, email_confirmed_at) values ($1, $2, now())", [id, `${label}-${id.slice(0, 8)}@example.com`]);
  return id;
}

export async function testUnitProfile(): Promise<TestResult> {
  printSection("Unit profiles and chat hints");
  const { pass, fail, result } = createRunner();
  const check = (cond: boolean, msg: string, detail?: unknown) => (cond ? pass(msg) : fail(msg, detail));

  // Profile form parsing
  const parsed = profileFromForm({
    rooms: "Main bathroom (hallway)\n\nEnsuite\nKitchen\n",
    fixtures: "Dishwasher | Kitchen | Bosch | SHE3AR75UC\nHot water tank | Laundry\n | ignored",
    water_shutoff: " Laundry closet ",
    breaker_panel: "",
    access_notes: "",
    pets: "Cat",
  });
  check(parsed.success && parsed.data.rooms.length === 3, "rooms: one per line, blanks dropped", parsed);
  check(parsed.success && parsed.data.fixtures.length === 2 && parsed.data.fixtures[0].model === "SHE3AR75UC", "fixtures: name | room | brand | model");
  check(parsed.success && parsed.data.water_shutoff === "Laundry closet" && parsed.data.breaker_panel === undefined, "text fields trimmed; empty ones dropped");
  check(
    fixtureLines(parseFixtureLines("Dishwasher | Kitchen | Bosch | X1")) === "Dishwasher | Kitchen | Bosch | X1" &&
      fixtureLines(parseFixtureLines("Fan | Bath")) === "Fan | Bath",
    "fixture lines round-trip for the editor"
  );
  check(!profileFromForm({ rooms: "x".repeat(81), fixtures: "", water_shutoff: "", breaker_panel: "", access_notes: "", pets: "" }).success, "over-long room names are rejected");
  check(readUnitProfile(null).rooms.length === 0 && readUnitProfile({ rooms: "nope" }).rooms.length === 0, "bad stored profiles read as empty");

  // Hints
  const profile = readUnitProfile({
    rooms: ["Main bathroom (hallway)", "Ensuite", "Kitchen"],
    fixtures: [{ name: "Dishwasher", brand: "Bosch", model: "SHE3AR75UC" }],
    water_shutoff: "Laundry closet, blue lever",
    breaker_panel: "Hallway closet",
  });
  const where = buildChatHints({ currentQuestion: "location_in_unit", triageState: "GATHER_INFO", category: "plumbing", description: "Water leaking from the ceiling", profile });
  check(where.quickReplies.join("|") === "Main bathroom (hallway)|Ensuite|Kitchen", "'Where?' offers the unit's own rooms", where);
  check(where.notes.some((n) => n.includes("Laundry closet, blue lever")), "water problems show where the main shut-off is");
  check(where.notes.some((n) => n.includes("Hallway closet")), "water near a ceiling/light also shows the breaker panel");
  const generic = buildChatHints({ currentQuestion: "location_in_unit", triageState: "GATHER_INFO", category: null, description: "noise", profile: readUnitProfile({}) });
  check(generic.quickReplies.includes("Kitchen") && generic.notes.length === 0, "without a profile: generic rooms, no notes");
  const model = buildChatHints({ currentQuestion: "brand_model", triageState: "GATHER_INFO", category: "appliance", description: "dishwasher won't drain", profile });
  check(model.quickReplies[0] === "Bosch Dishwasher SHE3AR75UC" && model.quickReplies.includes("Unknown"), "brand/model offers the unit's appliances");
  check(buildChatHints({ currentQuestion: "location_in_unit", triageState: "DONE", category: "plumbing", description: "leak", profile }).quickReplies.length === 0, "nothing once the request is done");
  check(buildChatHints({ currentQuestion: "safety_check", triageState: "GATHER_INFO", category: "plumbing", description: "leak", profile }).quickReplies.length === 0, "no tap-answers for the safety question (it must be answered in words)");

  // Address confirmation on the tenant link
  const linkPage = readFileSync(join(SRC, "app", "r", "[token]", "page.tsx"), "utf8");
  check(/<ConfirmHome address=\{unitLabel\(unit\)\}>\s*<IntakeForm/.test(linkPage), "tenant link asks 'Is the problem at …?' before anything else");

  // Only the team edits a unit's profile
  const db = await createTestDatabase();
  try {
    const admin = await authUser(db, "admin");
    const tenant = await authUser(db, "tenant");
    const neighbour = await authUser(db, "neighbour");
    const owner = await authUser(db, "owner");
    await queryAs(db, { kind: "service" }, "select create_demo_sandbox($1, $2, $3, $4)", [admin, owner, tenant, neighbour]);
    const asAdmin: Actor = { kind: "user", id: admin };
    const upd = await tryAs(db, asAdmin, "update units set profile = '{\"rooms\":[\"Den\"]}'::jsonb where unit_number = '305' returning id");
    check(upd.ok && upd.affected === 1, "team can edit a unit profile", upd);
    const byTenant = await tryAs(db, { kind: "user", id: tenant }, "update units set profile = '{}'::jsonb where unit_number = '304'");
    check(!byTenant.ok || byTenant.affected === 0, "tenants can't edit unit profiles");
    const byOwner = await tryAs(db, { kind: "user", id: owner }, "update units set profile = '{}'::jsonb where unit_number = '304'");
    check(!byOwner.ok || byOwner.affected === 0, "owners can't edit unit profiles");
    const tenantRead = await queryAs<{ profile: { water_shutoff?: string } }>(db, { kind: "user", id: tenant }, "select profile from units");
    check(tenantRead.length === 1 && !!tenantRead[0].profile.water_shutoff, "the tenant's chat can read their own unit's profile (and no other)");
  } catch (err) {
    fail("profile RLS test threw", err);
  }
  await db.close();

  return result;
}

const isMain = process.argv[1]?.replace(/\.ts$/, "").endsWith("test-unit-profile");
if (isMain) runStandalone(() => testUnitProfile());
