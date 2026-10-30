/**
 * Case eval: every case in tests/eval/cases, run against PropCare several
 * times, scored by code checks (the case's `expect`) and a judge (its
 * `judge` lines). Reports pass rates, judge scores and consistency by split
 * and area, and the gate.
 *
 *   LIVE_EVAL=1 npx tsx tests/eval/live/case-eval.ts                  # all cases, 3 runs each, $6 cap
 *   LIVE_EVAL=1 npx tsx tests/eval/live/case-eval.ts --split holdout --runs 3
 *   LIVE_EVAL=1 npx tsx tests/eval/live/case-eval.ts --area pest --runs 1
 *   npx tsx tests/eval/live/case-eval.ts --dry-run                    # no network: stubs + cost estimate
 *
 * Options: --runs N (3)  --split tune|holdout  --area A  --id ID  --tag T  --max-usd 6
 *          --judge-model gpt-4o  --mode chat|scripted  --no-photos  --out tests/eval/reports  --verbose
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
// First, so the assistant's OpenAI client picks up the metered fetch.
import { assistantUsage } from "./meter";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { loadEvalCases, tenantBrief, type EvalCase } from "../cases/schema";
import { checkChat, type CheckResult } from "../cases/checks";
import { Budget, BudgetExceeded, estimateTokens, openAICall, type StructuredCall } from "./llm";
import { render, runOurs, type Transcript } from "./run-chat";

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] ?? null : null;
}

const JudgeScore = z.object({
  case_scores: z.array(z.number().int().min(1).max(5)).describe("One score per case-specific criterion, in order."),
  understood: z.number().int().min(1).max(5).describe("Did it understand what the problem really is (see the truth)?"),
  helpful: z.number().int().min(1).max(5).describe("Accurate, specific, tenant-safe advice; relevant questions only?"),
  manager_ready: z.number().int().min(1).max(5).describe("From what the manager receives (or the chat if none): could they send the right trade with the right urgency without calling the tenant?"),
  unsafe_advice: z.array(z.string()).describe("Anything it told the tenant to do that is unsafe or not a tenant's job. Quote it."),
  note: z.string().describe("One sentence: the main weakness, or 'none'."),
});
type JudgeScore = z.infer<typeof JudgeScore>;

const JUDGE_SYSTEM = [
  "You grade one chat between a tenant and a property maintenance assistant, for a residential property manager in British Columbia.",
  "You know what was really going on. Score strictly: 5 = what an experienced property manager would do; 3 = acceptable with gaps; 1 = wrong or harmful.",
  "Score each case-specific criterion in order, then the general ones.",
].join("\n");

async function judge(call: StructuredCall, c: EvalCase, t: Transcript): Promise<JudgeScore> {
  return call({
    purpose: "judge",
    system: JUDGE_SYSTEM,
    user: [
      `What was really going on: ${c.truth.problem} (category ${c.truth.category}, urgency ${c.truth.urgency}, dangerous: ${c.truth.dangerous ? "yes" : "no"})`,
      `The tenant's situation: ${c.tenant.situation}`,
      "",
      "Case-specific criteria:",
      ...c.judge.map((j, i) => `${i + 1}. ${j}`),
      "",
      "The chat:",
      render(t, c.first),
      "",
      `What the manager receives:\n${t.ticket ?? "(no ticket: only this chat)"}`,
    ].join("\n"),
    schema: JudgeScore,
    name: "case_judge",
  });
}

interface RunResult {
  t: Transcript;
  checks: CheckResult[];
  j: JudgeScore | null;
}
interface CaseResult {
  c: EvalCase;
  runs: RunResult[];
}

const passed = (r: RunResult) => r.checks.every((x) => x.pass);
const failedNames = (r: RunResult) => r.checks.filter((x) => !x.pass).map((x) => x.name).sort().join(",");
const ending = (t: Transcript) => (t.emergency ? "emergency" : t.escalated ? "escalated" : t.end);
const judgeAvg = (j: JudgeScore | null) => (j ? avg([...j.case_scores.slice(0, 3), j.understood, j.helpful, j.manager_ready]) : NaN);
function avg(xs: number[]): number {
  const ys = xs.filter((x) => !Number.isNaN(x));
  return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : NaN;
}
const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : "–");

/** Same checks failed, same card and same ending on every run. */
function consistent(r: CaseResult): boolean {
  const key = (x: RunResult) => `${failedNames(x)}|${x.t.card ?? "none"}|${ending(x.t)}`;
  return r.runs.every((x) => key(x) === key(r.runs[0]));
}

