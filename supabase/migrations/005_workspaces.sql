-- ============================================================
-- Migration 005: Workspaces, memberships and workspace-scoped RLS
-- ============================================================
--
-- Replaces the global "manager" role with workspaces. Every record now
-- belongs to one workspace; a user's role lives in `memberships`
-- (admin | manager | owner), never in user_metadata or profiles.role.
--
--   admin, manager  "team": everything in their workspace
--   owner           only the properties listed in owner_property_access,
--                   never "team only" comments (company workspaces only)
--   tenant          no membership: sees only their own tickets (or, with an
--                   account, every ticket of the tenancy they hold) and only
--                   tenant-visible comments
--
-- Writes to memberships, workspaces creation, invitation acceptance and
-- approval decisions go through SECURITY DEFINER functions, so no user can
-- grant themselves a role with a direct insert/update.
--
-- Existing rows (properties, units, tickets, vendors) are NOT moved here:
-- run supabase/scripts/migrate_existing_data_to_workspaces.sql once, after
-- this migration (see docs/workspaces-migration.md). Until then legacy rows
-- have workspace_id NULL and are invisible to every signed-in user.
-- ============================================================

-- ---------- Enums ----------
create type workspace_kind as enum ('individual', 'company');
create type membership_role as enum ('admin', 'manager', 'owner');
create type comment_visibility as enum ('team', 'team_owner', 'tenant');
create type approval_decision as enum ('pending', 'approved', 'declined');
create type ticket_stage as enum ('new', 'waiting_for_owner', 'vendor_booked', 'fixed', 'closed');

-- ============================================================
-- New tables
-- ============================================================

