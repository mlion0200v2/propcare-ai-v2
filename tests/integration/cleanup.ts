/**
 * Cleanup: Remove orphaned test users and data.
 * Run:  npx tsx tests/integration/cleanup.ts
 *
 * Finds auth users with emails matching *@test.local and deletes them.
 * Safe to run repeatedly.
 */
import "dotenv/config";
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";
import type { Database } from "../../src/lib/supabase/database-generated";

async function cleanup() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceKey) {
    console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    process.exit(1);
  }

  const admin = createClient<Database>(url, serviceKey, {
    auth: { persistSession: false },
  });

  console.log("Scanning for orphaned test users...\n");

  let page = 1;
  let deleted = 0;

  while (true) {
    const { data, error } = await admin.auth.admin.listUsers({
      page,
      perPage: 100,
    });

    if (error) {
      console.error("Error listing users:", error.message);
      break;
    }

    const testUsers = data.users.filter((u) =>
      u.email?.endsWith("@test.local")
    );

    for (const user of testUsers) {
      try {
        await admin.from("vendors").delete().eq("manager_id", user.id);
        await admin.auth.admin.deleteUser(user.id);
        console.log(`  Deleted: ${user.email}`);
        deleted++;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`  Failed to delete ${user.email}: ${msg}`);
      }
    }

    if (data.users.length < 100) break;
    page++;
  }

  console.log(deleted > 0
    ? `\nCleaned up ${deleted} test user(s).`
    : "No orphaned test users found."
  );
}

cleanup().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
