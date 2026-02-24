-- ============================================================
-- PropCare-AI v2 — Initial Schema
-- ============================================================

-- ---------- Extensions ----------
create extension if not exists "uuid-ossp";

-- ---------- Enums ----------
create type user_role as enum ('tenant', 'manager');
create type property_type as enum ('single_family', 'multi_unit', 'condo', 'commercial');
create type unit_status as enum ('occupied', 'vacant', 'maintenance');
create type ticket_status as enum ('open', 'in_progress', 'awaiting_tenant', 'escalated', 'resolved', 'closed');
create type ticket_priority as enum ('low', 'medium', 'high', 'emergency');
create type ticket_category as enum (
  'plumbing', 'electrical', 'hvac', 'appliance', 'structural',
  'pest_control', 'locksmith', 'roofing', 'painting', 'flooring',
  'landscaping', 'general', 'other'
);
create type media_type as enum ('photo', 'video');

-- ---------- Helper: auto-update updated_at ----------
create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

-- ============================================================
-- Tables
-- ============================================================

-- ---------- Profiles ----------
create table profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text not null unique,
  full_name   text not null,
  phone       text,
  role        user_role not null default 'tenant',
  avatar_url  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create trigger profiles_updated_at
  before update on profiles
  for each row execute function update_updated_at();

