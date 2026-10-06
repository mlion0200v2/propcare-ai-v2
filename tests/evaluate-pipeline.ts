/**
 * Pipeline evaluation: runs the REAL chain
 *   retrieval (Pinecone) -> generation (LLM) -> validation
 * on the same 28 cases as evaluate-20-issues.ts.
 *
 * Metrics per case: retrieval hit, citation precision, safety recall,
 * end-to-end latency, fallback rate.
 * First committed run becomes the baseline.
 */

import * as fs from "fs";
import { TEST_CASES, buildGathered, type TestCase } from "./evaluate-20-issues";
import {
  classifyIssue, classifyPest, classifyPlumbing, classifyMold,
  classifyStructural, classifyApplianceSymptom, classifyHvacSymptom,
  classifyLandscaping,
} from "../src/lib/triage/classify-issue";
import {
  extractEquipment, extractLocation, inferLocationFromEquipment,
} from "../src/lib/triage/extract-details";
import { detectSafety } from "../src/lib/triage/detect-safety";
import { querySnippets } from "../src/lib/retrieval/pinecone";
import { generateGroundedSteps } from "../src/lib/triage/grounding";
import { validateGroundedResult } from "../src/lib/triage/validate";
import type { GatheredInfo } from "../src/lib/triage/types";

interface CaseMetrics {
  id: number;
  description: string;
  retrieval_hit: boolean;
  snippet_count: number;
  highest_score: number;
  citation_precision: number;
  citation_count: number;
  safety_ok: boolean;
  validation_passed: boolean;
  validation_reasons: string[];
  used_fallback: boolean;
  used_web_search: boolean;
  latency_ms: number;
  passed: boolean;
  fail_reasons: string[];
}

// Deterministic front-end (same as the old harness): classification,
// extraction, safety. No network calls here.
function prepareGathered(tc: TestCase): { gathered: GatheredInfo; isEmergency: boolean } {
  const classification = classifyIssue(tc.description);
  const category = classification.category;
  let subcategory: string | null = null;
  if (category === "pest_control") subcategory = classifyPest(tc.description)?.species ?? null;
  else if (category === "plumbing") subcategory = classifyPlumbing(tc.description);
  else if (category === "structural") subcategory = classifyMold(tc.description) ?? classifyStructural(tc.description);
  else if (category === "appliance") subcategory = classifyApplianceSymptom(tc.description);
  else if (category === "hvac") subcategory = classifyHvacSymptom(tc.description);
  else if (category === "landscaping") subcategory = classifyLandscaping(tc.description);

  const equipment = extractEquipment(tc.description);
  const location = extractLocation(tc.description) ?? inferLocationFromEquipment(tc.description);
  const gathered = buildGathered(category, tc.description, subcategory, equipment, location);
  const safety = detectSafety(tc.description, gathered);
  const isEmergency = safety.detected || (tc.expectedEmergency ?? false);
  gathered.is_emergency = isEmergency;
  return { gathered, isEmergency };
}

async function evaluatePipelineCase(tc: TestCase): Promise<CaseMetrics> {
  const fail_reasons: string[] = [];
  const t0 = Date.now();
  const { gathered, isEmergency } = prepareGathered(tc);
  const traceId = `eval-${tc.id}-${Date.now()}`;

  try {
    // 1. Retrieval — real Pinecone
    const { snippets, log } = await querySnippets(gathered, tc.description, traceId);

    // 2. Generation — real LLM (structured outputs after P0-1)
    const grounded = await generateGroundedSteps(gathered, snippets, isEmergency, log.low_confidence);

    // 3. Validation — the production gate
    const validation = validateGroundedResult(
      grounded, snippets, gathered, log.highest_score, log.average_score
    );
    const latency_ms = Date.now() - t0;

    // Metric 1: retrieval hit
    const retrieval_hit = snippets.length > 0 && !log.low_confidence;
    if (!retrieval_hit && !grounded.usedFallback) {
      fail_reasons.push("retrieval: no usable snippets and no fallback engaged");
    }

    // Metric 2: citation precision — every [SOP-N] must point at a real snippet
    const cited = new Set<number>();
    const text = grounded.steps.map((s) => s.description).join("\n") + "\n" + grounded.reply;
    for (const m of text.matchAll(/\[SOP-(\d+)\]/g)) cited.add(parseInt(m[1], 10));
    const invalid = [...cited].filter((n) => n < 1 || n > snippets.length);
    const citation_precision = cited.size === 0 ? 1 : (cited.size - invalid.length) / cited.size;
    if (invalid.length > 0) fail_reasons.push(`citations: invalid refs [${invalid.join(",")}]`);
    if (validation.missing_citations) fail_reasons.push("validation: missing_citations");

    // Metric 3: safety recall on emergency cases
    const safety_ok = !isEmergency || !validation.missing_safety_guidance;
    if (!safety_ok) fail_reasons.push("safety: emergency without safety guidance");

    // Metric 4: validation gate
    if (!validation.is_valid && !grounded.usedFallback) {
      fail_reasons.push(`validation: ${validation.reasons.join(",")}`);
    }

    return {
      id: tc.id, description: tc.description,
      retrieval_hit, snippet_count: snippets.length, highest_score: log.highest_score,
      citation_precision, citation_count: cited.size,
      safety_ok, validation_passed: validation.is_valid,
      validation_reasons: validation.reasons,
      used_fallback: grounded.usedFallback,
      used_web_search: grounded.usedWebSearch ?? false,
      latency_ms, passed: fail_reasons.length === 0, fail_reasons,
    };
  } catch (err) {
    return {
      id: tc.id, description: tc.description,
      retrieval_hit: false, snippet_count: 0, highest_score: 0,
      citation_precision: 0, citation_count: 0,
      safety_ok: true, validation_passed: false, validation_reasons: [],
      used_fallback: false, used_web_search: false,
      latency_ms: Date.now() - t0, passed: false,
      fail_reasons: [`exception: ${err instanceof Error ? err.message : String(err)}`],
    };
  }
}

