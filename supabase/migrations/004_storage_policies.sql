-- ============================================================
-- Migration 004: Fix Storage RLS policies for ticket-media bucket
-- ============================================================
--
-- Problem: The bucket was created manually but storage.objects
-- RLS policies were never applied, blocking all uploads.
--
-- Upload path format: <user_id>/<ticket_id>/<filename>
-- Folder ownership: first path segment must equal auth.uid()
--
-- This migration:
-- 1. Ensures the bucket exists (idempotent)
-- 2. Drops any existing policies (clean slate)
-- 3. Creates folder-ownership-based INSERT, SELECT, DELETE policies
-- ============================================================

-- 1. Ensure bucket exists (no-op if already created manually)
insert into storage.buckets (id, name, public)
values ('ticket-media', 'ticket-media', false)
on conflict (id) do nothing;

-- 2. Drop existing policies if they were partially applied
drop policy if exists "Authenticated users can upload ticket media" on storage.objects;
drop policy if exists "Users can read ticket media" on storage.objects;
drop policy if exists "Users can delete own uploads" on storage.objects;

-- 3. INSERT: authenticated users can upload to their own folder
--    Path must start with auth.uid(): <user_id>/...
create policy "Authenticated users can upload ticket media"
  on storage.objects for insert
  with check (
    bucket_id = 'ticket-media'
    and auth.role() = 'authenticated'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- 4. SELECT: authenticated users can read files in their own folder
create policy "Users can read own ticket media"
  on storage.objects for select
  using (
    bucket_id = 'ticket-media'
    and auth.role() = 'authenticated'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- 5. DELETE: users can delete files in their own folder
create policy "Users can delete own ticket media"
  on storage.objects for delete
  using (
    bucket_id = 'ticket-media'
    and auth.role() = 'authenticated'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