create table workspaces (
  id                    uuid primary key default gen_random_uuid(),
  name                  text not null check (char_length(name) between 1 and 120),
  kind                  workspace_kind not null,
  -- Quotes above this need owner approval (company workspaces).
  approval_limit_cents  integer not null default 30000 check (approval_limit_cents >= 0),
  created_by            uuid references auth.users(id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create trigger workspaces_updated_at
  before update on workspaces
  for each row execute function update_updated_at();

create table memberships (
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  user_id       uuid not null references auth.users(id) on delete cascade,
  role          membership_role not null,
  display_name  text check (display_name is null or char_length(display_name) <= 100),
  created_at    timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create index idx_memberships_user on memberships(user_id);

create table invitations (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  email         text not null check (email = lower(email) and char_length(email) <= 254),
  role          membership_role not null check (role in ('manager', 'owner')),
  -- Owners only: the properties they will see.
  property_ids  uuid[] not null default '{}',
  -- sha256 hex of the token in the invite link; the token itself is never stored.
  token_hash    text not null unique,
  invited_by    uuid references auth.users(id) on delete set null,
  expires_at    timestamptz not null default now() + interval '14 days',
  accepted_at   timestamptz,
  accepted_by   uuid references auth.users(id) on delete set null,
  revoked_at    timestamptz,
  created_at    timestamptz not null default now()
);

create index idx_invitations_workspace on invitations(workspace_id);

-- ---------- Properties / units: add workspace + tenant link ----------
alter table properties add column workspace_id uuid references workspaces(id) on delete cascade;
alter table properties alter column manager_id drop not null;  -- legacy, unused by the app
create index idx_properties_workspace on properties(workspace_id);
-- New and updated rows must belong to a workspace; legacy rows are fixed by
-- the data-migration script, which then VALIDATEs the constraint.
alter table properties add constraint properties_workspace_required
  check (workspace_id is not null) not valid;

alter table units add column workspace_id uuid references workspaces(id) on delete cascade;
-- Unguessable per-unit intake link: /r/<intake_token>. 122 random bits.
alter table units add column intake_token text not null unique
  default replace(gen_random_uuid()::text, '-', '');
alter table units add column link_active boolean not null default true;
alter table units add column link_rotated_at timestamptz;
create index idx_units_workspace on units(workspace_id);

create table owner_property_access (
  workspace_id  uuid not null,
  user_id       uuid not null,
  property_id   uuid not null references properties(id) on delete cascade,
  created_at    timestamptz not null default now(),
  primary key (user_id, property_id),
  foreign key (workspace_id, user_id) references memberships(workspace_id, user_id) on delete cascade
);

create index idx_owner_access_workspace on owner_property_access(workspace_id);

create table tenancies (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references workspaces(id) on delete cascade,
  unit_id         uuid not null references units(id) on delete cascade,
  -- Set once the tenant keeps an account (passwordless). Sees every ticket
  -- of this tenancy.
  tenant_user_id  uuid references auth.users(id) on delete set null,
  name            text not null check (char_length(name) between 1 and 100),
  email           text check (email is null or (email = lower(email) and char_length(email) <= 254)),
  phone           text check (phone is null or char_length(phone) <= 20),
  verified_at     timestamptz,
  ended_at        timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  check (email is not null or phone is not null)
);

create index idx_tenancies_unit on tenancies(unit_id);
create index idx_tenancies_workspace on tenancies(workspace_id);
create index idx_tenancies_user on tenancies(tenant_user_id);

create trigger tenancies_updated_at
  before update on tenancies
  for each row execute function update_updated_at();

-- A device (auth user, usually anonymous) that confirmed a one-time code for
-- this tenancy. Lets it file tickets for the tenancy's unit; it sees only the
-- tickets it filed itself.
create table tenancy_verifications (
  tenancy_id   uuid not null references tenancies(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  channel      text not null check (channel in ('email', 'sms')),
  verified_at  timestamptz not null default now(),
  primary key (tenancy_id, user_id)
);

create index idx_tenancy_verifications_user on tenancy_verifications(user_id);

-- One-time codes for the tenant link. Service role only (no policies).
create table intake_codes (
  id           uuid primary key default gen_random_uuid(),
  unit_id      uuid not null references units(id) on delete cascade,
  channel      text not null check (channel in ('email', 'sms')),
  destination  text not null,
  name         text not null,
  code_hash    text not null,
  attempts     smallint not null default 0,
  expires_at   timestamptz not null,
  consumed_at  timestamptz,
  created_at   timestamptz not null default now()
);

create index idx_intake_codes_lookup on intake_codes(unit_id, destination, created_at desc);

-- ---------- Tickets: workspace, tenancy, collaboration fields ----------
alter table tickets add column workspace_id uuid references workspaces(id) on delete cascade;
alter table tickets add column tenancy_id uuid references tenancies(id) on delete set null;
alter table tickets add column stage ticket_stage not null default 'new';
alter table tickets add column vendor_name text check (vendor_name is null or char_length(vendor_name) <= 200);
alter table tickets add column vendor_booked_for timestamptz;
alter table tickets add column entry_notice text check (entry_notice is null or char_length(entry_notice) <= 1000);
create index idx_tickets_workspace on tickets(workspace_id, created_at desc);
create index idx_tickets_tenancy on tickets(tenancy_id);
alter table tickets add constraint tickets_workspace_required
  check (workspace_id is not null) not valid;

alter table vendors add column workspace_id uuid references workspaces(id) on delete cascade;
alter table vendors alter column manager_id drop not null;
create index idx_vendors_workspace on vendors(workspace_id);
alter table vendors add constraint vendors_workspace_required
  check (workspace_id is not null) not valid;

create table ticket_comments (
  id             uuid primary key default gen_random_uuid(),
  ticket_id      uuid not null references tickets(id) on delete cascade,
  workspace_id   uuid not null references workspaces(id) on delete cascade,
  author_id      uuid references auth.users(id) on delete set null,
  author_name    text not null,
  author_role    text not null check (author_role in ('admin', 'manager', 'owner', 'tenant', 'system')),
  visibility     comment_visibility not null,
  body           text not null check (char_length(body) between 1 and 5000),
  -- "To tenant" comments: when the email went out (service role sets these).
  delivered_at   timestamptz,
  delivery_error text,
  created_at     timestamptz not null default now()
);

create index idx_ticket_comments_ticket on ticket_comments(ticket_id, created_at);

create table approvals (
  id             uuid primary key default gen_random_uuid(),
  ticket_id      uuid not null references tickets(id) on delete cascade,
  workspace_id   uuid not null references workspaces(id) on delete cascade,
  amount_cents   integer not null check (amount_cents > 0),
  limit_cents    integer not null check (limit_cents >= 0),
  description    text check (description is null or char_length(description) <= 1000),
  requested_by   uuid references auth.users(id) on delete set null,
  decision       approval_decision not null default 'pending',
  decided_by     uuid references auth.users(id) on delete set null,
  decided_at     timestamptz,
  decision_note  text check (decision_note is null or char_length(decision_note) <= 1000),
  created_at     timestamptz not null default now()
);

create index idx_approvals_ticket on approvals(ticket_id, created_at desc);

-- ---------- Profiles: email optional (phone-only tenants) ----------
alter table profiles alter column email drop not null;

-- ============================================================
-- Helper functions (SECURITY DEFINER: read past RLS, no recursion)
-- ============================================================

create or replace function is_workspace_member(ws uuid, roles membership_role[] default null)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from memberships m
    where m.workspace_id = ws
      and m.user_id = auth.uid()
      and (roles is null or m.role = any(roles))
  );
$$;

create or replace function is_team_member(ws uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select is_workspace_member(ws, array['admin', 'manager']::membership_role[]);
$$;

create or replace function is_workspace_admin(ws uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select is_workspace_member(ws, array['admin']::membership_role[]);
$$;

-- Owner membership with access to this property.
create or replace function owner_has_property(prop uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from owner_property_access a
    join memberships m on m.workspace_id = a.workspace_id and m.user_id = a.user_id
    where a.property_id = prop
      and a.user_id = auth.uid()
      and m.role = 'owner'
  );
$$;

create or replace function owner_has_unit(unit uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from units u where u.id = unit and owner_has_property(u.property_id)
  );
$$;

-- Account holder of the tenancy.
create or replace function holds_tenancy(ten uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from tenancies t
    where t.id = ten and t.tenant_user_id = auth.uid()
  );
$$;

-- Holder or a device that confirmed a code for the tenancy.
create or replace function can_use_tenancy(ten uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from tenancies t
    where t.id = ten
      and t.ended_at is null
      and (
        t.tenant_user_id = auth.uid()
        or exists (
          select 1 from tenancy_verifications v
          where v.tenancy_id = t.id and v.user_id = auth.uid()
        )
      )
  );
$$;

create or replace function tenant_has_unit(unit uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from tenancies t
    where t.unit_id = unit
      and (
        t.tenant_user_id = auth.uid()
        or exists (
          select 1 from tenancy_verifications v
          where v.tenancy_id = t.id and v.user_id = auth.uid()
        )
      )
  );
$$;

create or replace function tenant_has_property(prop uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from units u where u.property_id = prop and tenant_has_unit(u.id)
  );
$$;

-- How the caller relates to a ticket: 'team' | 'owner' | 'tenant' | null.
create or replace function ticket_access(tid uuid)
returns text
language plpgsql stable security definer set search_path = public
as $$
declare
  t record;
begin
  if auth.uid() is null then
    return null;
  end if;
  select workspace_id, unit_id, tenant_id, tenancy_id into t from tickets where id = tid;
  if not found then
    return null;
  end if;
  if t.workspace_id is not null and is_team_member(t.workspace_id) then
    return 'team';
  end if;
  if t.workspace_id is not null and t.unit_id is not null and owner_has_unit(t.unit_id) then
    return 'owner';
  end if;
  if t.tenant_id = auth.uid() or (t.tenancy_id is not null and holds_tenancy(t.tenancy_id)) then
    return 'tenant';
  end if;
  return null;
end;
$$;

-- True when the request carries an end-user JWT (anon/authenticated), false
-- for the service role, migrations and the SQL editor. Reads the JWT claim,
-- not current_user, because inside SECURITY DEFINER triggers current_user is
-- the function owner.
create or replace function is_end_user_request()
returns boolean
language sql stable
as $$
  select coalesce(auth.jwt() ->> 'role', '') in ('anon', 'authenticated');
$$;

-- ============================================================
-- Integrity triggers
-- ============================================================

-- units.workspace_id always follows its property.
create or replace function units_set_workspace()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  select p.workspace_id into new.workspace_id from properties p where p.id = new.property_id;
  if tg_op = 'UPDATE'
     and (new.intake_token is distinct from old.intake_token or (old.link_active and not new.link_active)) then
    if new.intake_token is distinct from old.intake_token then
      new.link_rotated_at := now();
    end if;
    -- Devices confirmed through the old link must confirm again; tenants who
    -- keep an account are unaffected.
    delete from tenancy_verifications v
      using tenancies t
      where t.id = v.tenancy_id and t.unit_id = new.id;
  end if;
  return new;
end;
$$;

create trigger units_set_workspace
  before insert or update on units
  for each row execute function units_set_workspace();

-- Keep units in step when a property is (re)assigned to a workspace.
create or replace function properties_cascade_workspace()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.workspace_id is distinct from old.workspace_id then
    if is_end_user_request() then
      raise exception 'A property cannot move to another workspace';
    end if;
    update units set workspace_id = new.workspace_id where property_id = new.id;
  end if;
  return new;
end;
$$;

create trigger properties_cascade_workspace
  after update of workspace_id on properties
  for each row execute function properties_cascade_workspace();

-- tenancies.workspace_id always follows its unit.
create or replace function tenancies_set_workspace()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  select u.workspace_id into new.workspace_id from units u where u.id = new.unit_id;
  if new.workspace_id is null then
    raise exception 'Unit % has no workspace', new.unit_id;
  end if;
  return new;
end;
$$;

create trigger tenancies_set_workspace
  before insert or update on tenancies
  for each row execute function tenancies_set_workspace();

-- Owners exist only in company workspaces.
create or replace function memberships_check_role()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.role = 'owner'
     and (select kind from workspaces where id = new.workspace_id) <> 'company' then
    raise exception 'Owners can only be added to a company workspace';
  end if;
  return new;
end;
$$;

create trigger memberships_check_role
  before insert or update on memberships
  for each row execute function memberships_check_role();

create or replace function invitations_check()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.role = 'owner'
     and (select kind from workspaces where id = new.workspace_id) <> 'company' then
    raise exception 'Owners can only be invited to a company workspace';
  end if;
  if new.role <> 'owner' then
    new.property_ids := '{}';
  elsif exists (
    select 1 from unnest(new.property_ids) pid
    where not exists (select 1 from properties p where p.id = pid and p.workspace_id = new.workspace_id)
  ) then
    raise exception 'Invitation lists a property outside its workspace';
  end if;
  if is_end_user_request() and tg_op = 'INSERT' then
    new.invited_by := auth.uid();
    new.accepted_at := null;
    new.accepted_by := null;
    new.revoked_at := null;
  end if;
  return new;
end;
$$;

create trigger invitations_check
  before insert or update on invitations
  for each row execute function invitations_check();

create or replace function owner_access_check()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if not exists (
    select 1 from properties p where p.id = new.property_id and p.workspace_id = new.workspace_id
  ) then
    raise exception 'Property is not in this workspace';
  end if;
  if not exists (
    select 1 from memberships m
    where m.workspace_id = new.workspace_id and m.user_id = new.user_id and m.role = 'owner'
  ) then
    raise exception 'Only owners get per-property access';
  end if;
  return new;
end;
$$;

create trigger owner_access_check
  before insert or update on owner_property_access
  for each row execute function owner_access_check();

-- Tickets: workspace follows the unit; end users cannot move a ticket or
-- change who it belongs to; only the team sets collaboration fields.
create or replace function tickets_guard()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  unit_ws uuid;
begin
  if new.unit_id is not null then
    select u.workspace_id into unit_ws from units u where u.id = new.unit_id;
    new.workspace_id := coalesce(unit_ws, new.workspace_id);
  end if;

  if not is_end_user_request() then
    return new;
  end if;

  if tg_op = 'INSERT' then
    new.stage := 'new';
    new.vendor_name := null;
    new.vendor_booked_for := null;
    new.entry_notice := null;
    new.assigned_to := null;
    return new;
  end if;

  if new.workspace_id is distinct from old.workspace_id
     or new.unit_id is distinct from old.unit_id
     or new.tenancy_id is distinct from old.tenancy_id
     or new.tenant_id is distinct from old.tenant_id then
    raise exception 'A ticket cannot be moved to another unit, tenancy or workspace';
  end if;

  if not is_team_member(old.workspace_id) and (
       new.stage is distinct from old.stage
    or new.vendor_name is distinct from old.vendor_name
    or new.vendor_booked_for is distinct from old.vendor_booked_for
    or new.entry_notice is distinct from old.entry_notice
    or new.assigned_to is distinct from old.assigned_to
  ) then
    raise exception 'Only the workspace team can change status, vendor or entry notice';
  end if;

  return new;
end;
$$;

create trigger tickets_guard
  before insert or update on tickets
  for each row execute function tickets_guard();

-- Comments: workspace from the ticket; author fields from the caller.
create or replace function ticket_comments_fill()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  access text;
  t record;
begin
  select workspace_id, tenancy_id into t from tickets where id = new.ticket_id;
  new.workspace_id := t.workspace_id;

  if not is_end_user_request() then
    return new;
  end if;

  access := ticket_access(new.ticket_id);
  new.author_id := auth.uid();
  new.delivered_at := null;
  new.delivery_error := null;
  new.created_at := now();

  if access = 'team' then
    select m.role::text, coalesce(m.display_name, p.full_name, 'Team member')
      into new.author_role, new.author_name
      from memberships m left join profiles p on p.id = m.user_id
      where m.workspace_id = t.workspace_id and m.user_id = auth.uid();
  elsif access = 'owner' then
    select 'owner', coalesce(m.display_name, p.full_name, 'Owner')
      into new.author_role, new.author_name
      from memberships m left join profiles p on p.id = m.user_id
      where m.workspace_id = t.workspace_id and m.user_id = auth.uid();
  elsif access = 'tenant' then
    new.author_role := 'tenant';
    select coalesce(
             (select te.name from tenancies te where te.id = t.tenancy_id),
             (select p.full_name from profiles p where p.id = auth.uid()),
             'Tenant')
      into new.author_name;
  else
    raise exception 'No access to this ticket';
  end if;
  return new;
end;
$$;

create trigger ticket_comments_fill
  before insert on ticket_comments
  for each row execute function ticket_comments_fill();

-- Approvals: workspace + limit from the ticket's workspace; always start pending.
create or replace function approvals_fill()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  select t.workspace_id, w.approval_limit_cents
    into new.workspace_id, new.limit_cents
    from tickets t join workspaces w on w.id = t.workspace_id
    where t.id = new.ticket_id;
  if is_end_user_request() then
    new.requested_by := auth.uid();
    new.decision := 'pending';
    new.decided_by := null;
    new.decided_at := null;
    new.decision_note := null;
  end if;
  return new;
end;
$$;

create trigger approvals_fill
  before insert on approvals
  for each row execute function approvals_fill();

-- Tenant link lookup (/r/<token>). Returns nothing when the link is off or
-- was replaced. Service role only: the app rate-limits before calling it.
create or replace function intake_unit_for_token(p_token text)
returns table (
  unit_id uuid,
  unit_number text,
  property_id uuid,
  address_line1 text,
  city text,
  workspace_id uuid,
  workspace_name text
)
language sql stable security definer set search_path = public
as $$
  select u.id, u.unit_number, p.id, p.address_line1, p.city, w.id, w.name
  from units u
  join properties p on p.id = u.property_id
  join workspaces w on w.id = u.workspace_id
  where u.intake_token = p_token
    and u.link_active
    and char_length(p_token) >= 20;
$$;

revoke execute on function intake_unit_for_token(text) from public, anon, authenticated;
grant execute on function intake_unit_for_token(text) to service_role;

-- ============================================================
-- Functions end users call (RPC)
-- ============================================================

-- Sign-up: a confirmed, non-anonymous user creates a workspace and becomes
-- its admin.
create or replace function create_workspace(p_name text, p_kind workspace_kind, p_display_name text default null)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  ws uuid;
begin
  if uid is null then
    raise exception 'Not signed in';
  end if;
  if coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) then
    raise exception 'Guest sessions cannot create a workspace';
  end if;
  if not exists (select 1 from auth.users u where u.id = uid and u.email_confirmed_at is not null) then
    raise exception 'Confirm your email first';
  end if;
  if (select count(*) from workspaces w where w.created_by = uid) >= 5 then
    raise exception 'Workspace limit reached';
  end if;

  insert into workspaces (name, kind, created_by)
    values (btrim(p_name), p_kind, uid)
    returning id into ws;
  insert into memberships (workspace_id, user_id, role, display_name)
    values (ws, uid, 'admin', nullif(btrim(coalesce(p_display_name, '')), ''));
  return ws;
end;
$$;

-- Accept an invitation: the token must match, be live, and be addressed to
-- the caller's confirmed email.
create or replace function accept_invitation(p_token text, p_display_name text default null)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  inv invitations%rowtype;
  user_email text;
begin
  if uid is null then
    raise exception 'Not signed in';
  end if;
  select lower(u.email) into user_email
    from auth.users u
    where u.id = uid and u.email_confirmed_at is not null;
  if user_email is null then
    raise exception 'Confirm your email first';
  end if;

  select * into inv from invitations
    where token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex')
    for update;
  if not found or inv.revoked_at is not null or inv.accepted_at is not null or inv.expires_at < now() then
    raise exception 'This invitation is no longer valid';
  end if;
  if inv.email <> user_email then
    raise exception 'This invitation was sent to a different email address';
  end if;

  -- Never downgrade or upgrade an existing member through an invite.
  insert into memberships (workspace_id, user_id, role, display_name)
    values (inv.workspace_id, uid, inv.role, nullif(btrim(coalesce(p_display_name, '')), ''))
    on conflict (workspace_id, user_id) do nothing;

  if inv.role = 'owner' and exists (
    select 1 from memberships m
    where m.workspace_id = inv.workspace_id and m.user_id = uid and m.role = 'owner'
  ) then
    insert into owner_property_access (workspace_id, user_id, property_id)
      select inv.workspace_id, uid, p.id
      from properties p
      where p.id = any(inv.property_ids) and p.workspace_id = inv.workspace_id
      on conflict do nothing;
  end if;

  update invitations set accepted_at = now(), accepted_by = uid where id = inv.id;
  return inv.workspace_id;
end;
$$;

-- Admin changes another member's role. Nobody can change their own role.
create or replace function set_member_role(p_workspace uuid, p_user uuid, p_role membership_role)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not is_workspace_admin(p_workspace) then
    raise exception 'Only a workspace admin can change roles';
  end if;
  if p_user = auth.uid() then
    raise exception 'You cannot change your own role';
  end if;
  update memberships set role = p_role
    where workspace_id = p_workspace and user_id = p_user;
  if not found then
    raise exception 'Not a member of this workspace';
  end if;
  if p_role <> 'owner' then
    delete from owner_property_access where workspace_id = p_workspace and user_id = p_user;
  end if;
end;
$$;

create or replace function remove_member(p_workspace uuid, p_user uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not is_workspace_admin(p_workspace) then
    raise exception 'Only a workspace admin can remove members';
  end if;
  if p_user = auth.uid() then
    raise exception 'You cannot remove yourself';
  end if;
  delete from memberships where workspace_id = p_workspace and user_id = p_user;
end;
$$;

-- Owner of the property (or a workspace admin) decides a pending approval.
create or replace function decide_approval(p_approval uuid, p_decision approval_decision, p_note text default null)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  a approvals%rowtype;
  access text;
begin
  if p_decision not in ('approved', 'declined') then
    raise exception 'Decision must be approved or declined';
  end if;
  select * into a from approvals where id = p_approval for update;
  if not found then
    raise exception 'Approval not found';
  end if;
  access := ticket_access(a.ticket_id);
  if not (coalesce(access, '') = 'owner' or is_workspace_admin(a.workspace_id)) then
    raise exception 'Only the owner or a workspace admin can decide';
  end if;
  if a.decision <> 'pending' then
    raise exception 'Already decided';
  end if;
  update approvals
    set decision = p_decision,
        decided_by = auth.uid(),
        decided_at = now(),
        decision_note = nullif(btrim(coalesce(p_note, '')), '')
    where id = p_approval;
end;
$$;

-- ============================================================
-- Row Level Security
-- ============================================================

alter table workspaces enable row level security;
alter table memberships enable row level security;
alter table invitations enable row level security;
alter table owner_property_access enable row level security;
alter table tenancies enable row level security;
alter table tenancy_verifications enable row level security;
alter table intake_codes enable row level security;
alter table ticket_comments enable row level security;
alter table approvals enable row level security;

-- ---------- Drop every legacy policy (global manager role, manager_id) ----------
drop policy if exists "Managers can read tenant profiles in their properties" on profiles;
drop policy if exists "Users can update own profile" on profiles;
drop policy if exists "Managers can CRUD own properties" on properties;
drop policy if exists "Tenants can read their property" on properties;
drop policy if exists "Managers can CRUD units in their properties" on units;
drop policy if exists "Tenants can read own unit" on units;
drop policy if exists "Tenants can create tickets" on tickets;
drop policy if exists "Tenants can create tickets for their unit" on tickets;
drop policy if exists "Tenants can read own tickets" on tickets;
drop policy if exists "Tenants can update own open tickets" on tickets;
drop policy if exists "Managers can read tickets in their properties" on tickets;
drop policy if exists "Managers can update tickets in their properties" on tickets;
drop policy if exists "Users can insert media for their tickets" on ticket_media;
drop policy if exists "Users can view media on accessible tickets" on ticket_media;
drop policy if exists "Users can insert messages on accessible tickets" on messages;
drop policy if exists "Users can read messages on accessible tickets" on messages;
drop policy if exists "Managers can CRUD own vendors" on vendors;
drop function if exists auth_is_manager_of_property(uuid);

-- ---------- Profiles ----------
-- "Users can read own profile" (from 001) stays.
create policy "Users can update own profile"
  on profiles for update
  using (id = auth.uid())
  with check (id = auth.uid());

-- profiles.role is legacy and must never be user-writable.
revoke update on profiles from anon, authenticated;
grant update (full_name, phone, avatar_url, default_property_address, default_unit_number)
  on profiles to authenticated;
revoke insert, delete on profiles from anon, authenticated;

create policy "Members read profiles of fellow members"
  on profiles for select using (
    exists (
      select 1 from memberships mine
      join memberships theirs on theirs.workspace_id = mine.workspace_id
      where mine.user_id = auth.uid() and theirs.user_id = profiles.id
    )
  );

create policy "Team reads profiles of tenants on its tickets"
  on profiles for select using (
    exists (
      select 1 from tickets t
      where t.tenant_id = profiles.id and is_team_member(t.workspace_id)
    )
  );

-- ---------- Workspaces ----------
create policy "Members read their workspaces"
  on workspaces for select using (is_workspace_member(id));

create policy "Admins update their workspace"
  on workspaces for update
  using (is_workspace_admin(id))
  with check (is_workspace_admin(id));

revoke insert, delete on workspaces from anon, authenticated;
revoke update on workspaces from anon, authenticated;
grant update (name, approval_limit_cents) on workspaces to authenticated;

-- ---------- Memberships (writes only through the functions above) ----------
create policy "Members read memberships of their workspaces"
  on memberships for select using (is_workspace_member(workspace_id));

revoke insert, update, delete on memberships from anon, authenticated;

-- ---------- Invitations ----------
create policy "Admins read invitations"
  on invitations for select using (is_workspace_admin(workspace_id));

create policy "Admins create invitations"
  on invitations for insert with check (is_workspace_admin(workspace_id));

create policy "Admins revoke invitations"
  on invitations for update
  using (is_workspace_admin(workspace_id))
  with check (is_workspace_admin(workspace_id));

-- Sent invitations can only be revoked (accept_invitation runs as owner).
revoke delete, update on invitations from anon, authenticated;
grant update (revoked_at) on invitations to authenticated;

-- ---------- Owner property access ----------
create policy "Team and the owner read owner access"
  on owner_property_access for select
  using (is_team_member(workspace_id) or user_id = auth.uid());

create policy "Admins grant owner access"
  on owner_property_access for insert with check (is_workspace_admin(workspace_id));

create policy "Admins remove owner access"
  on owner_property_access for delete using (is_workspace_admin(workspace_id));

revoke update on owner_property_access from anon, authenticated;

-- ---------- Properties ----------
create policy "Team manages properties"
  on properties for all
  using (is_team_member(workspace_id))
  with check (is_team_member(workspace_id));

create policy "Owners read their properties"
  on properties for select using (owner_has_property(id));

create policy "Tenants read their property"
  on properties for select using (tenant_has_property(id));

-- ---------- Units ----------
create policy "Team manages units"
  on units for all
  using (is_team_member(workspace_id))
  with check (is_team_member(workspace_id));

create policy "Owners read units of their properties"
  on units for select using (owner_has_property(property_id));

create policy "Tenants read their unit"
  on units for select using (tenant_has_unit(id));

-- ---------- Tenancies ----------
create policy "Team reads tenancies"
  on tenancies for select using (is_team_member(workspace_id));

create policy "Team creates tenancies"
  on tenancies for insert with check (is_team_member(workspace_id));

create policy "Team updates tenancies"
  on tenancies for update
  using (is_team_member(workspace_id))
  with check (is_team_member(workspace_id));

create policy "Tenants read their tenancy"
  on tenancies for select using (
    tenant_user_id = auth.uid()
    or exists (
      select 1 from tenancy_verifications v
      where v.tenancy_id = tenancies.id and v.user_id = auth.uid()
    )
  );

-- tenant_user_id (the tenant's account) is set by the server only.
revoke delete, update on tenancies from anon, authenticated;
grant update (name, email, phone, ended_at) on tenancies to authenticated;

create policy "Users read their own verifications"
  on tenancy_verifications for select using (user_id = auth.uid());

revoke insert, update, delete on tenancy_verifications from anon, authenticated;

-- intake_codes: RLS on, no policies → service role only.
revoke all on intake_codes from anon, authenticated;

-- ---------- Tickets ----------
create policy "Team reads workspace tickets"
  on tickets for select using (is_team_member(workspace_id));

create policy "Owners read tickets for their properties"
  on tickets for select using (
    workspace_id is not null and unit_id is not null and owner_has_unit(unit_id)
  );

create policy "Tenants read their tickets"
  on tickets for select using (
    tenant_id = auth.uid()
    or (tenancy_id is not null and holds_tenancy(tenancy_id))
  );

-- New tickets must come through a tenancy the caller confirmed.
create policy "Tenants create tickets for their tenancy"
  on tickets for insert with check (
    tenant_id = auth.uid()
    and tenancy_id is not null
    and can_use_tenancy(tenancy_id)
    and exists (
      select 1 from tenancies te
      where te.id = tickets.tenancy_id and te.unit_id = tickets.unit_id
    )
  );

create policy "Tenants update their open tickets"
  on tickets for update
  using (tenant_id = auth.uid() and status in ('open', 'awaiting_tenant'))
  with check (tenant_id = auth.uid() and status in ('open', 'awaiting_tenant'));

create policy "Team updates workspace tickets"
  on tickets for update
  using (is_team_member(workspace_id))
  with check (is_team_member(workspace_id));

-- ---------- Ticket media ----------
create policy "Users view media on tickets they can see"
  on ticket_media for select using (ticket_access(ticket_id) is not null);

create policy "Tenant or team uploads media"
  on ticket_media for insert with check (
    uploaded_by = auth.uid() and ticket_access(ticket_id) in ('team', 'tenant')
  );

-- ---------- Chat messages (tenant and team; not owners) ----------
create policy "Tenant and team read chat messages"
  on messages for select using (ticket_access(ticket_id) in ('team', 'tenant'));

create policy "Tenant and team write chat messages"
  on messages for insert with check (
    sender_id = auth.uid() and ticket_access(ticket_id) in ('team', 'tenant')
  );

-- ---------- Ticket comments ----------
create policy "Read comments by visibility"
  on ticket_comments for select using (
    case ticket_access(ticket_id)
      when 'team' then true
      when 'owner' then visibility in ('team_owner', 'tenant')
      when 'tenant' then visibility = 'tenant'
      else false
    end
  );

-- Team: any visibility. Owner: "team and owner" only (owners don't message
-- tenants). Tenant: "tenant" only.
create policy "Write comments by role"
  on ticket_comments for insert with check (
    author_id = auth.uid()
    and case ticket_access(ticket_id)
      when 'team' then true
      when 'owner' then visibility = 'team_owner'
      when 'tenant' then visibility = 'tenant'
      else false
    end
  );

revoke update, delete on ticket_comments from anon, authenticated;

-- ---------- Approvals ----------
create policy "Team and owners read approvals"
  on approvals for select using (ticket_access(ticket_id) in ('team', 'owner'));

create policy "Team requests approvals"
  on approvals for insert with check (ticket_access(ticket_id) = 'team');

revoke update, delete on approvals from anon, authenticated;

-- ---------- Vendors ----------
create policy "Team manages vendors"
  on vendors for all
  using (is_team_member(workspace_id))
  with check (is_team_member(workspace_id));

-- ---------- Function privileges ----------
-- Functions are executable by PUBLIC by default; the write functions are for
-- signed-in users only.
revoke execute on function create_workspace(text, workspace_kind, text) from public, anon;
revoke execute on function accept_invitation(text, text) from public, anon;
revoke execute on function set_member_role(uuid, uuid, membership_role) from public, anon;
revoke execute on function remove_member(uuid, uuid) from public, anon;
revoke execute on function decide_approval(uuid, approval_decision, text) from public, anon;
grant execute on function create_workspace(text, workspace_kind, text) to authenticated, service_role;
grant execute on function accept_invitation(text, text) to authenticated, service_role;
grant execute on function set_member_role(uuid, uuid, membership_role) to authenticated, service_role;
grant execute on function remove_member(uuid, uuid) to authenticated, service_role;
grant execute on function decide_approval(uuid, approval_decision, text) to authenticated, service_role;
