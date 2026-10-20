-- ============================================================
-- One-time data migration: existing data → one workspace
-- ============================================================
--
-- Run ONCE, after migration 005_workspaces.sql, against a project you have
-- backed up. Never run it from CI. See docs/workspaces-migration.md for the
-- full plan (dry run on a branch/staging project first).
--
-- What it does, in one transaction:
--   1. Creates a company workspace (name below) unless one with that name
--      already exists — re-running is safe.
--   2. Makes every profile with the legacy role 'manager' an admin of it.
--   3. Moves every property, vendor and ticket that has no workspace into it
--      (units follow their property automatically).
--   4. Creates a tenancy for each unit that had a tenant (units.tenant_id),
--      held by that tenant's existing account, and links their tickets.
--   5. Validates the "workspace required" constraints so new rows can never
--      be orphaned again.
--
-- It does not delete or rewrite any legacy column (profiles.role,
-- properties.manager_id, units.tenant_id); a later migration can drop them.
-- ============================================================

begin;

do $$
declare
  ws_name   constant text := 'Birchwood Management';   -- change before running if needed
  ws        uuid;
  creator   uuid;
begin
  select id into ws from workspaces where name = ws_name order by created_at limit 1;

  if ws is null then
    select p.id into creator
      from profiles p
      where p.role = 'manager'
      order by p.created_at
      limit 1;

    insert into workspaces (name, kind, created_by)
      values (ws_name, 'company', creator)
      returning id into ws;
    raise notice 'Created workspace % (%)', ws_name, ws;
  else
    raise notice 'Reusing workspace % (%)', ws_name, ws;
  end if;

  -- 2. Existing managers become admins.
  insert into memberships (workspace_id, user_id, role, display_name)
    select ws, p.id, 'admin', p.full_name
    from profiles p
    where p.role = 'manager'
    on conflict (workspace_id, user_id) do nothing;

  -- 3. Properties (units follow via trigger), vendors.
  update properties set workspace_id = ws where workspace_id is null;
  update units u
    set workspace_id = p.workspace_id
    from properties p
    where p.id = u.property_id and u.workspace_id is distinct from p.workspace_id;
  update vendors set workspace_id = ws where workspace_id is null;

  -- 4. Tenancies for units that had an assigned tenant account.
  insert into tenancies (unit_id, workspace_id, tenant_user_id, name, email, phone, verified_at)
    select u.id, u.workspace_id, pr.id, pr.full_name, lower(pr.email), pr.phone, now()
    from units u
    join profiles pr on pr.id = u.tenant_id
    where (pr.email is not null or pr.phone is not null)
      and not exists (
        select 1 from tenancies t where t.unit_id = u.id and t.tenant_user_id = pr.id
      );

  -- Tickets: workspace from their unit, else the new workspace (tickets that
  -- were filed without a unit); tenancy where the filer holds one on that unit.
  update tickets t
    set workspace_id = coalesce(
      (select u.workspace_id from units u where u.id = t.unit_id),
      ws
    )
    where t.workspace_id is null;

  update tickets t
    set tenancy_id = te.id
    from tenancies te
    where t.tenancy_id is null
      and te.unit_id = t.unit_id
      and te.tenant_user_id = t.tenant_id;

  -- Map legacy ticket status onto the new stage where it is unambiguous.
  update tickets set stage = 'fixed'  where stage = 'new' and status = 'resolved';
  update tickets set stage = 'closed' where stage = 'new' and status = 'closed';
end;
$$;

-- 5. From now on every row must carry a workspace.
alter table properties validate constraint properties_workspace_required;
alter table tickets validate constraint tickets_workspace_required;
alter table vendors validate constraint vendors_workspace_required;

commit;