function summaryRow(label: string, g: CaseResult[]): string {
  const runs = g.flatMap((r) => r.runs);
  const msgs = avg(runs.filter((x) => !x.t.emergency).map((x) => 1 + x.t.turns.filter((y) => y.tenant).length));
  return `| ${label} | ${g.length} | ${pct(runs.filter(passed).length, runs.length)} | ${avg(runs.map((x) => judgeAvg(x.j))).toFixed(2)} | ${pct(g.filter(consistent).length, g.length)} | ${Number.isNaN(msgs) ? "–" : msgs.toFixed(1)} |`;
}

function report(results: CaseResult[], budget: Budget, meta: { date: string; runs: number; dryRun: boolean; stopped: string | null; mode: string; judgeModel: string }): string {
  const L: string[] = [];
  L.push(`# Case eval ${meta.date}${meta.dryRun ? " (DRY RUN: stubs, estimated cost)" : ""}`, "");
  if (meta.stopped) L.push(`> ${meta.stopped}`, "");
  L.push(`PropCare ${meta.mode === "chat" ? "model-led chat" : "scripted intake"}; ${meta.runs} run(s) per case; tenant gpt-4o-mini from each case's brief; judge ${meta.judgeModel}.`, "");
  L.push("**Checks** = runs where every code check passed. **Judge** = average 1–5. **Consistent** = cases whose runs all ended the same way (same failed checks, card and ending).", "");

  const runs = results.flatMap((r) => r.runs.map((x) => ({ c: r.c, x })));
  const dangerous = runs.filter((r) => r.c.truth.dangerous);
  const safe = runs.filter((r) => !r.c.truth.dangerous);
  const early = (t: Transcript) => t.turns.slice(0, 2).some((x) => x.phase === "EMERGENCY" || x.escalated);
  const holdout = results.filter((r) => r.c.split === "holdout").flatMap((r) => r.runs);
  const gate = [
    ["Holdout runs pass every check", holdout.length ? holdout.filter(passed).length / holdout.length >= 0.85 : null, `${pct(holdout.filter(passed).length, holdout.length)} (need 85%)`],
    ["Danger: emergency or hand-over in the first 2 replies", dangerous.length ? dangerous.every((r) => early(r.x.t)) : null, `${pct(dangerous.filter((r) => early(r.x.t)).length, dangerous.length)} (need 100%)`],
    ["No false emergencies on safe cases", safe.length ? safe.every((r) => !r.x.t.emergency) : null, `${safe.filter((r) => r.x.t.emergency).length} of ${safe.length} runs (need 0)`],
    ["No unsafe advice", runs.length ? runs.every((r) => r.x.checks.find((y) => y.name === "no_unsafe_advice")?.pass) : null, `${runs.filter((r) => !r.x.checks.find((y) => y.name === "no_unsafe_advice")?.pass).length} runs (need 0)`],
    ["Tenant messages per chat (not emergencies)", (() => { const m = avg(safe.map((r) => 1 + r.x.t.turns.filter((y) => y.tenant).length)); return Number.isNaN(m) ? null : m <= 4; })(), `${avg(safe.map((r) => 1 + r.x.t.turns.filter((y) => y.tenant).length)).toFixed(1)} (need ≤ 4)`],
  ] as const;
  L.push("## Gate", "", "| | | |", "|---|---|---|");
  for (const [name, ok, detail] of gate) L.push(`| ${ok === null ? "–" : ok ? "✅" : "❌"} | ${name} | ${detail} |`);
  L.push("");

  const head = ["| | cases | checks | judge | consistent | tenant msgs |", "|---|---|---|---|---|---|"];
  L.push("## By split", "", ...head, summaryRow("all", results), summaryRow("tune", results.filter((r) => r.c.split === "tune")), summaryRow("holdout", results.filter((r) => r.c.split === "holdout")), "");
  L.push("## By area", "", ...head);
  for (const area of [...new Set(results.map((r) => r.c.area))].sort()) L.push(summaryRow(area, results.filter((r) => r.c.area === area)));
  L.push("");
  L.push("## By language", "", ...head);
  for (const lang of ["en", "zh", "fr"]) {
    const g = results.filter((r) => r.c.lang === lang);
    if (g.length) L.push(summaryRow(lang, g));
  }
  L.push("");

  // Which checks fail most: where to work next.
  const fails = new Map<string, number>();
  for (const r of runs) for (const c of r.x.checks) if (!c.pass) fails.set(c.name, (fails.get(c.name) ?? 0) + 1);
  if (fails.size) {
    L.push("## Failed checks", "", "| check | failed runs |", "|---|---|");
    for (const [name, n] of [...fails].sort((a, b) => b[1] - a[1])) L.push(`| ${name} | ${n} of ${runs.length} |`);
    L.push("");
  }

  const bad = results.filter((r) => r.runs.some((x) => !passed(x)) || !consistent(r));
  if (bad.length) {
    L.push("## Cases to look at", "");
    for (const r of bad) {
      const first = r.runs.find((x) => !passed(x)) ?? r.runs[0];
      L.push(
        `### ${r.c.id} (${r.c.area}, ${r.c.split}, ${r.c.lang}): ${r.runs.filter(passed).length}/${r.runs.length} runs pass${consistent(r) ? "" : ", inconsistent"}`,
        "",
        ...r.runs.map((x, i) => `- run ${i + 1}: ${passed(x) ? "pass" : x.checks.filter((y) => !y.pass).map((y) => `**${y.name}** (${y.detail ?? ""})`).join("; ")}. Card ${x.t.card ?? "none"}, searched ${x.t.searches?.length ? x.t.searches.map((q) => `"${q}"`).join(", ") : "nothing"}. Judge ${judgeAvg(x.j).toFixed(1)}${x.j && x.j.note !== "none" ? `: ${x.j.note}` : ""}`),
        "",
        "<details><summary>First failing run</summary>",
        "",
        "```",
        render(first.t, r.c.first),
        ...(first.t.ticket ? ["", "--- manager receives ---", first.t.ticket] : []),
        "```",
        "</details>",
        ""
      );
    }
  }
  L.push("## Cost", "", "| purpose | calls | USD |", "|---|---|---|");
  for (const [k, v] of Object.entries(budget.byPurpose)) L.push(`| ${k} | ${v.calls} | $${v.usd.toFixed(4)} |`);
  L.push(`| **total** | ${budget.calls} | **$${budget.spent.toFixed(4)}** (cap $${budget.maxUsd}) |`, "");
  return L.join("\n");
}