async function main() {
  const results: CaseMetrics[] = [];
  for (const tc of TEST_CASES) {
    console.log(`Evaluating #${tc.id}: "${tc.description.slice(0, 60)}..."`);
    results.push(await evaluatePipelineCase(tc));
    const r = results[results.length - 1];
    console.log(`  ${r.passed ? "PASS" : "FAIL"} | retrieval:${r.retrieval_hit} snippets:${r.snippet_count} ` +
      `cite_prec:${r.citation_precision.toFixed(2)} safety:${r.safety_ok} ` +
      `fallback:${r.used_fallback} latency:${r.latency_ms}ms` +
      (r.passed ? "" : ` -> ${r.fail_reasons.join("; ")}`));
  }

  const n = results.length;
  const emergencyCases = results.filter((r) => {
    const tc = TEST_CASES.find((t) => t.id === r.id);
    return tc?.expectedEmergency;
  });
  const summary = {
    total: n,
    passed: results.filter((r) => r.passed).length,
    retrieval_hit_rate: results.filter((r) => r.retrieval_hit).length / n,
    avg_citation_precision: results.reduce((a, r) => a + r.citation_precision, 0) / n,
    safety_recall: emergencyCases.length === 0 ? 1
      : emergencyCases.filter((r) => r.safety_ok).length / emergencyCases.length,
    fallback_rate: results.filter((r) => r.used_fallback || r.used_web_search).length / n,
    avg_latency_ms: Math.round(results.reduce((a, r) => a + r.latency_ms, 0) / n),
    p95_latency_ms: [...results.map((r) => r.latency_ms)].sort((a, b) => a - b)[
      Math.min(n - 1, Math.floor(n * 0.95))
    ],
  };

  console.log("\n=== SUMMARY ===");
  console.log(JSON.stringify(summary, null, 2));

  const stamp = new Date().toISOString().slice(0, 10);
  fs.mkdirSync("tests/eval-reports", { recursive: true });
  fs.writeFileSync(
    `tests/eval-reports/pipeline-${stamp}.json`,
    JSON.stringify({ generated_at: new Date().toISOString(), summary, results }, null, 2)
  );
  const md = [
    `# Pipeline Eval Report (${stamp})`,
    ``,
    `- Passed: ${summary.passed}/${summary.total}`,
    `- Retrieval hit rate: ${(summary.retrieval_hit_rate * 100).toFixed(1)}%`,
    `- Avg citation precision: ${(summary.avg_citation_precision * 100).toFixed(1)}%`,
    `- Safety recall (emergency): ${(summary.safety_recall * 100).toFixed(1)}%`,
    `- Fallback rate: ${(summary.fallback_rate * 100).toFixed(1)}%`,
    `- Avg latency: ${summary.avg_latency_ms}ms (p95: ${summary.p95_latency_ms}ms)`,
    ``,
    `## Failures`,
    ...results.filter((r) => !r.passed).map(
      (r) => `- #${r.id} "${r.description.slice(0, 50)}...": ${r.fail_reasons.join("; ")}`
    ),
  ].join("\n");
  fs.writeFileSync(`tests/eval-reports/pipeline-${stamp}.md`, md);
  console.log(`\nReport written to tests/eval-reports/pipeline-${stamp}.json/.md`);
}

main();
