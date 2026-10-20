-- ============================================================
-- Access details the tenant gives after the chat: may a vendor enter
-- when nobody is home, when are they available, pets. They pre-fill
-- the vendor work order.
-- ============================================================

alter table tickets add column entry_permission boolean;
alter table tickets add column availability text
  check (availability is null or char_length(availability) <= 300);
alter table tickets add column tenant_pets text
  check (tenant_pets is null or char_length(tenant_pets) <= 300);
alter table tickets add column access_confirmed_at timestamptz;
