-- ============================================================
-- Try mode (DEMO_MODE=1), outbox previews, vendor work orders,
-- unit profiles
-- ============================================================
--
-- * demo_sandboxes: one private sample workspace per visitor of /try,
--   expiring after 24 h. Service role only.
-- * outbox: messages the app would have sent (email / WhatsApp / WeChat).
--   In demo workspaces nothing is delivered; the team sees a preview card.
-- * work_orders: what a vendor sees through a no-account link (/v/<token>)
--   and where they submit a quote.
-- * units.profile: rooms, fixtures, shut-offs, access notes, pets — entered
--   once by the manager; used by the chat (tap answers, prevention steps).
-- ============================================================

alter table workspaces add column is_demo boolean not null default false;

alter table units add column profile jsonb not null default '{}'::jsonb;

-- ---------- Demo sandboxes ----------
create table demo_sandboxes (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null unique references workspaces(id) on delete cascade,
  -- Demo users the role switcher signs in as.
  admin_id         uuid references auth.users(id) on delete set null,
  owner_id         uuid references auth.users(id) on delete set null,
  tenant_id        uuid references auth.users(id) on delete set null,
  neighbour_id     uuid references auth.users(id) on delete set null,
  focus_ticket_id  uuid references tickets(id) on delete set null,
  chat_turns       integer not null default 0,
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null default now() + interval '24 hours'
);

create index idx_demo_sandboxes_expires on demo_sandboxes(expires_at);

alter table demo_sandboxes enable row level security;
revoke all on demo_sandboxes from anon, authenticated;

-- ---------- Outbox (sent-message log; demo previews) ----------
create table outbox (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references workspaces(id) on delete cascade,
  ticket_id        uuid references tickets(id) on delete cascade,
  channel          text not null check (channel in ('email', 'whatsapp', 'wechat', 'sms')),
  recipient_label  text not null,
  subject          text,
  body             text not null,
  kind             text not null,
  -- true: not delivered (demo workspace); shown as "Sent (demo, not delivered)".
  demo             boolean not null default true,
  created_at       timestamptz not null default now()
);

create index idx_outbox_ticket on outbox(ticket_id, created_at);

alter table outbox enable row level security;

create policy "Team reads the outbox"
  on outbox for select using (is_team_member(workspace_id));

revoke insert, update, delete on outbox from anon, authenticated;

-- ---------- Vendor work orders ----------
create table work_orders (
  id                    uuid primary key default gen_random_uuid(),
  ticket_id             uuid not null references tickets(id) on delete cascade,
  workspace_id          uuid not null references workspaces(id) on delete cascade,
  vendor_id             uuid references vendors(id) on delete set null,
  vendor_name           text not null check (char_length(vendor_name) between 1 and 200),
  -- No-account vendor link: /v/<token>. ~244 random bits.
  token                 text not null unique
                          default replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
  scope                 text not null check (char_length(scope) between 1 and 4000),
  access_window         text check (access_window is null or char_length(access_window) <= 300),
  entry_permission      boolean,
  pets                  text check (pets is null or char_length(pets) <= 300),
  -- The tenant's phone is shown to the vendor only when this is true.
  include_tenant_phone  boolean not null default false,
  status                text not null default 'sent' check (status in ('sent', 'quoted', 'cancelled')),
  quote_cents           integer check (quote_cents is null or quote_cents > 0),
  quote_note            text check (quote_note is null or char_length(quote_note) <= 2000),
  quoted_at             timestamptz,
  created_by            uuid references auth.users(id) on delete set null,
  created_at            timestamptz not null default now()
);

create index idx_work_orders_ticket on work_orders(ticket_id);

create or replace function work_orders_fill()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  select t.workspace_id into new.workspace_id from tickets t where t.id = new.ticket_id;
  if is_end_user_request() and tg_op = 'INSERT' then
    new.created_by := auth.uid();
    new.status := 'sent';
    new.quote_cents := null;
    new.quote_note := null;
    new.quoted_at := null;
  end if;
  return new;
end;
$$;

create trigger work_orders_fill
  before insert on work_orders
  for each row execute function work_orders_fill();

alter table work_orders enable row level security;

create policy "Team reads work orders"
  on work_orders for select using (is_team_member(workspace_id));

create policy "Team creates work orders"
  on work_orders for insert with check (is_team_member(workspace_id));

create policy "Team updates work orders"
  on work_orders for update
  using (is_team_member(workspace_id))
  with check (is_team_member(workspace_id));

