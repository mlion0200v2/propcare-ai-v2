/**
 * Test: RLS role-escalation (pure — runs in CI, no Supabase project needed)
 * Run:  npx tsx tests/integration/test-rls-escalation.ts
 *
 * Applies every migration in supabase/migrations to an in-process Postgres
 * (PGlite) with a minimal stand-in for Supabase's auth/storage schemas and
 * roles, then acts as each role the way PostgREST does (SET ROLE + JWT
 * claims) to prove that:
 *   - a tenant cannot make themselves a manager or change their email
 *   - a tenant can still edit their own contact details
 *   - a tenant cannot change status/priority/assignment/ownership of a ticket
 *   - a tenant cannot read unassigned tickets after an escalation attempt
 *   - managers and the service role keep the access they need
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import {
  createRunner,
  printSection,
  runStandalone,
  type TestResult,
} from "./helpers";

const MIGRATIONS_DIR = join(__dirname, "..", "..", "supabase", "migrations");

const IDS = {
  manager: "00000000-0000-4000-8000-000000000001",
  tenant: "00000000-0000-4000-8000-000000000002",
  otherTenant: "00000000-0000-4000-8000-000000000003",
  property: "00000000-0000-4000-8000-0000000000a1",
  unit: "00000000-0000-4000-8000-0000000000b1",
  tenantTicket: "00000000-0000-4000-8000-0000000000c1",
  otherTicket: "00000000-0000-4000-8000-0000000000c2",
};

/** Minimal stand-in for what Supabase provides before app migrations run. */
const SUPABASE_BOOTSTRAP = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;

  create schema auth;
  create table auth.users (id uuid primary key, email text);
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create function auth.role() returns text language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.role', true), '') $$;
  grant usage on schema auth to anon, authenticated, service_role;
  grant execute on all functions in schema auth to anon, authenticated, service_role;

  create schema storage;
  create table storage.buckets (id text primary key, name text, public boolean);
  create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
  alter table storage.objects enable row level security;
  create function storage.foldername(name text) returns text[] language sql immutable as
    $$ select string_to_array(name, '/') $$;

  -- Supabase grants table access to the API roles by default; RLS and the
  -- migrations decide what each role can actually do.
  grant usage on schema public to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