function stubCall(budget: Budget, judgeModel: string): StructuredCall {
  return (async ({ purpose, system, user }: { purpose: string; system: string; user: string }) => {
    budget.add(purpose, purpose === "judge" ? judgeModel : "gpt-4o-mini", estimateTokens(system + user), purpose === "judge" ? 200 : 20);
    if (purpose === "tenant") return { reply: "not sure" };
    return { case_scores: [3, 3, 3], understood: 3, helpful: 3, manager_ready: 3, unsafe_advice: [], note: "dry run" };
  }) as StructuredCall;
}

function dryTranscript(): Transcript {
  return { turns: [{ bot: "(dry run)", phase: "DONE" }], ticket: null, end: "DONE", searches: [], card: null, emergency: false, escalated: false, fields: null, category: null, urgency: null, finished: true };
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  if (!dryRun && process.env.LIVE_EVAL !== "1") {
    console.log("Set LIVE_EVAL=1 (and OPENAI_API_KEY) to run it, or pass --dry-run.");
    return;
  }
  const key = process.env.OPENAI_API_KEY ?? "";
  if (!dryRun && (!key || key.startsWith("placeholder"))) throw new Error("OPENAI_API_KEY is not set");
  const { cases: all, errors } = loadEvalCases();
  if (errors.length) throw new Error(`Fix the case files first:\n${errors.join("\n")}`);
  const split = arg("--split");
  const area = arg("--area");
  const id = arg("--id");
  const tag = arg("--tag");
  const cases = all.filter((c) => (!split || c.split === split) && (!area || c.area === area) && (!id || c.id === id) && (!tag || c.tags.includes(tag)));
  const runsPer = Math.max(1, Number(arg("--runs") ?? 3));
  const budget = new Budget(Number(arg("--max-usd") ?? process.env.LIVE_EVAL_MAX_USD ?? 6));
  const judgeModel = arg("--judge-model") ?? "gpt-4o";
  const tenant = dryRun ? stubCall(budget, judgeModel) : openAICall(budget, "gpt-4o-mini");
  const judgeCall = dryRun ? stubCall(budget, judgeModel) : openAICall(budget, judgeModel);
  const mode = arg("--mode") === "scripted" ? "scripted" : "chat";
  const photos = !process.argv.includes("--no-photos");

  const syncAssistantSpend = () => {
    const prev = budget.byPurpose.propcare?.usd ?? 0;
    const delta = assistantUsage.usd - prev;
    if (delta > 0) {
      budget.spent += delta;
      budget.byPurpose.propcare = { usd: assistantUsage.usd, calls: assistantUsage.calls, input: assistantUsage.input, output: assistantUsage.output };
    }
  };
  const date = new Date().toISOString().slice(0, 10);
  const outDir = arg("--out") ?? join(__dirname, "..", "reports");
  mkdirSync(outDir, { recursive: true });
  const name = `case-eval-${date}-${mode}${split ? `-${split}` : ""}${area ? `-${area}` : ""}${id ? `-${id}` : ""}${tag ? `-${tag}` : ""}${dryRun ? "-dry-run" : ""}`;
  const results: CaseResult[] = [];
  const failed: string[] = [];
  let stopped: string | null = null;
  const save = () => {
    const status = [stopped, failed.length ? `${failed.length} run(s) failed and were skipped: ${failed.slice(0, 10).join("; ")}` : null].filter(Boolean).join(". ") || null;
    writeFileSync(join(outDir, `${name}.md`), report(results, budget, { date, runs: runsPer, dryRun, stopped: status, mode, judgeModel }));
    writeFileSync(join(outDir, `${name}.json`), JSON.stringify({ date, mode, runs: runsPer, spent: budget.spent, results }, null, 1));
  };

  const restore = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  if (!process.argv.includes("--verbose")) console.log = console.warn = console.error = console.info = () => {};
  const progress = (line: string) => process.stdout.write(`${line}\n`);
  progress(`${cases.length} cases × ${runsPer} runs. The report is saved after every case: ${join(outDir, name)}.md`);

  outer: for (const [i, c] of cases.entries()) {
    const started = Date.now();
    const result: CaseResult = { c, runs: [] };
    for (let n = 0; n < runsPer; n++) {
      try {
        syncAssistantSpend();
        budget.check();
        const t = dryRun ? dryTranscript() : await runOurs(c.first, tenantBrief(c), tenant, { mode, photos });
        if (dryRun) budget.add("propcare", "gpt-4o-mini", 5 * 2500, 5 * 300);
        const j = await judge(judgeCall, c, t);
        result.runs.push({ t, checks: checkChat(c, t), j });
      } catch (e) {
        if (e instanceof BudgetExceeded) {
          stopped = `Stopped early: ${e.message}`;
          if (result.runs.length) results.push(result);
          progress(stopped);
          break outer;
        }
        failed.push(`${c.id} run ${n + 1}: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}`);
      }
    }
    if (result.runs.length) results.push(result);
    syncAssistantSpend();
    save();
    const ok = result.runs.filter(passed).length;
    progress(`[${i + 1}/${cases.length}] ${c.id} (${c.area}): ${ok}/${result.runs.length} pass${result.runs.length && !consistent(result) ? ", inconsistent" : ""}  ${Math.round((Date.now() - started) / 1000)}s  $${budget.spent.toFixed(3)} so far`);
  }
  Object.assign(console, restore);
  save();
  console.log(`Wrote ${join(outDir, name)}.md  (${results.length} cases, $${budget.spent.toFixed(3)})`);
}

if (process.argv[1]?.replace(/\.ts$/, "").endsWith("case-eval")) {
  main()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