-- ---------- Properties ----------
create table properties (
  id              uuid primary key default uuid_generate_v4(),
  manager_id      uuid not null references profiles(id) on delete cascade,
  address_line1   text not null,
  address_line2   text,
  city            text not null,
  state           text not null,
  zip             text not null,
  property_type   property_type not null default 'single_family',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index idx_properties_manager on properties(manager_id);

create trigger properties_updated_at
  before update on properties
  for each row execute function update_updated_at();

-- ---------- Units ----------
create table units (
  id            uuid primary key default uuid_generate_v4(),
  property_id   uuid not null references properties(id) on delete cascade,
  unit_number   text,                -- NULL for single-family homes
  tenant_id     uuid references profiles(id) on delete set null,
  status        unit_status not null default 'vacant',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index idx_units_property on units(property_id);
create index idx_units_tenant on units(tenant_id);

create trigger units_updated_at
  before update on units
  for each row execute function update_updated_at();

-- ---------- Tickets ----------
create table tickets (
  id                      uuid primary key default uuid_generate_v4(),
  unit_id                 uuid not null references units(id) on delete cascade,
  tenant_id               uuid not null references profiles(id) on delete cascade,
  assigned_to             uuid references profiles(id) on delete set null,

  title                   text not null,
  description             text not null,
  category                ticket_category not null default 'general',
  priority                ticket_priority not null default 'medium',
  status                  ticket_status not null default 'open',

  -- AI triage outputs (populated by triage agent)
  classification          jsonb,   -- { category, confidence, reasoning }
  safety_assessment       jsonb,   -- { is_emergency, risk_level, reasoning }
  similar_issues          jsonb,   -- [{ ticket_id, score, summary }]
  troubleshooting_steps   jsonb,   -- [{ step, description, completed }]

  -- Triage state tracking (Phase 2A)
  triage_state            text not null default 'GATHER_INFO',
  trace_id                uuid default gen_random_uuid(),

  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  resolved_at             timestamptz
);

create index idx_tickets_unit on tickets(unit_id);
create index idx_tickets_tenant on tickets(tenant_id);
create index idx_tickets_status on tickets(status);
create index idx_tickets_priority on tickets(priority);
create index idx_tickets_assigned on tickets(assigned_to);
create index idx_tickets_created on tickets(created_at desc);

create trigger tickets_updated_at
  before update on tickets
  for each row execute function update_updated_at();

-- ---------- Ticket Media ----------
create table ticket_media (
  id              uuid primary key default uuid_generate_v4(),
  ticket_id       uuid not null references tickets(id) on delete cascade,
  file_path       text not null,
  file_type       media_type not null,
  mime_type       text not null,
  file_size       integer not null,
  display_order   smallint not null default 1,
  uploaded_by     uuid not null references profiles(id) on delete cascade,
  created_at      timestamptz not null default now()
);

create index idx_ticket_media_ticket on ticket_media(ticket_id);

-- Enforce max 5 photos per ticket
create or replace function check_media_limits()
returns trigger as $$
declare
  photo_count integer;
  video_count integer;
begin
  select count(*) into photo_count
    from ticket_media
    where ticket_id = new.ticket_id and file_type = 'photo';

  select count(*) into video_count
    from ticket_media
    where ticket_id = new.ticket_id and file_type = 'video';

  if new.file_type = 'photo' and photo_count >= 5 then
    raise exception 'Maximum 5 photos per ticket';
  end if;

  if new.file_type = 'video' and video_count >= 1 then
    raise exception 'Maximum 1 video per ticket';
  end if;

  return new;
end;
$$ language plpgsql;

create trigger enforce_media_limits
  before insert on ticket_media
  for each row execute function check_media_limits();

-- ---------- Messages ----------
create table messages (
  id            uuid primary key default uuid_generate_v4(),
  ticket_id     uuid not null references tickets(id) on delete cascade,
  sender_id     uuid not null references profiles(id) on delete cascade,
  body          text not null,
  is_bot_reply  boolean not null default false,
  created_at    timestamptz not null default now()
);

create index idx_messages_ticket on messages(ticket_id);
create index idx_messages_created on messages(ticket_id, created_at);

-- ---------- Vendors ----------
create table vendors (
  id          uuid primary key default uuid_generate_v4(),
  manager_id  uuid not null references profiles(id) on delete cascade,
  name        text not null,
  trade       ticket_category not null,
  phone       text,
  email       text,
  rating      numeric(2,1) check (rating >= 1 and rating <= 5),
  notes       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index idx_vendors_manager on vendors(manager_id);
create index idx_vendors_trade on vendors(trade);

create trigger vendors_updated_at
  before update on vendors
  for each row execute function update_updated_at();

-- ============================================================
-- Row Level Security
-- ============================================================

alter table profiles enable row level security;
alter table properties enable row level security;
alter table units enable row level security;
alter table tickets enable row level security;
alter table ticket_media enable row level security;
alter table messages enable row level security;
alter table vendors enable row level security;

-- ---------- RLS helper (breaks units ↔ properties recursion) ----------
-- Without this, units policy queries properties and properties policy
-- queries units, causing PostgreSQL error 42P17 (infinite recursion).
create or replace function auth_is_manager_of_property(prop_id uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1 from properties
    where id = prop_id and manager_id = auth.uid()
  );
$$;

-- ---------- Profiles ----------
create policy "Users can read own profile"
  on profiles for select using (id = auth.uid());

create policy "Users can update own profile"
  on profiles for update using (id = auth.uid());

create policy "Managers can read tenant profiles in their properties"
  on profiles for select using (
    exists (
      select 1 from units u
      join properties p on p.id = u.property_id
      where u.tenant_id = profiles.id
        and p.manager_id = auth.uid()
    )
  );

-- ---------- Properties ----------
create policy "Managers can CRUD own properties"
  on properties for all using (manager_id = auth.uid());

create policy "Tenants can read their property"
  on properties for select using (
    exists (
      select 1 from units
      where units.property_id = properties.id
        and units.tenant_id = auth.uid()
    )
  );

-- ---------- Units ----------
create policy "Managers can CRUD units in their properties"
  on units for all using (auth_is_manager_of_property(property_id));

create policy "Tenants can read own unit"
  on units for select using (tenant_id = auth.uid());

-- ---------- Tickets ----------
create policy "Tenants can create tickets for their unit"
  on tickets for insert with check (
    tenant_id = auth.uid()
    and exists (
      select 1 from units
      where units.id = tickets.unit_id
        and units.tenant_id = auth.uid()
    )
  );

create policy "Tenants can read own tickets"
  on tickets for select using (tenant_id = auth.uid());

create policy "Tenants can update own open tickets"
  on tickets for update using (
    tenant_id = auth.uid()
    and status in ('open', 'awaiting_tenant')
  );

create policy "Managers can read tickets in their properties"
  on tickets for select using (
    exists (
      select 1 from units u
      join properties p on p.id = u.property_id
      where u.id = tickets.unit_id
        and p.manager_id = auth.uid()
    )
  );

create policy "Managers can update tickets in their properties"
  on tickets for update using (
    exists (
      select 1 from units u
      join properties p on p.id = u.property_id
      where u.id = tickets.unit_id
        and p.manager_id = auth.uid()
    )
  );

-- ---------- Ticket Media ----------
create policy "Users can insert media for their tickets"
  on ticket_media for insert
  with check (
    uploaded_by = auth.uid()
    and exists (
      select 1 from tickets t
      where t.id = ticket_media.ticket_id
        and (
          t.tenant_id = auth.uid()
          or exists (
            select 1 from units u
            join properties p on p.id = u.property_id
            where u.id = t.unit_id
              and p.manager_id = auth.uid()
          )
        )
    )
  );

create policy "Users can view media on accessible tickets"
  on ticket_media for select using (
    exists (
      select 1 from tickets t
      where t.id = ticket_media.ticket_id
        and (
          t.tenant_id = auth.uid()
          or exists (
            select 1 from units u
            join properties p on p.id = u.property_id
            where u.id = t.unit_id
              and p.manager_id = auth.uid()
          )
        )
    )
  );

-- ---------- Messages ----------
create policy "Users can insert messages on accessible tickets"
  on messages for insert with check (
    sender_id = auth.uid()
    and exists (
      select 1 from tickets t
      where t.id = messages.ticket_id
        and (
          t.tenant_id = auth.uid()
          or exists (
            select 1 from units u
            join properties p on p.id = u.property_id
            where u.id = t.unit_id
              and p.manager_id = auth.uid()
          )
        )
    )
  );

create policy "Users can read messages on accessible tickets"
  on messages for select using (
    exists (
      select 1 from tickets t
      where t.id = messages.ticket_id
        and (
          t.tenant_id = auth.uid()
          or exists (
            select 1 from units u
            join properties p on p.id = u.property_id
            where u.id = t.unit_id
              and p.manager_id = auth.uid()
          )
        )
    )
  );

-- ---------- Vendors ----------
create policy "Managers can CRUD own vendors"
  on vendors for all using (manager_id = auth.uid());

-- ============================================================
-- Storage: ticket-media bucket
-- ============================================================

insert into storage.buckets (id, name, public)
values ('ticket-media', 'ticket-media', false);

-- Authenticated users can upload to their own ticket folders
create policy "Authenticated users can upload ticket media"
  on storage.objects for insert
  with check (
    bucket_id = 'ticket-media'
    and auth.role() = 'authenticated'
  );

-- Users can read media from tickets they have access to
create policy "Users can read ticket media"
  on storage.objects for select
  using (
    bucket_id = 'ticket-media'
    and auth.role() = 'authenticated'
  );

-- Users can delete their own uploads
create policy "Users can delete own uploads"
  on storage.objects for delete
  using (
    bucket_id = 'ticket-media'
    and auth.uid()::text = (storage.foldername(name))[1]
  );