-- Quotes come from the vendor link (service role), never from the team's session.
revoke update, delete on work_orders from anon, authenticated;
grant update (status, scope, access_window, entry_permission, pets, include_tenant_phone)
  on work_orders to authenticated;

-- ============================================================
-- Demo functions (service role only)
-- ============================================================

-- One chat turn for a demo sandbox user. 'not_demo' for everyone else.
create or replace function demo_take_chat_turn(p_user uuid, p_limit integer default 40)
returns text
language plpgsql security definer set search_path = public
as $$
declare
  s demo_sandboxes%rowtype;
begin
  select * into s from demo_sandboxes
    where p_user in (admin_id, owner_id, tenant_id, neighbour_id)
    order by created_at desc
    limit 1
    for update;
  if not found then
    return 'not_demo';
  end if;
  if s.expires_at < now() then
    return 'expired';
  end if;
  if s.chat_turns >= p_limit then
    return 'limit';
  end if;
  update demo_sandboxes set chat_turns = chat_turns + 1 where id = s.id;
  return 'ok';
end;
$$;

-- Builds "Demo Rentals" for four existing auth users (created by the app
-- with the admin API; their emails are fake @example.com addresses and
-- nothing is ever sent to them). Returns the sandbox id.
create or replace function create_demo_sandbox(
  p_admin uuid,
  p_owner uuid,
  p_tenant uuid,
  p_neighbour uuid
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  ws uuid;
  sandbox uuid;
  arbutus uuid;
  oak uuid;
  u304 uuid;
  u305 uuid;
  uoak uuid;
  jamie_t uuid;
  priya_t uuid;
  vendor uuid;
  t_sink uuid;
  t_ceiling uuid;
  t_dishwasher uuid;
  tenant_email text := (select lower(email) from auth.users where id = p_tenant);
  neighbour_email text := (select lower(email) from auth.users where id = p_neighbour);
begin
  insert into profiles (id, email, full_name, phone) values
    (p_admin, null, 'Sam Rivera', '604-555-0110'),
    (p_owner, null, 'Riley Chen', '604-555-0120'),
    (p_tenant, tenant_email, 'Jamie Lee', '604-555-0142'),
    (p_neighbour, neighbour_email, 'Priya Shah', '604-555-0177')
  on conflict (id) do nothing;

  insert into workspaces (name, kind, approval_limit_cents, created_by, is_demo)
    values ('Demo Rentals', 'company', 30000, p_admin, true)
    returning id into ws;

  insert into memberships (workspace_id, user_id, role, display_name) values
    (ws, p_admin, 'admin', 'Sam (manager)'),
    (ws, p_owner, 'owner', 'Riley Chen');

  insert into properties (workspace_id, address_line1, city, state, zip, property_type)
    values (ws, '3076 Arbutus Street', 'Vancouver', 'BC', 'V6J 3G1', 'multi_unit')
    returning id into arbutus;
  insert into properties (workspace_id, address_line1, city, state, zip, property_type)
    values (ws, '418 Oak Street', 'Vancouver', 'BC', 'V6H 2L9', 'single_family')
    returning id into oak;

  insert into units (property_id, unit_number, status, profile) values
    (arbutus, '304', 'occupied', jsonb_build_object(
      'rooms', jsonb_build_array('Main bathroom (hallway)', 'Kitchen', 'Laundry closet', 'Bedroom', 'Living room', 'Balcony'),
      'fixtures', jsonb_build_array(
        jsonb_build_object('name', 'Dishwasher', 'room', 'Kitchen', 'brand', 'Bosch', 'model', 'SHE3AR75UC'),
        jsonb_build_object('name', 'Washer', 'room', 'Laundry closet', 'brand', 'LG', 'model', 'WM3400CW'),
        jsonb_build_object('name', 'Kitchen faucet', 'room', 'Kitchen', 'brand', 'Moen', 'model', '7594SRS')),
      'water_shutoff', 'Laundry closet, blue lever behind the washer',
      'breaker_panel', 'Hallway closet, above the coat rail',
      'access_notes', 'Buzz 304. Building manager has a key.',
      'pets', 'One cat (stays in the bedroom during visits)'))
    returning id into u304;
  insert into units (property_id, unit_number, status, profile) values
    (arbutus, '305', 'vacant', jsonb_build_object(
      'rooms', jsonb_build_array('Main bathroom', 'Kitchen', 'Bedroom', 'Living room'),
      'water_shutoff', 'Under the kitchen sink',
      'breaker_panel', 'Entry closet'))
    returning id into u305;
  insert into units (property_id, unit_number, status, profile) values
    (oak, null, 'occupied', jsonb_build_object(
      'rooms', jsonb_build_array('Main bathroom (upstairs hallway)', 'Ensuite', 'Kitchen', 'Laundry (basement)', 'Basement'),
      'fixtures', jsonb_build_array(
        jsonb_build_object('name', 'Hot water tank', 'room', 'Laundry (basement)', 'brand', 'GSW', 'model', 'JW540'),
        jsonb_build_object('name', 'Furnace', 'room', 'Basement', 'brand', 'Lennox', 'model', 'ML180')),
      'water_shutoff', 'Basement, front wall by the water meter',
      'breaker_panel', 'Basement laundry, left of the dryer',
      'access_notes', 'Side door code from the manager.',
      'pets', 'Dog (friendly)'))
    returning id into uoak;

  insert into owner_property_access (workspace_id, user_id, property_id) values (ws, p_owner, arbutus);

  insert into tenancies (unit_id, tenant_user_id, name, email, phone, verified_at)
    values (u304, p_tenant, 'Jamie Lee', tenant_email, '604-555-0142', now())
    returning id into jamie_t;
  insert into tenancies (unit_id, tenant_user_id, name, email, phone, verified_at)
    values (uoak, p_neighbour, 'Priya Shah', neighbour_email, '604-555-0177', now())
    returning id into priya_t;

  insert into vendors (workspace_id, name, trade, phone, email, rating, notes)
    values (ws, 'Westside Plumbing', 'plumbing', '604-555-0199', 'dispatch@westside-plumbing.example', 4.7, 'Demo vendor')
    returning id into vendor;

  -- 1) Waiting for the owner: quote over the limit.
  insert into tickets (unit_id, tenancy_id, tenant_id, title, description, category, priority, status, stage,
                       vendor_name, triage_state, classification, created_at)
  values (u304, jamie_t, p_tenant, 'Kitchen sink, slow drain',
          'Kitchen sink drains slowly since yesterday. Hot water and a plunger helped a bit; still slow.',
          'plumbing', 'medium', 'open', 'waiting_for_owner', 'Westside Plumbing', 'DONE',
          jsonb_build_object(
            'gathered', jsonb_build_object('category', 'plumbing', 'location_in_unit', 'Kitchen', 'started_when', 'Yesterday evening', 'is_emergency', false),
            'summary', E'Slow kitchen drain since yesterday evening.\nTried: hot water, plunger (partly better).\nNo leak under the sink, nothing near outlets.\nLikely trade: plumber (drain line). Same unit had a slow drain in March.'),
          now() - interval '2 days')
  returning id into t_sink;

  insert into messages (ticket_id, sender_id, body, is_bot_reply, created_at) values
    (t_sink, p_tenant, 'My kitchen sink is draining really slowly since yesterday.', false, now() - interval '2 days'),
    (t_sink, p_tenant, 'Thanks, Jamie. Is any water leaking under the sink, or near an outlet?', true, now() - interval '2 days' + interval '20 seconds'),
    (t_sink, p_tenant, 'No leak, it''s just slow.', false, now() - interval '2 days' + interval '1 minute'),
    (t_sink, p_tenant, 'Try this safely: run very hot (not boiling) water for 2 minutes, then use a cup plunger with the other drain blocked.', true, now() - interval '2 days' + interval '80 seconds'),
    (t_sink, p_tenant, 'Plunger helped a bit, still slow.', false, now() - interval '2 days' + interval '6 minutes'),
    (t_sink, p_tenant, 'I''ve sent this to Demo Rentals with what you tried. They usually reply within one business day.', true, now() - interval '2 days' + interval '6 minutes 20 seconds');

  insert into ticket_comments (ticket_id, workspace_id, author_id, author_name, author_role, visibility, body, created_at) values
    (t_sink, ws, p_admin, 'Sam (manager)', 'admin', 'team',
     'Same unit had a slow drain in March. Asking Westside to scope the line, not just snake it.', now() - interval '47 hours'),
    (t_sink, ws, p_admin, 'Sam (manager)', 'admin', 'tenant',
     'Hi Jamie, a plumber from Westside will be in touch to book a time. Thanks for trying the plunger.', now() - interval '46 hours'),
    (t_sink, ws, null, 'PropCare', 'system', 'team_owner',
     'Westside Plumbing quoted $340: camera inspection of the drain line, clear roots if present.', now() - interval '26 hours'),
    (t_sink, ws, null, 'PropCare', 'system', 'team_owner',
     'Sam (manager) asked the owner to approve a $340 quote.', now() - interval '25 hours');

  insert into work_orders (ticket_id, vendor_id, vendor_name, scope, access_window, entry_permission, pets,
                           include_tenant_phone, status, quote_cents, quote_note, quoted_at, created_by, created_at)
  values (t_sink, vendor, 'Westside Plumbing',
          E'Kitchen sink drains slowly (2 days). Plunger helped partly. Recurring: same unit had a slow drain in March.\nPlease camera-inspect the drain line and quote before clearing.',
          'Weekdays 9 a.m. to 5 p.m.', true, 'One cat (stays in the bedroom during visits)', true,
          'quoted', 34000, 'Camera inspection of the drain line; clear roots if present.', now() - interval '26 hours', p_admin,
          now() - interval '46 hours');

  insert into approvals (ticket_id, amount_cents, limit_cents, description, requested_by, created_at)
    values (t_sink, 34000, 30000, 'Westside Plumbing: camera inspection of the drain line, clear roots if present.', p_admin,
            now() - interval '25 hours');

  -- 2) Emergency, reported 25 minutes ago (owner can't see this home).
  insert into tickets (unit_id, tenancy_id, tenant_id, title, description, category, priority, status, stage,
                       triage_state, safety_assessment, classification, created_at)
  values (uoak, priya_t, p_neighbour, 'Water coming through the bathroom ceiling',
          'Water is dripping fast from the bathroom ceiling light. The upstairs toilet was running.',
          'plumbing', 'emergency', 'escalated', 'new', 'EMERGENCY',
          jsonb_build_object('flagged', true, 'reason', 'emergency_detected', 'kind', 'water_electrical', 'phrase', 'dripping from the ceiling light'),
          jsonb_build_object(
            'gathered', jsonb_build_object('category', 'plumbing', 'location_in_unit', 'Main bathroom (upstairs hallway)', 'is_emergency', true),
            'emergency', jsonb_build_object('kind', 'water_electrical', 'manager_notified', true)),
          now() - interval '25 minutes')
  returning id into t_ceiling;

  insert into messages (ticket_id, sender_id, body, is_bot_reply, created_at) values
    (t_ceiling, p_neighbour, 'Water is dripping fast from the bathroom ceiling light!', false, now() - interval '25 minutes'),
    (t_ceiling, p_neighbour, E'This could be dangerous: water near a light fixture.\n1. Don''t touch the light or switch.\n2. Turn off the bathroom breaker at the panel (basement laundry, left of the dryer) if you can reach it safely.\n3. Turn off the main water: basement, front wall by the water meter.\nYour manager has been alerted now.', true, now() - interval '24 minutes');

  -- 3) Fixed in the chat.
  insert into tickets (unit_id, tenancy_id, tenant_id, title, description, category, priority, status, stage,
                       triage_state, classification, created_at, resolved_at)
  values (u304, jamie_t, p_tenant, 'Dishwasher not draining',
          'Bosch dishwasher leaves water at the bottom after a cycle.',
          'appliance', 'low', 'resolved', 'fixed', 'DONE',
          jsonb_build_object(
            'gathered', jsonb_build_object('category', 'appliance', 'location_in_unit', 'Kitchen', 'equipment', 'Bosch SHE3AR75UC', 'is_emergency', false),
            'summary', 'Fixed in chat: tenant cleaned the filter under the lower rack; dishwasher drains normally.'),
          now() - interval '9 days', now() - interval '9 days' + interval '15 minutes')
  returning id into t_dishwasher;

  insert into messages (ticket_id, sender_id, body, is_bot_reply, created_at) values
    (t_dishwasher, p_tenant, 'Dishwasher leaves water at the bottom.', false, now() - interval '9 days'),
    (t_dishwasher, p_tenant, 'Your Bosch has a filter under the lower rack. Twist it counter-clockwise, lift it out and rinse it under the tap.', true, now() - interval '9 days' + interval '30 seconds'),
    (t_dishwasher, p_tenant, 'That worked! It drains now.', false, now() - interval '9 days' + interval '12 minutes');

  insert into demo_sandboxes (workspace_id, admin_id, owner_id, tenant_id, neighbour_id, focus_ticket_id)
    values (ws, p_admin, p_owner, p_tenant, p_neighbour, t_sink)
    returning id into sandbox;
  return sandbox;
end;
$$;

revoke execute on function create_demo_sandbox(uuid, uuid, uuid, uuid) from public, anon, authenticated;
revoke execute on function demo_take_chat_turn(uuid, integer) from public, anon, authenticated;
grant execute on function create_demo_sandbox(uuid, uuid, uuid, uuid) to service_role;
grant execute on function demo_take_chat_turn(uuid, integer) to service_role;
