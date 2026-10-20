-- ============================================================
-- Local demo data — runs after migrations on `npx supabase db reset`.
-- LOCAL ONLY: never run this against a hosted project.
-- ============================================================
--
-- Sign in at http://localhost:3000/login with any of these (password for
-- all: propcare-demo-1234):
--
--   admin@example.test    admin of "Demo Property Management" (company)
--   manager@example.test  manager in the same workspace
--   owner@example.test    owner, sees 3076 Arbutus Street only
--   tenant@example.test   tenant with an account for Unit 101 (sign in with
--                         an email link; it arrives in Mailpit)
--
-- Tenant links (no sign-in needed; the one-time code arrives in Mailpit,
-- or in the dev-server console when RESEND_API_KEY is unset):
--
--   http://localhost:3000/r/demo-link-arbutus-unit-101
--   http://localhost:3000/r/demo-link-arbutus-unit-102
--   http://localhost:3000/r/demo-link-oak-street-house  (property the owner can't see)
-- ============================================================

-- ---------- Auth users (email confirmed, password sign-in) ----------
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change, email_change_token_new,
  email_change_token_current, phone_change, phone_change_token, reauthentication_token
)
select
  '00000000-0000-0000-0000-000000000000', u.id, 'authenticated', 'authenticated', u.email,
  extensions.crypt('propcare-demo-1234', extensions.gen_salt('bf')), now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  jsonb_build_object('full_name', u.full_name), now(), now(),
  '', '', '', '', '', '', '', ''
from (values
  ('00000000-0000-4000-a000-000000000001'::uuid, 'admin@example.test',   'Avery Admin'),
  ('00000000-0000-4000-a000-000000000002'::uuid, 'manager@example.test', 'Morgan Manager'),
  ('00000000-0000-4000-a000-000000000003'::uuid, 'owner@example.test',   'Olivia Owner'),
  ('00000000-0000-4000-a000-000000000004'::uuid, 'tenant@example.test',  'Taylor Tenant')
) as u(id, email, full_name);

insert into auth.identities (id, user_id, provider_id, provider, identity_data, last_sign_in_at, created_at, updated_at)
select gen_random_uuid(), u.id, u.id::text, 'email',
       jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true),
       now(), now(), now()
from auth.users u
where u.email like '%@example.test';

insert into profiles (id, email, full_name, phone)
select u.id, u.email, u.raw_user_meta_data ->> 'full_name', '604-555-0100'
from auth.users u
where u.email like '%@example.test';

-- ---------- Workspace, members ----------
insert into workspaces (id, name, kind, approval_limit_cents, created_by) values
  ('00000000-0000-4000-b000-000000000001', 'Demo Property Management', 'company', 30000,
   '00000000-0000-4000-a000-000000000001');

insert into memberships (workspace_id, user_id, role, display_name) values
  ('00000000-0000-4000-b000-000000000001', '00000000-0000-4000-a000-000000000001', 'admin',   'Avery Admin'),
  ('00000000-0000-4000-b000-000000000001', '00000000-0000-4000-a000-000000000002', 'manager', 'Morgan Manager'),
  ('00000000-0000-4000-b000-000000000001', '00000000-0000-4000-a000-000000000003', 'owner',   'Olivia Owner');

-- ---------- Homes and units ----------
insert into properties (id, workspace_id, address_line1, city, state, zip, property_type) values
  ('00000000-0000-4000-8c00-000000000001', '00000000-0000-4000-b000-000000000001',
   '3076 Arbutus Street', 'Vancouver', 'BC', 'V6J 3G1', 'multi_unit'),
  ('00000000-0000-4000-8c00-000000000002', '00000000-0000-4000-b000-000000000001',
   '418 Oak Street', 'Vancouver', 'BC', 'V6H 2L9', 'single_family');

-- workspace_id is filled in by trigger from the property.
insert into units (id, property_id, unit_number, status, intake_token) values
  ('00000000-0000-4000-8d00-000000000101', '00000000-0000-4000-8c00-000000000001', '101', 'occupied', 'demo-link-arbutus-unit-101'),
  ('00000000-0000-4000-8d00-000000000102', '00000000-0000-4000-8c00-000000000001', '102', 'vacant',   'demo-link-arbutus-unit-102'),
  ('00000000-0000-4000-8d00-000000000201', '00000000-0000-4000-8c00-000000000002', null,  'occupied', 'demo-link-oak-street-house');

insert into owner_property_access (workspace_id, user_id, property_id) values
  ('00000000-0000-4000-b000-000000000001', '00000000-0000-4000-a000-000000000003', '00000000-0000-4000-8c00-000000000001');

-- ---------- A tenant with an account, and one request ----------
insert into tenancies (id, unit_id, tenant_user_id, name, email, phone, verified_at) values
  ('00000000-0000-4000-8e00-000000000001', '00000000-0000-4000-8d00-000000000101',
   '00000000-0000-4000-a000-000000000004', 'Taylor Tenant', 'tenant@example.test', '604-555-0142', now());

insert into tickets (id, unit_id, tenancy_id, tenant_id, title, description, category, triage_state, stage, classification)
values (
  '00000000-0000-4000-8f00-000000000001',
  '00000000-0000-4000-8d00-000000000101',
  '00000000-0000-4000-8e00-000000000001',
  '00000000-0000-4000-a000-000000000004',
  'Kitchen sink, slow drain',
  'Kitchen sink drains slowly since yesterday. Tried hot water and a plunger: better, still slow.',
  'plumbing', 'DONE', 'new',
  '{"gathered": {"category": "plumbing", "location_in_unit": "kitchen", "started_when": "yesterday", "is_emergency": false}, "summary": "Slow kitchen drain; plunger helped partly. No leak, nothing near outlets."}'::jsonb
);

insert into messages (ticket_id, sender_id, body, is_bot_reply, created_at) values
  ('00000000-0000-4000-8f00-000000000001', '00000000-0000-4000-a000-000000000004',
   'Kitchen sink drains slowly since yesterday.', false, now() - interval '2 hours'),
  ('00000000-0000-4000-8f00-000000000001', '00000000-0000-4000-a000-000000000004',
   'Thanks — I''ve sent this to your property manager with what you tried.', true, now() - interval '1 hour 50 minutes');

insert into ticket_comments (ticket_id, workspace_id, author_id, author_name, author_role, visibility, body, created_at) values
  ('00000000-0000-4000-8f00-000000000001', '00000000-0000-4000-b000-000000000001',
   '00000000-0000-4000-a000-000000000002', 'Morgan Manager', 'manager', 'team',
   'Same unit had a slow drain in March. Ask the plumber to scope the line.', now() - interval '90 minutes'),
  ('00000000-0000-4000-8f00-000000000001', '00000000-0000-4000-b000-000000000001',
   '00000000-0000-4000-a000-000000000002', 'Morgan Manager', 'manager', 'team_owner',
   'Plumber quote expected to be around $340.', now() - interval '80 minutes'),
  ('00000000-0000-4000-8f00-000000000001', '00000000-0000-4000-b000-000000000001',
   '00000000-0000-4000-a000-000000000002', 'Morgan Manager', 'manager', 'tenant',
   'Hi Taylor, we''re booking a plumber and will confirm a time shortly.', now() - interval '70 minutes');
