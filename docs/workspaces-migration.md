# Workspaces: migration plan

PropCare moves from one global "manager" role to **workspaces**. Each landlord
or property-management company gets its own workspace; a person's role
(`admin`, `manager`, `owner`) lives in `memberships`, one row per workspace.
Tenants have no membership: they report through a unit's link.

Nothing here has been run against the production Supabase project.

## What changes in the database

| Migration / script | What it does | When |
|---|---|---|
| `supabase/migrations/005_workspaces.sql` | New tables (`workspaces`, `memberships`, `invitations`, `owner_property_access`, `tenancies`, `tenancy_verifications`, `intake_codes`, `ticket_comments`, `approvals`), new columns (`workspace_id` everywhere, unit link fields, ticket stage/vendor fields), replaces **every** RLS policy with workspace-membership checks, locks `profiles.role` against user writes | With the deploy (`supabase db push`) |
| `supabase/scripts/migrate_existing_data_to_workspaces.sql` | Moves existing data into one workspace (default name "Birchwood Management"): existing managers become admins; properties, units, vendors and tickets get its `workspace_id`; units with an assigned tenant get a tenancy; then validates the "workspace required" constraints | Once, right after 005, by hand |

Between running 005 and the script, legacy rows have no workspace and are
invisible to everyone signed in (that is the safe failure: nobody sees
anybody else's data). Run the two back to back.

## Steps

1. **Back up.** In Supabase: Database → Backups, or `pg_dump` of the project.
2. **Rehearse on a copy.** Create a Supabase branch or a staging project
   restored from the backup. Never rehearse on production.
3. On the copy, apply the migration: `supabase db push` (or paste
   `005_workspaces.sql` into the SQL editor).
4. On the copy, open `migrate_existing_data_to_workspaces.sql`, check the
   workspace name at the top, and run it in the SQL editor. It runs in one
   transaction and is safe to run twice.
5. Check on the copy:
   ```sql
   select name, kind from workspaces;
   select m.role, p.email from memberships m join profiles p on p.id = m.user_id;
   select count(*) from tickets where workspace_id is null;   -- expect 0
   select count(*) from properties where workspace_id is null; -- expect 0
   ```
   Sign in as an existing manager: the dashboard shows the same tickets as
   before. Sign in as a second test account with no membership: it sees none.
6. Deploy the app from the branch to staging and click through (see the PR
   checklist), then repeat steps 3–5 on production in a quiet hour and deploy.

## Rollback

The migration only adds tables and columns and swaps policies; it does not
drop legacy columns (`profiles.role`, `properties.manager_id`,
`units.tenant_id`). To roll back, restore the backup taken in step 1.
Re-deploying the old app against the new schema is **not** supported: the
old policies are gone.

## Later clean-up (separate migration, after a few weeks)

- Drop `profiles.role`, `properties.manager_id`, `units.tenant_id` and the
  `user_role` enum.
- Make `workspace_id` `NOT NULL` on `properties`, `units`, `tickets`,
  `vendors` (the validated check constraints already guarantee it).

## How access works now

| Who | Sees | Can change |
|---|---|---|
| Admin | Everything in the workspace | Everything; invites; settings; roles of others (never their own) |
| Manager | Everything in the workspace | Tickets, homes, units, tenant links, comments, approval requests |
| Owner (company workspaces) | Tickets, units and approvals for the properties they were given; comments marked "team and owner" or "to tenant" | Comment ("team and owner" only), approve or decline quotes |
| Tenant with the link | The requests they filed from that device; "to tenant" comments | File requests for that unit, reply |
| Tenant with an account | Every request of their tenancy | Same as above |

All of it is enforced by RLS (`is_workspace_member`, `ticket_access`, …), and
tested in `tests/integration/test-workspace-rls.ts` against the real
migrations in an in-process Postgres (PGlite).
