/**
 * Test: try-mode sandboxes (PGlite, no network)
 * Run:  npx tsx tests/integration/test-demo-sandbox.ts
 *
 * create_demo_sandbox builds "Demo Rentals" and each demo role sees exactly
 * what the real role would; the chat-turn cap; outbox and work-order RLS.
 */
import type { PGlite } from "@electric-sql/pglite";
import { createRunner, printSection, runStandalone, type TestResult } from "./helpers";
import { createTestDatabase, queryAs, tryAs, type Actor } from "../db/pglite-supabase";

async function authUser(db: PGlite, email: string): Promise<string> {
  const id = (await db.query<{ id: string }>("select gen_random_uuid() as id")).rows[0].id;
  await db.query("insert into auth.users (id, email, email_confirmed_at) values ($1, $2, now())", [id, email]);
  return id;
}

export async function testDemoSandbox(): Promise<TestResult> {
  printSection("Try mode sandboxes (PGlite)");
  const { pass, fail, result } = createRunner();
  const check = (cond: boolean, msg: string, detail?: unknown) => (cond ? pass(msg) : fail(msg, detail));
  const service: Actor = { kind: "service" };

  const db = await createTestDatabase();
  const count = async (actor: Actor, sql: string, params: unknown[] = []) =>
    (await queryAs<{ n: number }>(db, actor, `select count(*)::int as n from (${sql}) q`, params))[0].n;

  try {
    const make = async () => {
      const ids = {
        admin: await authUser(db, `demo-${Math.random().toString(36).slice(2)}-admin@example.com`),
        owner: await authUser(db, `demo-${Math.random().toString(36).slice(2)}-owner@example.com`),
        tenant: await authUser(db, `demo-${Math.random().toString(36).slice(2)}-tenant@example.com`),
        neighbour: await authUser(db, `demo-${Math.random().toString(36).slice(2)}-neighbour@example.com`),
      };
      const sid = (
        await queryAs<{ id: string }>(db, service, "select create_demo_sandbox($1, $2, $3, $4) as id", [
          ids.admin,
          ids.owner,
          ids.tenant,
          ids.neighbour,
        ])
      )[0].id;
      return { ...ids, sid };
    };

    const a = await make();
    const b = await make();
    pass("Two sandboxes created by the service role");

    const admin: Actor = { kind: "user", id: a.admin };
    const owner: Actor = { kind: "user", id: a.owner };
    const tenant: Actor = { kind: "user", id: a.tenant };

    check((await count(admin, "select id from tickets")) === 3, "Manager view: all 3 sample tickets");
    check((await count(admin, "select id from tickets where stage = 'waiting_for_owner'")) === 1, "One ticket waits for the owner");
    check((await count(admin, "select id from tickets where priority = 'emergency'")) === 1, "One emergency");
    check((await count(admin, "select id from tickets where stage = 'fixed'")) === 1, "One fixed in chat");
    check((await count(admin, "select id from approvals where decision = 'pending'")) === 1, "A pending $340 approval");
    check((await count(admin, "select id from work_orders where quote_cents = 34000")) === 1, "Westside Plumbing's quote is on the work order");
    check((await count(admin, "select id from units where profile ? 'water_shutoff'")) === 3, "Units have profiles (shut-offs etc.)");

    check(
      (await count(owner, "select id from tickets")) === 2 && (await count(owner, "select id from tickets where priority = 'emergency'")) === 0,
      "Owner view: only the home they own (not the emergency next door)"
    );
    check((await count(owner, "select id from ticket_comments where visibility = 'team'")) === 0, "Owner view: no team-only notes");
    check((await count(owner, "select id from work_orders")) === 0 && (await count(owner, "select id from outbox")) === 0, "Owner can't read work orders or the outbox");
    const decided = await tryAs(db, owner, "select decide_approval((select id from approvals limit 1), 'approved')");
    check(decided.ok, "Owner can approve the quote", decided);

    check((await count(tenant, "select id from tickets")) === 2, "Tenant view: Jamie's 2 requests only");
    check((await count(tenant, "select id from ticket_comments")) === 1, "Tenant view: only the 'to tenant' reply");
    check((await count(tenant, "select id from work_orders")) === 0, "Tenant can't read work orders");

    check((await count(admin, "select t.id from tickets t join units u on u.id = t.unit_id where u.workspace_id <> (select workspace_id from memberships where user_id = $1)", [a.admin])) === 0, "Sandbox A sees nothing of sandbox B");
    check((await count({ kind: "user", id: b.admin }, "select id from tickets")) === 3, "Sandbox B has its own 3 tickets");

    check(!(await tryAs(db, admin, "select create_demo_sandbox($1,$1,$1,$1)", [a.admin])).ok, "Users can't call create_demo_sandbox");
    check(!(await tryAs(db, admin, "select * from demo_sandboxes")).ok, "Users can't read the sandbox registry");
    check(!(await tryAs(db, admin, "select demo_take_chat_turn($1)", [a.admin])).ok, "Users can't call demo_take_chat_turn");

    // Chat-turn cap
    const turn = async (user: string, limit = 3) =>
      (await queryAs<{ r: string }>(db, service, "select demo_take_chat_turn($1, $2) as r", [user, limit]))[0].r;
    const results = [await turn(a.tenant), await turn(a.admin), await turn(a.tenant), await turn(a.tenant)];
    check(results.join(",") === "ok,ok,ok,limit", "Chat turns are capped per sandbox (shared by its roles)", results);
    check((await turn(b.tenant)) === "ok", "Another sandbox has its own budget");
    const outsider = await authUser(db, "real@example.com");
    check((await turn(outsider)) === "not_demo", "Real users are not limited by the demo cap");
    await queryAs(db, service, "update demo_sandboxes set expires_at = now() - interval '1 minute' where id = $1", [b.sid]);
    check((await turn(b.tenant)) === "expired", "Expired sandboxes refuse chat turns");

    // Work orders: team can create but not forge a quote
    const ticket = (await queryAs<{ id: string }>(db, admin, "select id from tickets where priority = 'emergency'"))[0].id;
    const wo = await tryAs(db, admin, "insert into work_orders (ticket_id, vendor_name, scope, quote_cents, status) values ($1, 'Westside Plumbing', 'Fix it', 100, 'quoted') returning status, quote_cents, workspace_id", [ticket]);
    check(wo.ok && wo.rows[0].status === "sent" && wo.rows[0].quote_cents === null, "A new work order starts as 'sent' with no quote", wo);
    check(!(await tryAs(db, admin, "update work_orders set quote_cents = 1 where ticket_id = $1", [ticket])).ok, "The team can't write a vendor's quote");
    const otherAdmin: Actor = { kind: "user", id: b.admin };
    check(!(await tryAs(db, otherAdmin, "insert into work_orders (ticket_id, vendor_name, scope) values ($1, 'X', 'Y')", [ticket])).ok, "Another workspace can't create work orders on this ticket");

    // Deleting the workspace removes everything in the sandbox
    await queryAs(db, service, "delete from workspaces where id = (select workspace_id from demo_sandboxes where id = $1)", [b.sid]);
    check((await count(service, "select id from demo_sandboxes where id = $1", [b.sid])) === 0, "Cleanup: deleting the workspace removes the sandbox row");
  } catch (err) {
    fail("Demo sandbox test threw", err);
  }

  await db.close();
  return result;
}

const isMain = process.argv[1]?.replace(/\.ts$/, "").endsWith("test-demo-sandbox");
if (isMain) runStandalone(() => testDemoSandbox());
