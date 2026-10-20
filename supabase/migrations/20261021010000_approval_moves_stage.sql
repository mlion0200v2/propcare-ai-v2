-- ============================================================
-- Deciding an owner approval moves the ticket on
-- ============================================================
--
-- Before: an approved quote left the ticket at "Waiting for owner".
-- Now decide_approval also updates the stage (only if it was still
-- waiting for the owner):
--   approved → 'vendor_booked' when a visit is already booked,
--              else 'approved' ("Approved, booking vendor")
--   declined → 'new' (the team decides what next)
--
-- Owners can't change ticket fields themselves (tickets_guard). The
-- function sets a transaction-local flag that tickets_guard honours; it
-- can only be set by SQL running inside the database (PostgREST exposes
-- only the public schema's RPCs, never set_config).
-- ============================================================

alter type ticket_stage add value if not exists 'approved' after 'waiting_for_owner';

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

  -- decide_approval moves the stage on the owner's behalf (stage only).
  if current_setting('propcare.approval_decision', true) = 'on'
     and new.vendor_name is not distinct from old.vendor_name
     and new.vendor_booked_for is not distinct from old.vendor_booked_for
     and new.entry_notice is not distinct from old.entry_notice
     and new.assigned_to is not distinct from old.assigned_to then
    return new;
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

  perform set_config('propcare.approval_decision', 'on', true);
  update tickets t
    set stage = case
      when p_decision = 'declined' then 'new'::ticket_stage
      when t.vendor_booked_for is not null then 'vendor_booked'::ticket_stage
      else 'approved'::ticket_stage
    end
    where t.id = a.ticket_id and t.stage = 'waiting_for_owner';
  perform set_config('propcare.approval_decision', 'off', true);
end;
$$;

revoke execute on function decide_approval(uuid, approval_decision, text) from public, anon;
grant execute on function decide_approval(uuid, approval_decision, text) to authenticated, service_role;
