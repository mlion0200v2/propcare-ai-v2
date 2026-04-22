/**
 * Phase 1 Full Validation Runner
 * ===============================
 * Runs all 10 validation modules in sequence and prints a summary.
 *
 * Run:  npx tsx tests/integration/phase1-validation.ts
 *
 * NOTE: Prefer using tests/run.ts which has proper gating:
 *   npx tsx tests/run.ts                                    # pure tests only
 *   RUN_INTEGRATION=1 npx tsx tests/run.ts                  # + Supabase tests
 *   RUN_INTEGRATION=1 RUN_EXTERNAL=1 npx tsx tests/run.ts   # full suite
 */
import type { TestResult } from "./helpers";

import { testEnv } from "./test-env";
import { testSupabaseConnection, testTableSchema } from "./test-supabase";
import { testEnums } from "./test-enums";
import { testRLS } from "./test-rls";
import { testRLSIsolation } from "./test-rls-isolation";
import { testFKConstraints } from "./test-fk-constraints";
import { testTriggers } from "./test-triggers";
import { testPinecone } from "./test-pinecone";
import { testOpenAI } from "./test-openai";
import { testValidation } from "./test-validation";
import { testTypes } from "./test-types";
import { testE2E } from "./test-e2e";

async function main() {
  const startTime = Date.now();

  console.log("\n\x1b[1m🔧 Phase 1 Infrastructure Validation\x1b[0m");
  console.log("   PropCare-AI v2");
  console.log(`   ${new Date().toISOString()}\n`);

  const totals: TestResult = { passed: 0, failed: 0, skipped: 0 };

  function merge(r: TestResult) {
    totals.passed += r.passed;
    totals.failed += r.failed;
    totals.skipped += r.skipped;
  }

  //  1. Environment variables
  const envResult = testEnv();
  merge(envResult);

  //  2–3. Supabase connectivity + schema
  const { client, ...connResult } = await testSupabaseConnection();
  merge(connResult);
  merge(await testTableSchema(client));

  //  4. Enums
  merge(await testEnums(client));

  //  5. RLS
  merge(await testRLS(client));

  //  5b. RLS Isolation
  merge(await testRLSIsolation(client));

  //  5c. FK Constraints
  merge(await testFKConstraints(client));

  //  5d. Triggers
  merge(await testTriggers(client));

  //  6. Pinecone
  merge(await testPinecone());

  //  7. OpenAI
  merge(await testOpenAI());

  //  8. Zod validation schemas
  merge(testValidation());

  //  9. TypeScript types
  merge(testTypes());

  // 10. End-to-end workflow
  merge(await testE2E(client));

  // ── Summary ──
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log(`\n\x1b[36m${"═".repeat(60)}\x1b[0m`);
  console.log("\x1b[1m PHASE 1 VALIDATION RESULTS\x1b[0m");
  console.log(`\x1b[36m${"═".repeat(60)}\x1b[0m`);
  console.log(`  \x1b[32m✅ Passed:  ${totals.passed}\x1b[0m`);
  console.log(`  \x1b[31m❌ Failed:  ${totals.failed}\x1b[0m`);
  console.log(`  \x1b[33m⏭️  Skipped: ${totals.skipped}\x1b[0m`);
  console.log(`  📊 Total:   ${totals.passed + totals.failed + totals.skipped}`);
  console.log(`  ⏱️  Time:    ${elapsed}s`);
  console.log(`\x1b[36m${"═".repeat(60)}\x1b[0m`);

  if (totals.failed === 0 && totals.skipped === 0) {
    console.log("\n\x1b[32m🎉 Phase 1 PASSED — all checks green!\x1b[0m");
    console.log("\x1b[32m   Infrastructure is production-ready.\x1b[0m");
    console.log("\x1b[32m   Clear to proceed to Phase 2.\x1b[0m\n");
  } else if (totals.failed === 0) {
    console.log("\n\x1b[33m⚠️  Phase 1 PASSED with skips.\x1b[0m");
    console.log(`\x1b[33m   ${totals.skipped} test(s) skipped — review above.\x1b[0m\n`);
  } else {
    console.log(`\n\x1b[31m🚫 Phase 1 FAILED — ${totals.failed} issue(s) to fix.\x1b[0m`);
    console.log("\x1b[31m   Do NOT proceed to Phase 2 until all checks pass.\x1b[0m\n");
  }

  process.exit(totals.failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("\n💥 Fatal error:", e);
  process.exit(1);
});
