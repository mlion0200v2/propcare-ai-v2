-- Migration: Add default address/unit columns to profiles for cross-session persistence
-- These columns store the tenant's last-used address and unit number so that
-- subsequent tickets can pre-fill CONFIRM_PROFILE instead of re-asking.

ALTER TABLE profiles ADD COLUMN default_property_address text;
ALTER TABLE profiles ADD COLUMN default_unit_number text;

-- No index needed: we only query profiles by id (primary key).
-- RLS: the existing "Users can update own profile" policy (using id = auth.uid())
-- covers these new columns with no changes required.
