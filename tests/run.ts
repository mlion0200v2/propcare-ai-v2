/**
 * Phase 1 Test Suite Runner
 * =========================
 * Usage:
 *   npx tsx tests/run.ts                                    # pure tests only
 *   RUN_INTEGRATION=1 npx tsx tests/run.ts                  # + Supabase tests
 *   RUN_INTEGRATION=1 RUN_EXTERNAL=1 npx tsx tests/run.ts   # full suite
 *
 * Cleanup:
 *   npx tsx tests/integration/cleanup.ts
 */
import type { TestResult } from "./integration/helpers";

import { testEnv } from "./integration/test-env";
import { testValidation } from "./integration/test-validation";
import { testTypes } from "./integration/test-types";
import { testTriageChatBasic } from "./integration/test-triage-chat-basic";
import { testTriageNoUnit } from "./integration/test-triage-no-unit";
import { testRetrieval } from "./integration/test-retrieval";
import { testPhase2B } from "./integration/test-phase2b";
import { testValidateGroundedResult } from "./integration/test-validate";

import { testSupabaseConnection, testTableSchema } from "./integration/test-supabase";
import { testEnums } from "./integration/test-enums";
import { testRLS } from "./integration/test-rls";
import { testRLSIsolation } from "./integration/test-rls-isolation";
import { testFKConstraints } from "./integration/test-fk-constraints";
import { testTriggers } from "./integration/test-triggers";
import { testE2E } from "./integration/test-e2e";

import { testPinecone } from "./integration/test-pinecone";
import { testOpenAI } from "./integration/test-openai";

async function main() {
  const startTime = Date.now();

  console.log("\n\x1b[1m Phase 1 Test Suite\x1b[0m");
  console.log("   PropCare-AI v2 (MaintenanceWise)");
  console.log(`   ${new Date().toISOString()}`);
  console.log(`   RUN_INTEGRATION=${process.env.RUN_INTEGRATION ?? "0"}`);
  console.log(`   RUN_EXTERNAL=${process.env.RUN_EXTERNAL ?? "0"}\n`);

  const totals: TestResult = { passed: 0, failed: 0, skipped: 0 };
  function merge(r: TestResult) {
    totals.passed += r.passed;
    totals.failed += r.failed;
    totals.skipped += r.skipped;
  }

  // ── Phase A: Pure tests (always run) ──
  console.log("\x1b[1m-- Phase A: Pure Tests --\x1b[0m");
  merge(testEnv());
  merge(testValidation());
  merge(testTypes());
  merge(testTriageChatBasic());
  merge(await testTriageNoUnit());
  merge(testRetrieval());
  merge(testPhase2B());
  merge(testValidateGroundedResult());

  // ── Phase B: Integration tests (Supabase) ──
  console.log("\n\x1b[1m-- Phase B: Integration Tests (Supabase) --\x1b[0m");
  const { client, ...connResult } = await testSupabaseConnection();
  merge(connResult);
  merge(await testTableSchema(client));
  merge(await testEnums(client));
  merge(await testRLS(client));
  merge(await testRLSIsolation(client));
  merge(await testFKConstraints(client));
  merge(await testTriggers(client));
  merge(await testE2E(client));

  // ── Phase C: External service tests ──
  console.log("\n\x1b[1m-- Phase C: External Tests (Pinecone, OpenAI) --\x1b[0m");
  merge(await testPinecone());
  merge(await testOpenAI());

  // ── Summary ──
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log(`\n${"=".repeat(60)}`);
  console.log(" PHASE 1 TEST RESULTS");
  console.log(`${"=".repeat(60)}`);
  console.log(`  Passed:  ${totals.passed}`);
  console.log(`  Failed:  ${totals.failed}`);
  console.log(`  Skipped: ${totals.skipped}`);
  console.log(`  Total:   ${totals.passed + totals.failed + totals.skipped}`);
  console.log(`  Time:    ${elapsed}s`);
  console.log(`${"=".repeat(60)}`);

  if (totals.failed === 0 && totals.skipped === 0) {
    console.log("\nAll tests PASSED.\n");
  } else if (totals.failed === 0) {
    console.log(`\nPassed with ${totals.skipped} skipped test(s).\n`);
  } else {
    console.log(`\n${totals.failed} test(s) FAILED.\n`);
  }

  process.exit(totals.failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("\nFatal:", e);
  process.exit(1);
});
