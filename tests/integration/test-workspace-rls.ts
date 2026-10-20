/**
 * Test: workspace RLS (PGlite, no Supabase project needed)
 * Run:  npx tsx tests/integration/test-workspace-rls.ts
 *
 * Applies every migration to an in-process Postgres and checks, as real
 * database roles with JWT claims:
 *   - isolation between two workspaces
 *   - owners see only their properties and never "team only" comments
 *   - tenants see only their own tickets and tenant-visible comments
 *   - turning a tenant link off / regenerating it revokes it
 *   - role-escalation attempts fail
 *   - the local demo seed (supabase/seed.sql)
 */
import { readFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { createTicketSchema } from "../../src/lib/utils/validation";
import type { PGlite } from "@electric-sql/pglite";
import { createRunner, printSection, runStandalone, type TestResult } from "./helpers";
import {
  createTestDatabase,
  createAuthUser,
  queryAs,
  SEED_FILE,
  tryAs,
  type Actor,
} from "../db/pglite-supabase";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

interface World {
  db: PGlite;
  alice: Actor; // admin, company workspace A
  mark: Actor; // manager, A
  olive: Actor; // owner in A, property P1 only
  bob: Actor; // admin, individual workspace B
  tina: Actor; // anonymous tenant device, verified for tenancy T1 (unit U1)
  tom: Actor; // tenant with account, holds tenancy T2 (unit U2)
  eve: Actor; // signed-in user with no membership
  ids: Record<string, string>;
}

async function one<T = Record<string, unknown>>(db: PGlite, actor: Actor, sql: string, params: unknown[] = []) {
  const rows = await queryAs<T>(db, actor, sql, params);
  return rows[0];
}

async function buildWorld(): Promise<World> {
  const db = await createTestDatabase();
  const service: Actor = { kind: "service" };
  const ids: Record<string, string> = {};

  const user = async (key: string, email: string, opts: { anonymous?: boolean } = {}) => {
    ids[key] = await createAuthUser(db, {
      email: opts.anonymous ? null : email,
      anonymous: opts.anonymous,
      confirmed: !opts.anonymous,
      fullName: key,
    });
    return { kind: "user", id: ids[key], anonymous: opts.anonymous, email } as Actor;
  };

  const alice = await user("alice", "alice@a.test");
  const mark = await user("mark", "mark@a.test");
  const olive = await user("olive", "olive@a.test");
  const bob = await user("bob", "bob@b.test");
  const tina = await user("tina", "", { anonymous: true });
  const tom = await user("tom", "tom@t.test");
  const eve = await user("eve", "eve@e.test");

  ids.wsA = (await one<{ ws: string }>(db, alice, "select create_workspace('Arbutus Rentals', 'company', 'Alice') as ws")).ws;
  ids.wsB = (await one<{ ws: string }>(db, bob, "select create_workspace('Bob Rentals', 'individual') as ws")).ws;

  const prop = async (actor: Actor, ws: string, addr: string) =>
    (await one<{ id: string }>(
      db,
      actor,
      `insert into properties (workspace_id, address_line1, city, state, zip)
       values ($1, $2, 'Vancouver', 'BC', 'V6K') returning id`,
      [ws, addr]
    )).id;
  ids.p1 = await prop(alice, ids.wsA, "1 Arbutus St");
  ids.p2 = await prop(alice, ids.wsA, "2 Arbutus St");
  ids.p3 = await prop(bob, ids.wsB, "3 Bob St");

  const unit = async (actor: Actor, property: string, n: string) =>
    (await one<{ id: string; intake_token: string }>(
      db,
      actor,
      "insert into units (property_id, unit_number) values ($1, $2) returning id, intake_token",
      [property, n]
    ));
  const u1 = await unit(alice, ids.p1, "101");
  const u2 = await unit(alice, ids.p2, "201");
  const u3 = await unit(bob, ids.p3, "301");
  ids.u1 = u1.id;
  ids.u2 = u2.id;
  ids.u3 = u3.id;
  ids.u1token = u1.intake_token;

  // Invitations: mark as manager, olive as owner of P1.
  const invite = async (email: string, role: string, props: string[]) => {
    const token = randomBytes(24).toString("base64url");
    await queryAs(
      db,
      alice,
      `insert into invitations (workspace_id, email, role, property_ids, token_hash)
       values ($1, $2, $3, $4, $5)`,
      [ids.wsA, email, role, props, sha256(token)]
    );
    return token;
  };
  ids.markInvite = await invite("mark@a.test", "manager", []);
  ids.oliveInvite = await invite("olive@a.test", "owner", [ids.p1]);
  await queryAs(db, mark, "select accept_invitation($1, 'Mark')", [ids.markInvite]);
  await queryAs(db, olive, "select accept_invitation($1, 'Olive')", [ids.oliveInvite]);

  // Tenancies (created server-side after a one-time code).
  ids.t1 = (await one<{ id: string }>(
    db,
    service,
    "insert into tenancies (unit_id, name, email, verified_at) values ($1, 'Tina', 'tina@t.test', now()) returning id",
    [ids.u1]
  )).id;
  await queryAs(db, service, "insert into tenancy_verifications (tenancy_id, user_id, channel) values ($1, $2, 'email')", [ids.t1, ids.tina]);
  ids.t2 = (await one<{ id: string }>(
    db,
    service,
    "insert into tenancies (unit_id, name, email, tenant_user_id, verified_at) values ($1, 'Tom', 'tom@t.test', $2, now()) returning id",
    [ids.u2, ids.tom]
  )).id;
  ids.t3 = (await one<{ id: string }>(
    db,
    service,
    "insert into tenancies (unit_id, name, phone, verified_at) values ($1, 'Bea', '604-555-0100', now()) returning id",
    [ids.u3]
  )).id;

  // Tickets filed by tenants through RLS.
  const ticket = async (actor: Actor, tenantId: string, unitId: string, tenancy: string, title: string) =>
    (await one<{ id: string }>(
      db,
      actor,
      `insert into tickets (title, description, tenant_id, unit_id, tenancy_id)
       values ($1, $1, $2, $3, $4) returning id`,
      [title, tenantId, unitId, tenancy]
    )).id;
  ids.ticket1 = await ticket(tina, ids.tina, ids.u1, ids.t1, "Sink drains slowly");
  ids.ticket2 = await ticket(tom, ids.tom, ids.u2, ids.t2, "Fan noisy");
  ids.ticket3 = await one<{ id: string }>(
    db,
    service,
    `insert into tickets (title, description, tenant_id, unit_id, tenancy_id)
     values ('Bob unit leak', 'leak', $1, $2, $3) returning id`,
    [ids.bob, ids.u3, ids.t3]
  ).then((r) => r.id);

  // Comments on ticket1 with each visibility.
  for (const [vis, body] of [
    ["team", "Same unit had a slow drain in March"],
    ["team_owner", "Quote is $340"],
    ["tenant", "A plumber will come Tuesday"],
  ]) {
    await queryAs(db, mark, "insert into ticket_comments (ticket_id, visibility, body, author_id, author_name, author_role) values ($1, $2, $3, $4, 'x', 'manager')", [
      ids.ticket1,
      vis,
      body,
      ids.mark,
    ]);
  }

  return { db, alice, mark, olive, bob, tina, tom, eve, ids };
}

async function count(db: PGlite, actor: Actor, sql: string, params: unknown[] = []) {
  const rows = await queryAs<{ n: number }>(db, actor, `select count(*)::int as n from (${sql}) q`, params);
  return rows[0].n;
}

export async function testWorkspaceRLS(): Promise<TestResult> {
  printSection("Workspace RLS (PGlite)");
  const { pass, fail, result } = createRunner();

  const check = (cond: boolean, msg: string, detail?: unknown) => (cond ? pass(msg) : fail(msg, detail));
  const denied = (r: Awaited<ReturnType<typeof tryAs>>) => !r.ok || r.affected === 0;

  let w: World;
  try {
    w = await buildWorld();
    pass("Setup: two workspaces, invites accepted, tenants filed tickets through RLS");
  } catch (err) {
    fail("Setup failed", err);
    return result;
  }
  const { db, alice, mark, olive, bob, tina, tom, eve, ids } = w;

  // ── Isolation between workspaces ──
  check((await count(db, bob, "select id from tickets where workspace_id = $1", [ids.wsA])) === 0, "Isolation: admin of B sees no tickets of A");
  check((await count(db, bob, "select id from properties where workspace_id = $1", [ids.wsA])) === 0, "Isolation: admin of B sees no properties of A");
  check((await count(db, bob, "select id from units where workspace_id = $1", [ids.wsA])) === 0, "Isolation: admin of B sees no units (or tenant links) of A");
  check((await count(db, bob, "select id from tenancies where workspace_id = $1", [ids.wsA])) === 0, "Isolation: admin of B sees no tenants of A");
  check((await count(db, bob, "select id from ticket_comments where workspace_id = $1", [ids.wsA])) === 0, "Isolation: admin of B sees no comments of A");
  check((await count(db, alice, "select id from tickets where workspace_id = $1", [ids.wsB])) === 0, "Isolation: admin of A sees no tickets of B");
  check((await count(db, mark, "select id from tickets")) === 2, "Manager of A sees both A tickets");
  check((await count(db, eve, "select id from tickets")) === 0, "User with no membership sees no tickets");
  check((await count(db, eve, "select id from workspaces")) === 0, "User with no membership sees no workspaces");
  check((await count(db, { kind: "anon" }, "select id from tickets")) === 0, "Anonymous API role sees no tickets");

  check(
    denied(await tryAs(db, bob, "insert into properties (workspace_id, address_line1, city, state, zip) values ($1, 'x', 'x', 'BC', 'x')", [ids.wsA])),
    "Isolation: B cannot add a property to A"
  );
  check(denied(await tryAs(db, bob, "update tickets set stage = 'closed' where id = $1", [ids.ticket1])), "Isolation: B cannot update an A ticket");
  check(
    denied(await tryAs(db, bob, "insert into ticket_comments (ticket_id, visibility, body, author_id, author_name, author_role) values ($1, 'team', 'hi', $2, 'x', 'admin')", [ids.ticket1, ids.bob])),
    "Isolation: B cannot comment on an A ticket"
  );
  check(denied(await tryAs(db, alice, "update properties set workspace_id = $1 where id = $2", [ids.wsB, ids.p1])), "A property cannot be moved into another workspace");
  check(denied(await tryAs(db, alice, "update tickets set unit_id = $1 where id = $2", [ids.u3, ids.ticket1])), "A ticket cannot be moved to another workspace's unit");

  // ── Owner scope ──
  check((await count(db, olive, "select id from tickets")) === 1, "Owner sees tickets for their own property only");
  check((await count(db, olive, "select id from tickets where id = $1", [ids.ticket2])) === 0, "Owner does not see another owner's property tickets");
  check((await count(db, olive, "select id from properties")) === 1, "Owner sees only their property");
  const oliveVis = (await queryAs<{ visibility: string }>(db, olive, "select visibility from ticket_comments order by visibility")).map((r) => r.visibility);
  check(!oliveVis.includes("team") && oliveVis.length === 2, "Owner never sees 'team only' comments", oliveVis);
  check((await count(db, olive, "select id from messages")) === 0, "Owner does not read the tenant's chat");
  check(
    denied(await tryAs(db, olive, "insert into ticket_comments (ticket_id, visibility, body, author_id, author_name, author_role) values ($1, 'team', 'x', $2, 'x', 'owner')", [ids.ticket1, ids.olive])),
    "Owner cannot post a 'team only' comment"
  );
  check(
    denied(await tryAs(db, olive, "insert into ticket_comments (ticket_id, visibility, body, author_id, author_name, author_role) values ($1, 'tenant', 'x', $2, 'x', 'owner')", [ids.ticket1, ids.olive])),
    "Owner cannot message the tenant"
  );
  const ownerComment = await tryAs(
    db,
    olive,
    "insert into ticket_comments (ticket_id, visibility, body, author_id, author_name, author_role) values ($1, 'team_owner', 'Approved', $2, 'Mallory', 'admin') returning author_role, author_name",
    [ids.ticket1, ids.olive]
  );
  check(
    ownerComment.ok && ownerComment.rows[0]?.author_role === "owner" && ownerComment.rows[0]?.author_name === "Olive",
    "Owner can post 'team and owner'; author role and name come from the membership, not the request",
    ownerComment
  );
  check(denied(await tryAs(db, olive, "update tickets set stage = 'fixed' where id = $1", [ids.ticket1])), "Owner cannot change ticket status");

  // ── Tenant scope ──
  check((await count(db, tina, "select id from tickets")) === 1, "Link tenant sees only the ticket they filed");
  const tinaVis = (await queryAs<{ visibility: string }>(db, tina, "select visibility from ticket_comments")).map((r) => r.visibility);
  check(tinaVis.length === 1 && tinaVis[0] === "tenant", "Tenant sees only 'to tenant' comments", tinaVis);
  check((await count(db, tina, "select id from approvals")) === 0, "Tenant sees no approvals");
  check((await count(db, tom, "select id from tickets")) === 1, "Tenant with account sees their tenancy's tickets only");
  check(
    denied(await tryAs(db, tina, "insert into ticket_comments (ticket_id, visibility, body, author_id, author_name, author_role) values ($1, 'team', 'x', $2, 'x', 'tenant')", [ids.ticket1, ids.tina])),
    "Tenant cannot post a team comment"
  );
  check(
    (await tryAs(db, tina, "insert into ticket_comments (ticket_id, visibility, body, author_id, author_name, author_role) values ($1, 'tenant', 'Thanks!', $2, 'x', 'admin')", [ids.ticket1, ids.tina])).ok,
    "Tenant can reply on their own ticket"
  );
  check(
    denied(await tryAs(db, tina, "insert into tickets (title, description, tenant_id, unit_id, tenancy_id) values ('x','x',$1,$2,$3)", [ids.tina, ids.u3, ids.t1])),
    "Tenant cannot file a ticket against another unit with their tenancy"
  );
  check(
    denied(await tryAs(db, tina, "insert into tickets (title, description, tenant_id, unit_id, tenancy_id) values ('x','x',$1,$2,$3)", [ids.tina, ids.u3, ids.t3])),
    "Tenant cannot file a ticket on a tenancy they never confirmed"
  );
  check(
    denied(await tryAs(db, eve, "insert into tickets (title, description, tenant_id, unit_id) values ('x','x',$1,$2)", [ids.eve, ids.u1])),
    "A ticket without a tenancy is rejected"
  );
  check(denied(await tryAs(db, tina, "update tickets set stage = 'closed' where id = $1", [ids.ticket1])), "Tenant cannot change the ticket's status stage");
  check(denied(await tryAs(db, tina, "update tickets set vendor_name = 'Me' where id = $1", [ids.ticket1])), "Tenant cannot set the vendor");
  check(denied(await tryAs(db, tina, "update tickets set tenancy_id = $1 where id = $2", [ids.t2, ids.ticket1])), "Tenant cannot attach their ticket to another tenancy");
  check(
    (await tryAs(db, tina, "update tickets set triage_state = 'GATHER_INFO' where id = $1", [ids.ticket1])).ok,
    "Tenant can still advance their own triage chat"
  );
  check(denied(await tryAs(db, tina, "update tenancies set tenant_user_id = $1 where id = $2", [ids.tina, ids.t1])), "Tenant cannot claim a tenancy account");
  check((await count(db, tina, "select id from units")) === 1, "Tenant reads only their unit");

  // ── Approvals ──
  const appr = await tryAs(db, mark, "insert into approvals (ticket_id, amount_cents, limit_cents) values ($1, 34000, 1) returning id, limit_cents, decision", [ids.ticket1]);
  check(appr.ok && appr.rows[0]?.limit_cents === 30000, "Manager requests approval; limit comes from workspace settings", appr);
  const approvalId = appr.ok ? String(appr.rows[0].id) : "";
  check(denied(await tryAs(db, olive, "insert into approvals (ticket_id, amount_cents, limit_cents) values ($1, 100, 0)", [ids.ticket1])), "Owner cannot create approval requests");
  check(denied(await tryAs(db, mark, "update approvals set decision = 'approved' where id = $1", [approvalId])), "Manager cannot approve directly by update");
  check(!(await tryAs(db, mark, "select decide_approval($1, 'approved')", [approvalId])).ok, "Manager (not admin, not owner) cannot decide an approval");
  const bobDecide = await tryAs(db, bob, "select decide_approval($1, 'approved')", [approvalId]);
  check(!bobDecide.ok, "Admin of another workspace cannot decide", bobDecide);
  check((await tryAs(db, olive, "select decide_approval($1, 'approved', 'Go ahead')", [approvalId])).ok, "Owner approves a quote over the limit");
  check(!(await tryAs(db, olive, "select decide_approval($1, 'declined')", [approvalId])).ok, "A decided approval cannot be changed");

  // ── Tenant link revocation ──
  const lookup = async (token: string) => count(db, { kind: "service" }, "select * from intake_unit_for_token($1)", [token]);
  check((await lookup(ids.u1token)) === 1, "Active tenant link resolves to its unit");
  check(!(await tryAs(db, { kind: "anon" }, "select * from intake_unit_for_token($1)", [ids.u1token])).ok, "Anonymous API callers cannot resolve links directly");
  check((await lookup("not-a-real-token-at-all-xx")) === 0, "Unknown token resolves to nothing");
  await queryAs(db, alice, "update units set link_active = false where id = $1", [ids.u1]);
  check((await lookup(ids.u1token)) === 0, "Turning the link off revokes it");
  check(
    denied(await tryAs(db, tina, "insert into tickets (title, description, tenant_id, unit_id, tenancy_id) values ('x','x',$1,$2,$3)", [ids.tina, ids.u1, ids.t1])),
    "Devices confirmed through a revoked link cannot file new tickets"
  );
  check((await count(db, tina, "select id from tickets")) === 1, "...but still see the request they already made");
  check((await count(db, tina, "select id from tenancies")) === 0, "...and can no longer open the tenancy's chat");
  await queryAs(db, alice, "update units set link_active = true where id = $1", [ids.u1]);
  const rotated = await one<{ intake_token: string; link_rotated_at: string | null }>(
    db,
    alice,
    "update units set intake_token = default where id = $1 returning intake_token, link_rotated_at",
    [ids.u1]
  );
  check((await lookup(ids.u1token)) === 0 && (await lookup(rotated.intake_token)) === 1, "Regenerating replaces the old link with a new one");
  check(rotated.link_rotated_at !== null, "Regeneration is timestamped");
  check(
    (await tryAs(db, tom, "insert into tickets (title, description, tenant_id, unit_id, tenancy_id) values ('Again','x',$1,$2,$3)", [ids.tom, ids.u2, ids.t2])).ok,
    "Tenant with an account can still file from their tenancy"
  );
  check(denied(await tryAs(db, bob, "update units set intake_token = default, link_active = true where id = $1", [ids.u1])), "Another workspace cannot regenerate or reactivate a link");

  // ── Role escalation attempts ──
  check(!(await tryAs(db, eve, "insert into memberships (workspace_id, user_id, role) values ($1, $2, 'admin')", [ids.wsA, ids.eve])).ok, "Escalation: cannot insert own membership");
  check(denied(await tryAs(db, mark, "update memberships set role = 'admin' where user_id = $1", [ids.mark])), "Escalation: manager cannot promote self by update");
  check(!(await tryAs(db, mark, "select set_member_role($1, $2, 'admin')", [ids.wsA, ids.mark])).ok, "Escalation: manager cannot call set_member_role");
  check(!(await tryAs(db, olive, "select set_member_role($1, $2, 'admin')", [ids.wsA, ids.olive])).ok, "Escalation: owner cannot promote self");
  check(!(await tryAs(db, alice, "select set_member_role($1, $2, 'manager')", [ids.wsA, ids.alice])).ok, "Admin cannot change their own role (no lock-out)");
  check(!(await tryAs(db, bob, "select set_member_role($1, $2, 'manager')", [ids.wsA, ids.olive])).ok, "Admin of another workspace cannot change roles in A");
  check(!(await tryAs(db, mark, "select remove_member($1, $2)", [ids.wsA, ids.alice])).ok, "Manager cannot remove the admin");
  check(!(await tryAs(db, eve, "select role from profiles limit 1")).ok, "There is no role column on profiles to tamper with");
  check(denied(await tryAs(db, eve, "update profiles set email = 'admin@a.test' where id = $1", [ids.eve])), "Users cannot change their profile email");
  check((await tryAs(db, eve, "update profiles set full_name = 'Eve E' where id = $1", [ids.eve])).ok, "Users can still edit their own name");
  check(
    denied(await tryAs(db, mark, "insert into invitations (workspace_id, email, role, token_hash) values ($1, 'x@x.test', 'manager', 'h1')", [ids.wsA])),
    "Managers cannot invite (admin only)"
  );
  check(
    !(await tryAs(db, alice, "insert into invitations (workspace_id, email, role, token_hash) values ($1, 'x@x.test', 'admin', 'h2')", [ids.wsA])).ok,
    "Admin role cannot be handed out by invitation"
  );
  check(
    !(await tryAs(db, bob, "insert into invitations (workspace_id, email, role, token_hash) values ($1, 'o@x.test', 'owner', 'h3')", [ids.wsB])).ok,
    "Owners cannot be invited to an individual workspace"
  );
  check(
    !(await tryAs(db, alice, "insert into invitations (workspace_id, email, role, property_ids, token_hash) values ($1, 'o@x.test', 'owner', $2, 'h4')", [ids.wsA, [ids.p3]])).ok,
    "Owner invitation cannot list another workspace's property"
  );
  const stolen = randomBytes(24).toString("base64url");
  await queryAs(db, alice, "insert into invitations (workspace_id, email, role, token_hash) values ($1, 'someone@a.test', 'manager', $2)", [ids.wsA, sha256(stolen)]);
  check(!(await tryAs(db, eve, "select accept_invitation($1)", [stolen])).ok, "Escalation: a forwarded invite link does not work for a different email");
  check(!(await tryAs(db, mark, "select accept_invitation($1)", [ids.markInvite])).ok, "An accepted invitation cannot be reused");
  check(
    denied(await tryAs(db, alice, "update invitations set role = 'owner' where token_hash = $1", [sha256(stolen)])),
    "An invitation's role cannot be edited after sending (revoke only)"
  );
  check(
    (await tryAs(db, alice, "update invitations set revoked_at = now() where token_hash = $1", [sha256(stolen)])).ok,
    "Admin can revoke an invitation"
  );
  check(
    !(await tryAs(db, tina, "select create_workspace('Guest', 'individual')")).ok,
    "Escalation: a guest (anonymous) session cannot create a workspace"
  );
  const unconfirmed = await createAuthUser(db, { email: "new@x.test", confirmed: false });
  check(
    !(await tryAs(db, { kind: "user", id: unconfirmed }, "select create_workspace('Mine', 'individual')")).ok,
    "Unconfirmed email cannot create a workspace"
  );
  check(!(await tryAs(db, { kind: "anon" }, "select create_workspace('x', 'individual')")).ok, "Anonymous API role cannot call create_workspace");
  check(
    denied(await tryAs(db, mark, "update workspaces set approval_limit_cents = 0 where id = $1", [ids.wsA])),
    "Managers cannot change workspace settings"
  );
  check(
    (await tryAs(db, alice, "update workspaces set approval_limit_cents = 50000 where id = $1", [ids.wsA])).ok,
    "Admin can change the approval limit"
  );
  check(denied(await tryAs(db, alice, "update workspaces set created_by = $1 where id = $2", [ids.eve, ids.wsA])), "Workspace owner field is not writable");
  check(
    (await count(db, tina, "select tenancy_id from tenancy_verifications")) === 0 &&
      denied(await tryAs(db, tina, "insert into tenancy_verifications (tenancy_id, user_id, channel) values ($1, $2, 'email')", [ids.t2, ids.tina])),
    "Tenants cannot grant themselves access to another tenancy"
  );
  check(!(await tryAs(db, tina, "select * from intake_codes")).ok, "One-time codes are not readable through the API");
  check(
    !(await tryAs(db, alice, "insert into owner_property_access (workspace_id, user_id, property_id) values ($1, $2, $3)", [ids.wsA, ids.mark, ids.p2])).ok,
    "Per-property access is only for owners"
  );

  // ── Local demo seed ──
  try {
    await testSeed(check);
  } catch (err) {
    fail("Seed (supabase/seed.sql) threw", err);
  }

  await db.close();
  return result;
}

/** supabase/seed.sql builds a usable demo on top of the baseline. */
async function testSeed(check: (cond: boolean, msg: string, detail?: unknown) => void) {
  // Server actions validate ids with zod's RFC 4122 uuid check (version 1-8,
  // variant 8/9/a/b); seeded ids must pass it or every action rejects them.
  const seedIds = [
    ...new Set(readFileSync(SEED_FILE, "utf8").match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ?? []),
  ].filter((id) => id !== "00000000-0000-0000-0000-000000000000"); // auth.users.instance_id, never sent to the app
  const uuid = z.string().uuid();
  const invalid = seedIds.filter((id) => !uuid.safeParse(id).success || !createTicketSchema.shape.unit_id.safeParse(id).success);
  check(seedIds.length >= 10 && invalid.length === 0, `Seed: all ${seedIds.length} UUIDs pass the app's zod uuid validation`, invalid);

  const db = await createTestDatabase({ seed: true });
  const user = (n: number): Actor => ({ kind: "user", id: `00000000-0000-4000-a000-00000000000${n}` });
  const [admin, manager, owner, tenant] = [user(1), user(2), user(3), user(4)];

  check((await count(db, admin, "select id from units")) === 3, "Seed: admin sees the demo workspace's 3 units");
  check((await count(db, manager, "select id from tickets")) === 1, "Seed: manager sees the demo request");
  check((await count(db, owner, "select id from properties")) === 1, "Seed: owner sees only 3076 Arbutus Street");
  check((await count(db, owner, "select id from ticket_comments")) === 2, "Seed: owner sees 2 of 3 comments (not the team-only one)");
  check((await count(db, tenant, "select id from ticket_comments")) === 1, "Seed: tenant sees only the 'to tenant' comment");
  check((await count(db, tenant, "select id from tickets")) === 1, "Seed: tenant with an account sees their request");
  check(
    (await count(db, { kind: "service" }, "select * from intake_unit_for_token('demo-link-arbutus-unit-101')")) === 1,
    "Seed: demo tenant link resolves"
  );
  const pw = await db.query<{ ok: boolean }>(
    "select encrypted_password = extensions.crypt('propcare-demo-1234', encrypted_password) as ok from auth.users where email = 'admin@example.test'"
  );
  check(pw.rows[0]?.ok === true, "Seed: demo users have the documented password");
  check(
    (await db.query<{ n: number }>("select count(*)::int as n from auth.identities")).rows[0].n === 4,
    "Seed: each demo user has an email identity"
  );
  await db.close();
}

const isMain = process.argv[1]?.replace(/\.ts$/, "").endsWith("test-workspace-rls");
if (isMain) runStandalone(() => testWorkspaceRLS());
