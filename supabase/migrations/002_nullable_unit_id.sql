-- Migration: Make tickets.unit_id nullable
-- Allows tenants without an assigned unit to create tickets.
-- Updates RLS policies on tickets, ticket_media, and messages
-- to handle NULL unit_id for both tenant and manager paths.

-- ── Make unit_id nullable ──
ALTER TABLE tickets ALTER COLUMN unit_id DROP NOT NULL;

-- ── Ticket policies ──

DROP POLICY "Tenants can create tickets for their unit" ON tickets;
CREATE POLICY "Tenants can create tickets" ON tickets FOR INSERT WITH CHECK (
  tenant_id = auth.uid()
  AND (
    tickets.unit_id IS NULL
    OR exists (select 1 from units where units.id = tickets.unit_id and units.tenant_id = auth.uid())
  )
);

DROP POLICY "Managers can read tickets in their properties" ON tickets;
CREATE POLICY "Managers can read tickets in their properties" ON tickets FOR SELECT USING (
  exists (select 1 from units u join properties p on p.id = u.property_id where u.id = tickets.unit_id and p.manager_id = auth.uid())
  OR (tickets.unit_id IS NULL AND exists (select 1 from profiles where id = auth.uid() and role = 'manager'))
);

DROP POLICY "Managers can update tickets in their properties" ON tickets;
CREATE POLICY "Managers can update tickets in their properties" ON tickets FOR UPDATE USING (
  exists (select 1 from units u join properties p on p.id = u.property_id where u.id = tickets.unit_id and p.manager_id = auth.uid())
  OR (tickets.unit_id IS NULL AND exists (select 1 from profiles where id = auth.uid() and role = 'manager'))
);

-- ── ticket_media policies ──

DROP POLICY "Users can insert media for their tickets" ON ticket_media;
CREATE POLICY "Users can insert media for their tickets" ON ticket_media FOR INSERT WITH CHECK (
  uploaded_by = auth.uid()
  AND exists (
    select 1 from tickets t where t.id = ticket_media.ticket_id
    AND (
      t.tenant_id = auth.uid()
      OR exists (select 1 from units u join properties p on p.id = u.property_id where u.id = t.unit_id and p.manager_id = auth.uid())
      OR (t.unit_id IS NULL AND exists (select 1 from profiles where id = auth.uid() and role = 'manager'))
    )
  )
);

DROP POLICY "Users can view media on accessible tickets" ON ticket_media;
CREATE POLICY "Users can view media on accessible tickets" ON ticket_media FOR SELECT USING (
  exists (
    select 1 from tickets t where t.id = ticket_media.ticket_id
    AND (
      t.tenant_id = auth.uid()
      OR exists (select 1 from units u join properties p on p.id = u.property_id where u.id = t.unit_id and p.manager_id = auth.uid())
      OR (t.unit_id IS NULL AND exists (select 1 from profiles where id = auth.uid() and role = 'manager'))
    )
  )
);

-- ── messages policies ──

DROP POLICY "Users can insert messages on accessible tickets" ON messages;
CREATE POLICY "Users can insert messages on accessible tickets" ON messages FOR INSERT WITH CHECK (
  sender_id = auth.uid()
  AND exists (
    select 1 from tickets t where t.id = messages.ticket_id
    AND (
      t.tenant_id = auth.uid()
      OR exists (select 1 from units u join properties p on p.id = u.property_id where u.id = t.unit_id and p.manager_id = auth.uid())
      OR (t.unit_id IS NULL AND exists (select 1 from profiles where id = auth.uid() and role = 'manager'))
    )
  )
);

DROP POLICY "Users can read messages on accessible tickets" ON messages;
CREATE POLICY "Users can read messages on accessible tickets" ON messages FOR SELECT USING (
  exists (
    select 1 from tickets t where t.id = messages.ticket_id
    AND (
      t.tenant_id = auth.uid()
      OR exists (select 1 from units u join properties p on p.id = u.property_id where u.id = t.unit_id and p.manager_id = auth.uid())
      OR (t.unit_id IS NULL AND exists (select 1 from profiles where id = auth.uid() and role = 'manager'))
    )
  )
);
