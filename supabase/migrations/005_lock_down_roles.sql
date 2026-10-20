-- ============================================================
-- Migration 005: stop privilege escalation through profiles/tickets
-- ============================================================
--
-- Problems fixed:
-- 1. "Users can update own profile" let any signed-in user run
--      update profiles set role = 'manager' where id = auth.uid()
--    and then read every unassigned (unit_id IS NULL) ticket, tenant PII and
--    photos through the manager policies from migration 002.
-- 2. "Tenants can update own open tickets" let a tenant rewrite any column
--    of their ticket (priority, status, assigned_to, tenant_id, unit_id, ...).
--
-- After this migration:
-- - authenticated users can only UPDATE their own contact columns on profiles
--   (column grants), and a trigger rejects role/email/id changes from
--   anon/authenticated as a second line of defence.
-- - tenants can only change the triage columns of their own tickets; status,
--   priority, assignment, ownership and safety fields are written by the
--   server with the service role (or by the property manager).
-- - the service role (admin provisioning, server-side writes) is unaffected.
--
-- Managers are provisioned by an admin, e.g. in the SQL editor:
--   update public.profiles set role = 'manager' where email = '...';
-- ============================================================

-- ---------- Profiles: column-level UPDATE grants ----------
-- A column-level REVOKE does nothing while a table-level grant exists, so
-- revoke the table-level privilege and grant back only the safe columns.
revoke insert, update, delete on public.profiles from anon, authenticated;
grant update (full_name, phone, avatar_url, default_property_address, default_unit_number)
  on public.profiles to authenticated;

drop policy if exists "Users can update own profile" on public.profiles;
create policy "Users can update own profile"
  on public.profiles for update
  using (id = auth.uid())
  with check (id = auth.uid());

-- ---------- Profiles: trigger guard ----------
create or replace function public.prevent_profile_privilege_change()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- current_user is the role PostgREST switched to for this request:
  -- anon/authenticated for end users, service_role for the server.
  if current_user in ('anon', 'authenticated') then
    if new.role is distinct from old.role then
      raise exception 'profiles.role can only be changed by an administrator'
        using errcode = '42501';
    end if;
    if new.email is distinct from old.email or new.id is distinct from old.id then
      raise exception 'profiles.email and profiles.id cannot be changed'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_prevent_privilege_change on public.profiles;
create trigger profiles_prevent_privilege_change
  before update on public.profiles
  for each row execute function public.prevent_profile_privilege_change();

-- ---------- Helper: is the caller a manager? ----------
-- security definer so it can read profiles regardless of the caller's RLS.
create or replace function public.auth_is_manager()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from profiles
    where id = auth.uid() and role = 'manager'
  );
$$;

revoke all on function public.auth_is_manager() from public;
grant execute on function public.auth_is_manager() to anon, authenticated, service_role;

-- ---------- Tickets: tenants may only touch triage columns ----------
create or replace function public.restrict_tenant_ticket_changes()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if current_user not in ('anon', 'authenticated') or public.auth_is_manager() then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.status <> 'open'
       or new.priority <> 'medium'
       or new.assigned_to is not null
       or new.resolved_at is not null
       or new.safety_assessment is not null then
      raise exception 'tenants cannot set ticket status, priority, assignment or safety fields'
        using errcode = '42501';
    end if;
    return new;
  end if;

  -- UPDATE
  if new.id is distinct from old.id
     or new.tenant_id is distinct from old.tenant_id
     or new.unit_id is distinct from old.unit_id
     or new.assigned_to is distinct from old.assigned_to
     or new.priority is distinct from old.priority
     or new.status is distinct from old.status
     or new.resolved_at is distinct from old.resolved_at
     or new.safety_assessment is distinct from old.safety_assessment
     or new.trace_id is distinct from old.trace_id
     or new.created_at is distinct from old.created_at then
    raise exception 'tenants can only update the triage fields of a ticket'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists tickets_restrict_tenant_changes on public.tickets;
create trigger tickets_restrict_tenant_changes
  before insert or update on public.tickets
  for each row execute function public.restrict_tenant_ticket_changes();

-- Make the tenant UPDATE policy's row check explicit (same rows as before).
drop policy if exists "Tenants can update own open tickets" on public.tickets;
create policy "Tenants can update own open tickets"
  on public.tickets for update
  using (
    tenant_id = auth.uid()
    and status in ('open', 'awaiting_tenant')
  )
  with check (
    tenant_id = auth.uid()
    and status in ('open', 'awaiting_tenant')
  );
