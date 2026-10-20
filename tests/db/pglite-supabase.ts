/**
 * In-process Postgres (PGlite) that looks enough like Supabase to run the
 * real migrations and exercise RLS: anon/authenticated/service_role roles,
 * auth.users, auth.uid()/auth.jwt() fed from request.jwt.claims (the same
 * setting PostgREST uses), and a stub storage schema.
 *
 * No network, no Supabase project: safe for CI.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { uuid_ossp } from "@electric-sql/pglite/contrib/uuid_ossp";

const ROOT = path.resolve(__dirname, "..", "..");
export const MIGRATIONS_DIR = path.join(ROOT, "supabase", "migrations");
export const DATA_MIGRATION_SCRIPT = path.join(
  ROOT,
  "supabase",
  "scripts",
  "migrate_existing_data_to_workspaces.sql"
);

const SUPABASE_STUBS = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;

create schema auth;
create table auth.users (
  id uuid primary key,
  email text,
  email_confirmed_at timestamptz,
  is_anonymous boolean not null default false,
  created_at timestamptz not null default now()
);
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid
$$;
create function auth.role() returns text language sql stable as $$
  select auth.jwt() ->> 'role'
$$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on all functions in schema auth to anon, authenticated, service_role;

create schema storage;
create table storage.buckets (id text primary key, name text not null, public boolean default false);
create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets(id),
  name text not null,
  owner uuid
);
alter table storage.objects enable row level security;
create function storage.foldername(name text) returns text[] language sql immutable as $$
  select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1]
$$;
grant usage on schema storage to anon, authenticated, service_role;

-- Supabase grants table/function access to the API roles by default and
-- relies on RLS; mirror that so migrations' REVOKEs are meaningful.
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
`;

export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => path.join(MIGRATIONS_DIR, f));
}

/** Fresh database with Supabase stubs and migrations applied (all by default). */
export async function createTestDatabase(opts: { upTo?: string } = {}): Promise<PGlite> {
  const db = await PGlite.create({ extensions: { uuid_ossp } });
  await db.exec(SUPABASE_STUBS);
  for (const file of migrationFiles()) {
    if (opts.upTo && path.basename(file) > opts.upTo) break;
    await db.exec(readFileSync(file, "utf8"));
  }
  return db;
}

export type Actor =
  | { kind: "service" }
  | { kind: "anon" }
  | { kind: "user"; id: string; anonymous?: boolean; email?: string };

type Queryable = PGlite | Transaction;

async function applyActor(tx: Queryable, actor: Actor) {
  if (actor.kind === "service") {
    await tx.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ role: "service_role" }),
    ]);
    await tx.exec("set local role service_role");
    return;
  }
  if (actor.kind === "anon") {
    await tx.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ role: "anon" }),
    ]);
    await tx.exec("set local role anon");
    return;
  }
  await tx.query(`select set_config('request.jwt.claims', $1, true)`, [
    JSON.stringify({
      sub: actor.id,
      role: "authenticated",
      email: actor.email,
      is_anonymous: actor.anonymous ?? false,
    }),
  ]);
  await tx.exec("set local role authenticated");
}

/** Run one statement as an actor, inside a transaction that is always rolled back on error. */
export async function queryAs<T = Record<string, unknown>>(
  db: PGlite,
  actor: Actor,
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  return db.transaction(async (tx) => {
    await applyActor(tx, actor);
    const res = await tx.query<T>(sql, params);
    return res.rows;
  });
}

/** Like queryAs, but reports success/failure instead of throwing. */
export async function tryAs(
  db: PGlite,
  actor: Actor,
  sql: string,
  params: unknown[] = []
): Promise<{ ok: true; rows: Record<string, unknown>[]; affected: number } | { ok: false; error: string }> {
  try {
    const result = await db.transaction(async (tx) => {
      await applyActor(tx, actor);
      const res = await tx.query<Record<string, unknown>>(sql, params);
      return { rows: res.rows, affected: res.affectedRows ?? 0 };
    });
    return { ok: true, ...result };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Insert an auth user (as the platform would on sign-up). */
export async function createAuthUser(
  db: PGlite,
  opts: { email?: string | null; confirmed?: boolean; anonymous?: boolean; fullName?: string } = {}
): Promise<string> {
  const id = (await db.query<{ id: string }>("select gen_random_uuid() as id")).rows[0].id;
  await db.query(
    `insert into auth.users (id, email, email_confirmed_at, is_anonymous)
     values ($1, $2, case when $3 then now() else null end, $4)`,
    [id, opts.email ?? null, opts.confirmed ?? true, opts.anonymous ?? false]
  );
  await db.query(
    `insert into public.profiles (id, email, full_name) values ($1, $2, $3)`,
    [id, opts.email ?? null, opts.fullName ?? opts.email ?? "Guest"]
  );
  return id;
}