`;

function loadMigrations(): Array<{ name: string; sql: string }> {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((name) => ({
      name,
      // PGlite ships uuid-ossp as a separate module; gen_random_uuid() is
      // equivalent for these tests.
      sql: readFileSync(join(MIGRATIONS_DIR, name), "utf8").replace(
        /create extension if not exists "uuid-ossp";/i,
        () => "create function uuid_generate_v4() returns uuid language sql as $$ select gen_random_uuid() $$;"
      ),
    }));
}

async function seed(db: PGlite) {
  await db.exec(`
    insert into auth.users (id, email) values
      ('${IDS.manager}', 'manager@test.local'),
      ('${IDS.tenant}', 'tenant@test.local'),
      ('${IDS.otherTenant}', 'other@test.local');
    insert into profiles (id, email, full_name, role) values
      ('${IDS.manager}', 'manager@test.local', 'Manager', 'manager'),
      ('${IDS.tenant}', 'tenant@test.local', 'Tenant', 'tenant'),
      ('${IDS.otherTenant}', 'other@test.local', 'Other Tenant', 'tenant');
    insert into properties (id, manager_id, address_line1, city, state, zip)
      values ('${IDS.property}', '${IDS.manager}', '1 Test St', 'Vancouver', 'BC', 'V5K0A1');
    insert into units (id, property_id, unit_number, tenant_id, status)
      values ('${IDS.unit}', '${IDS.property}', '101', '${IDS.tenant}', 'occupied');
    insert into tickets (id, unit_id, tenant_id, title, description)
      values ('${IDS.tenantTicket}', '${IDS.unit}', '${IDS.tenant}', 'Leak', 'Kitchen tap leaking');
    -- Another tenant's ticket with no unit: visible to managers via migration 002
    insert into tickets (id, unit_id, tenant_id, title, description)
      values ('${IDS.otherTicket}', null, '${IDS.otherTenant}', 'Heat', 'No heat in bedroom');
  `);
}

/** Act as a user the way PostgREST does for an authenticated request. */
async function actAs(db: PGlite, role: "authenticated" | "anon" | "service_role", userId?: string) {
  await db.exec("reset role");
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [userId ?? ""]);
  await db.query("select set_config('request.jwt.claim.role', $1, false)", [role]);
  await db.exec(`set role ${role}`);
}

async function asSuperuser(db: PGlite) {
  await db.exec("reset role");
}

async function attempt(db: PGlite, sql: string): Promise<{ ok: boolean; rows: number; error?: string }> {
  try {
    const res = await db.query(sql);
    return { ok: true, rows: res.affectedRows ?? res.rows.length };
  } catch (e) {
    return { ok: false, rows: 0, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function testRLSEscalation(): Promise<TestResult> {
  printSection("RLS role escalation (PGlite, all migrations)");
  const { pass, fail, result } = createRunner();

  const db = new PGlite();
  try {
    await db.exec(SUPABASE_BOOTSTRAP);
    for (const m of loadMigrations()) {
      try {
        await db.exec(m.sql);
      } catch (e) {
        fail(`migration ${m.name} applies cleanly`, e);
        return result;
      }
    }
    pass("all migrations apply on a fresh database");
    await seed(db);

    const expectBlocked = async (label: string, sql: string) => {
      const r = await attempt(db, sql);
      if (!r.ok || r.rows === 0) pass(label);
      else fail(label, `expected the write to be rejected, but ${r.rows} row(s) changed`);
    };
    const expectAllowed = async (label: string, sql: string, rows = 1) => {
      const r = await attempt(db, sql);
      if (r.ok && r.rows === rows) pass(label);
      else fail(label, r.error ?? `expected ${rows} row(s), got ${r.rows}`);
    };
    const roleOf = async (id: string) => {
      await asSuperuser(db);
      const r = await db.query<{ role: string }>(`select role from profiles where id = '${id}'`);
      return r.rows[0]?.role;
    };

    // ── Tenant → manager escalation via profiles ──
    await actAs(db, "authenticated", IDS.tenant);
    await expectBlocked(
      "tenant cannot set own profiles.role = 'manager'",
      `update profiles set role = 'manager' where id = '${IDS.tenant}'`
    );
    await actAs(db, "authenticated", IDS.tenant);
    await expectBlocked(
      "tenant cannot change role together with an allowed column",
      `update profiles set full_name = 'Sneaky', role = 'manager' where id = '${IDS.tenant}'`
    );
    if ((await roleOf(IDS.tenant)) === "tenant") pass("tenant's role is still 'tenant' after escalation attempts");
    else fail("tenant's role is still 'tenant' after escalation attempts", await roleOf(IDS.tenant));

    await actAs(db, "authenticated", IDS.tenant);
    await expectBlocked(
      "tenant cannot change own profiles.email",
      `update profiles set email = 'attacker@test.local' where id = '${IDS.tenant}'`
    );
    await actAs(db, "authenticated", IDS.tenant);
    await expectBlocked(
      "tenant cannot insert a second (manager) profile",
      `insert into profiles (id, email, full_name, role) values ('${IDS.otherTenant}', 'x@test.local', 'X', 'manager')`
    );
    await actAs(db, "authenticated", IDS.tenant);
    await expectBlocked(
      "tenant cannot update another user's profile",
      `update profiles set full_name = 'Hacked' where id = '${IDS.otherTenant}'`
    );
    await actAs(db, "authenticated", IDS.tenant);
    await expectAllowed(
      "tenant can still update own contact details",
      `update profiles set full_name = 'Tenant Renamed', phone = '604-555-0100', default_property_address = '1 Test St', default_unit_number = '101' where id = '${IDS.tenant}'`
    );

    // ── Escalation would expose unassigned tickets; verify it doesn't ──
    await actAs(db, "authenticated", IDS.tenant);
    {
      const r = await db.query(`select id from tickets where id = '${IDS.otherTicket}'`);
      if (r.rows.length === 0) pass("tenant cannot read another tenant's unassigned ticket");
      else fail("tenant cannot read another tenant's unassigned ticket", r.rows);
      const p = await db.query(`select id from profiles where id = '${IDS.otherTenant}'`);
      if (p.rows.length === 0) pass("tenant cannot read another tenant's profile (PII)");
      else fail("tenant cannot read another tenant's profile (PII)", p.rows);
    }

    // ── Ticket column restrictions for tenants ──
    const ticketCases: Array<[string, string]> = [
      ["priority", "priority = 'emergency'"],
      ["status", "status = 'closed'"],
      ["assigned_to", `assigned_to = '${IDS.tenant}'`],
      ["tenant_id", `tenant_id = '${IDS.otherTenant}'`],
      ["unit_id", "unit_id = null"],
      ["safety_assessment", `safety_assessment = '{"flagged": false}'::jsonb`],
      ["resolved_at", "resolved_at = now()"],
    ];
    for (const [col, set] of ticketCases) {
      await actAs(db, "authenticated", IDS.tenant);
      await expectBlocked(
        `tenant cannot change tickets.${col} on own ticket`,
        `update tickets set ${set} where id = '${IDS.tenantTicket}'`
      );
    }
    await actAs(db, "authenticated", IDS.tenant);
    await expectAllowed(
      "tenant can update triage columns on own ticket",
      `update tickets set triage_state = 'GATHER_INFO', classification = '{"gathered": {}}'::jsonb, category = 'plumbing', troubleshooting_steps = '[]'::jsonb where id = '${IDS.tenantTicket}'`
    );
    await actAs(db, "authenticated", IDS.tenant);
    await expectBlocked(
      "tenant cannot create a ticket pre-set to emergency/escalated",
      `insert into tickets (unit_id, tenant_id, title, description, priority, status) values ('${IDS.unit}', '${IDS.tenant}', 'x', 'x', 'emergency', 'escalated')`
    );
    await actAs(db, "authenticated", IDS.tenant);
    await expectAllowed(
      "tenant can create a normal ticket",
      `insert into tickets (unit_id, tenant_id, title, description) values ('${IDS.unit}', '${IDS.tenant}', 'Drip', 'Bathroom tap dripping')`
    );

    // ── Anonymous users get nothing ──
    await actAs(db, "anon");
    await expectBlocked(
      "anon cannot update any profile",
      `update profiles set role = 'manager'`
    );

    // ── Legitimate paths still work ──
    await actAs(db, "authenticated", IDS.manager);
    await expectAllowed(
      "manager can update status/priority on a ticket in their property",
      `update tickets set status = 'in_progress', priority = 'high', assigned_to = '${IDS.manager}' where id = '${IDS.tenantTicket}'`
    );
    await actAs(db, "authenticated", IDS.manager);
    await expectBlocked(
      "manager cannot change their own role either",
      `update profiles set role = 'tenant' where id = '${IDS.manager}'`
    );
    await actAs(db, "service_role");
    await expectAllowed(
      "service role can escalate a ticket (server-side emergency path)",
      `update tickets set priority = 'emergency', status = 'escalated' where id = '${IDS.otherTicket}'`
    );
    await actAs(db, "service_role");
    await expectAllowed(
      "service role (admin) can provision a manager",
      `update profiles set role = 'manager' where id = '${IDS.otherTenant}'`
    );
  } catch (e) {
    fail("RLS escalation suite crashed", e);
  } finally {
    await db.close();
  }

  return result;
}

// Standalone
const isMain = process.argv[1]?.replace(/\.ts$/, "").endsWith("test-rls-escalation");
if (isMain) runStandalone(testRLSEscalation);
