/**
 * Shared test utilities for Phase 1 validation.
 */
import "dotenv/config";
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../src/lib/supabase/database-generated";

// ── Constants ──

export const TEST_RUN_ID = `t${Date.now()}`;
export const TEST_PASSWORD = "TestPass!Phase1-2024";
export const TEST_EMAIL_DOMAIN = "test.local";

// ── Result type ──

export interface TestResult {
  passed: number;
  failed: number;
  skipped: number;
}

// ── Runner factory ──

export function createRunner() {
  const result: TestResult = { passed: 0, failed: 0, skipped: 0 };

  return {
    pass(msg: string) {
      result.passed++;
      console.log(`  \x1b[32m✅ ${msg}\x1b[0m`);
    },
    fail(msg: string, detail?: unknown) {
      result.failed++;
      console.log(`  \x1b[31m❌ ${msg}\x1b[0m`);
      if (detail) {
        const str = detail instanceof Error ? detail.message : typeof detail === "object" ? JSON.stringify(detail) : String(detail);
        console.log(`     \x1b[90m→ ${str}\x1b[0m`);
      }
    },
    skip(msg: string, reason?: string) {
      result.skipped++;
      console.log(`  \x1b[33m⏭️  ${msg}${reason ? ` (${reason})` : ""}\x1b[0m`);
    },
    result,
  };
}

// ── Section header ──

export function printSection(title: string) {
  console.log(`\n\x1b[36m${"═".repeat(60)}\x1b[0m`);
  console.log(`\x1b[1m ${title}\x1b[0m`);
  console.log(`\x1b[36m${"═".repeat(60)}\x1b[0m`);
}

// ── Helpers ──

export function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

export function testEmail(label: string): string {
  return `${TEST_RUN_ID}-${label}@${TEST_EMAIL_DOMAIN}`;
}

// ── Environment gates ──

export function isIntegrationEnabled(): boolean {
  return process.env.RUN_INTEGRATION === "1";
}

export function isExternalEnabled(): boolean {
  return process.env.RUN_EXTERNAL === "1";
}

// ── Supabase clients ──

export function getAdminClient(): SupabaseClient<Database> | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient<Database>(url, key, { auth: { persistSession: false } });
}

export function getAnonClient(): SupabaseClient<Database> | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  return createClient<Database>(url, key, { auth: { persistSession: false } });
}

export async function getAuthenticatedClient(
  email: string,
  password: string
): Promise<SupabaseClient<Database>> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) throw new Error("Missing SUPABASE_URL or ANON_KEY");

  const client = createClient<Database>(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`Sign-in failed (${email}): ${error.message}`);

  return client;
}

// ── Test user lifecycle ──

export async function createTestUser(
  adminClient: SupabaseClient<Database>,
  label: string,
  role: "tenant" | "manager"
): Promise<{ userId: string; email: string }> {
  const email = testEmail(label);
  const { data, error } = await adminClient.auth.admin.createUser({
    email,
    password: TEST_PASSWORD,
    email_confirm: true,
    user_metadata: { role, full_name: `Test ${label}` },
  });
  if (error) throw new Error(`createUser(${label}): ${error.message}`);

  const userId = data.user.id;

  const { error: profileErr } = await adminClient.from("profiles").insert({
    id: userId,
    email,
    full_name: `Test ${label}`,
    role,
  });
  if (profileErr) throw new Error(`createProfile(${label}): ${profileErr.message}`);

  return { userId, email };
}

export async function cleanupTestUser(
  adminClient: SupabaseClient<Database>,
  userId: string
): Promise<void> {
  await adminClient.from("vendors").delete().eq("manager_id", userId);
  await adminClient.auth.admin.deleteUser(userId);
}

// ── Standalone runner wrapper ──

export function runStandalone(fn: () => TestResult | Promise<TestResult>) {
  Promise.resolve(fn())
    .then((r) => {
      console.log(`\n  Passed: ${r.passed} | Failed: ${r.failed} | Skipped: ${r.skipped}`);
      process.exit(r.failed > 0 ? 1 : 0);
    })
    .catch((e) => {
      console.error("\n💥 Fatal:", e);
      process.exit(1);
    });
}

export type { SupabaseClient, Database };
