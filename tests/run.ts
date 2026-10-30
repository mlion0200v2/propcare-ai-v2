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
import { testConversationalTriage } from "./integration/test-conversational-triage";
import { testRetrieval } from "./integration/test-retrieval";
import { testPhase2B } from "./integration/test-phase2b";
import { testValidateGroundedResult } from "./integration/test-validate";
import { testGuidedTroubleshooting, testHybridInterpretation } from "./integration/test-guided-troubleshooting";
import { testPestTriage } from "./integration/test-pest-triage";
import { testPlumbingEdgeCases } from "./integration/test-plumbing-edge-cases";
import { testLaunchSafety } from "./integration/test-launch-safety";
import { testSafetyGate } from "./integration/test-safety-gate";
import { testCards } from "./integration/test-cards";
import { testChatFlow } from "./integration/test-chat-flow";
import { testEvalCases } from "./integration/test-eval-cases";
import { testWorkspaceRLS } from "./integration/test-workspace-rls";
import { testWorkspacePure } from "./integration/test-workspace-pure";
import { testDemoPure } from "./integration/test-demo-pure";
import { testDemoSandbox } from "./integration/test-demo-sandbox";
import { testUnitProfile } from "./integration/test-unit-profile";
import { testChatWorkflow } from "./integration/test-chat-workflow";
import { testConversationEval } from "./eval/conversation-eval";
import { testFrameEval } from "./eval/frame-eval";
import { testUnderstanding } from "./integration/test-understanding";
import { testSopCatalog } from "./integration/test-sop-catalog";
import { testLiveEval } from "./integration/test-live-eval";
import { testScope } from "./integration/test-scope";
import { testCoverage } from "./eval/coverage";
import { testDiagnosis } from "./integration/test-diagnosis";
import { testAssistantBoundary } from "./integration/test-assistant-boundary";

import { testSupabaseConnection, testTableSchema } from "./integration/test-supabase";

import { testPinecone } from "./integration/test-pinecone";
import { testOpenAI } from "./integration/test-openai";

async function main() {
  const startTime = Date.now();

  console.log("\n\x1b[1m Phase 1 Test Suite\x1b[0m");
  console.log("   PropCare-AI v2");
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
  merge(await testTriageChatBasic());
  merge(testConversationalTriage());
  merge(testRetrieval());
  merge(testPhase2B());
  merge(testValidateGroundedResult());
  merge(testGuidedTroubleshooting());
  merge(testPestTriage());
  merge(testPlumbingEdgeCases());
  merge(testLaunchSafety());
  merge(await testSafetyGate()); // safety gate: keywords + a stubbed model, any language
  merge(await testCards()); // reference cards: built from the catalog, found several at a time
  merge(await testChatFlow()); // model-led conversation with a stub model
  merge(await testEvalCases()); // the eval case files and their code checks
  merge(testWorkspacePure());
  merge(await testWorkspaceRLS()); // in-process Postgres (PGlite), no network
  merge(testDemoPure());
  merge(await testDemoSandbox()); // PGlite
  merge(await testUnitProfile()); // pure + PGlite
  merge(await testChatWorkflow());
  merge(await testConversationEval()); // scripted multi-turn chats, no network
  merge(await testUnderstanding()); // rules frame, model merge (stubbed), no network
  merge(await testSopCatalog()); // SOP catalog schema, references, tenant safety
  merge(await testScope()); // scope rule: questions fit what is known
  merge(await testFrameEval()); // labelled first messages: understanding + questions, no network
  merge(await testLiveEval()); // live-tier plumbing with stub models
  merge(await testCoverage()); // coverage matrix and diagnosis cards
  merge(await testDiagnosis()); // diagnosis view; tenant never sees parts or trades
  merge(testAssistantBoundary()); // src/assistant imports nothing from the app; no tenant data crosses

  // ── Phase B: Integration tests (Supabase) ──
  console.log("\n\x1b[1m-- Phase B: Integration Tests (Supabase) --\x1b[0m");
  const { client, ...connResult } = await testSupabaseConnection();
  merge(connResult);
  merge(await testTableSchema(client));
  // RLS, triggers and constraints: test-workspace-rls.ts (Phase A, PGlite).

  // ── Phase C: External service tests ──
  console.log("\n\x1b[1m-- Phase C: External Tests (Pinecone, OpenAI) --\x1b[0m");
  merge(await testPinecone());
  merge(await testOpenAI());
  merge(await testHybridInterpretation());

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
