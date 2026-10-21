/**
 * Live eval tier: real model calls, behind LIVE_EVAL=1 and a dollar cap.
 *
 *   LIVE_EVAL=1 npx tsx tests/eval/live/run-live.ts                    # frames for every message + 40 conversations
 *   LIVE_EVAL=1 npx tsx tests/eval/live/run-live.ts --sample all       # every message as a conversation
 *   npx tsx tests/eval/live/run-live.ts --dry-run                      # no network: stubs + cost estimate
 *
 * Options: --sample N|all  --max-usd 2 (or LIVE_EVAL_MAX_USD)  --out tests/eval/reports
 * Needs OPENAI_API_KEY (from .env.local or the environment). Writes
 * reports/live-YYYY-MM-DD.md (+ .json): baseline vs after table, model
 * frame accuracy, judge scores, worst transcripts, and what it cost.
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { understand, openAIUnderstander, type ModelUnderstander } from "../../../src/lib/understanding";
import { UNDERSTANDING_SYSTEM_PROMPT } from "../../../src/lib/understanding/model";
import { selectSop } from "../../../src/lib/sops/select";
import { HELDOUT_FILES, TUNED_FILES, loadCorpus, runFrameEval, type CorpusCase, type FrameEvalReport } from "../frame-eval";
import { Budget, BudgetExceeded, estimateTokens, openAICall, type StructuredCall } from "./llm";
import { JUDGE_SYSTEM, TENANT_SYSTEM, judge, simulateConversation, type LiveTranscript, type Verdict } from "./simulate";

const FIELDS = ["equipment", "symptom", "substance", "room"] as const;

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] ?? null : null;
}

/** Deterministic shuffle (same sample every run unless the corpus changes). */
function seededSample<T>(items: T[], n: number, seed = 42): T[] {
  const a = [...items];
  let s = seed;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) % 2 ** 31;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}

/** Dry run: canned answers, and token estimates so the report shows what a real run would cost. */
function stubCall(budget: Budget): StructuredCall {
  return (async ({ purpose, system, user }: { purpose: string; system: string; user: string }) => {
    const out = purpose === "judge" ? 150 : 15;
    budget.add(purpose, "gpt-4o-mini", estimateTokens(system + user), out);
    if (purpose === "tenant") {
      const options = /Tap options: (.*)\n/.exec(user)?.[1]?.split(" | ").filter((o) => o && o !== "(none)" && !/not sure/i.test(o)) ?? [];
      return { reply: options[0] ?? "not sure" };
    }
    return { understood: 4, relevance: 4, irrelevant_questions: [], reasked_questions: [], safety_ok: true, efficiency: 4, overall: 4, notes: "dry run" };
  }) as StructuredCall;
}

function stubUnderstander(budget: Budget): ModelUnderstander {
  return async (message) => {
    budget.add("understanding", "gpt-4o-mini", estimateTokens(UNDERSTANDING_SYSTEM_PROMPT) + 535 + estimateTokens(message), 180);
    return null; // rules frame stands in
  };
}

interface FrameScore {
  cases: number;
  accuracy: Record<string, number>;
  sop: number;
  emergencyRecall: number;
  emergencyPrecision: number;
}

async function modelFrames(cases: CorpusCase[], understander: ModelUnderstander, budget: Budget): Promise<FrameScore> {
  const ok: Record<string, number> = Object.fromEntries(FIELDS.map((f) => [f, 0]));
  let sopOk = 0, sopN = 0, tp = 0, fn = 0, fp = 0;
  for (const c of cases) {
    budget.check();
    const { frame } = await understand(c.message, understander);
    for (const f of FIELDS) if (frame[f] === c.expected[f]) ok[f]++;
    if (c.sop && !c.emergency) {
      sopN++;
      if (selectSop(frame, c.message)?.sop.issue_key === c.sop) sopOk++;
    }
    const em = frame.severity === "emergency";
    if (c.emergency && em) tp++;
    else if (c.emergency) fn++;
    else if (em) fp++;
  }
  const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 1000 : 1);
  return {
    cases: cases.length,
    accuracy: Object.fromEntries(FIELDS.map((f) => [f, pct(ok[f], cases.length)])),
    sop: pct(sopOk, sopN),
    emergencyRecall: pct(tp, tp + fn),
    emergencyPrecision: pct(tp, tp + fp),
  };
}

const p = (x: number | undefined) => (x === undefined ? "–" : `${(x * 100).toFixed(1)}%`);

function renderReport(r: {
  date: string;
  dryRun: boolean;
  baselines: { main: { tuned: FrameEvalReport; heldout: FrameEvalReport }; pr11: { tuned: FrameEvalReport; heldout: FrameEvalReport } };
  rules: { tuned: FrameEvalReport; heldout: FrameEvalReport };
  model: { tuned: FrameScore; heldout: FrameScore } | null;
  conversations: { transcript: LiveTranscript; verdict: Verdict; case: CorpusCase }[];
  budget: Budget;
  stoppedEarly: string | null;
}): string {
  const lines: string[] = [];
  const conv = r.conversations;
  const avg = (k: keyof Verdict) => (conv.length ? conv.reduce((n, c) => n + (c.verdict[k] as number), 0) / conv.length : 0);
  const rate = (f: (c: (typeof conv)[number]) => boolean) => (conv.length ? conv.filter(f).length / conv.length : 0);
  const perConv = conv.length ? (r.budget.byPurpose.tenant?.usd ?? 0) / conv.length + (r.budget.byPurpose.judge?.usd ?? 0) / conv.length : 0;
  const und = r.budget.byPurpose.understanding;
  const perUnderstanding = und ? und.usd / und.calls : 0;
  const turns = conv.length ? conv.reduce((n, c) => n + c.transcript.turns.filter((t) => t.tenant).length, 0) / conv.length : 0;

  lines.push(`# Live eval ${r.date}${r.dryRun ? " (DRY RUN: stubs, estimated cost)" : ""}`, "");
  if (r.stoppedEarly) lines.push(`> Stopped early: ${r.stoppedEarly}`, "");
  lines.push("## Baseline vs after", "");
  lines.push("| metric | main (rules) | #11 (rules) | after (rules only) | after (model + rules) |", "|---|---|---|---|---|");
  const t = (x: { tuned: FrameEvalReport }) => x.tuned;
  const m = r.model;
  lines.push(`| Category accuracy | ${p(t(r.baselines.main).categoryAccuracy)} | ${p(t(r.baselines.pr11).categoryAccuracy)} | ${p(r.rules.tuned.categoryAccuracy)} | – |`);
  for (const f of FIELDS) lines.push(`| Frame: ${f} (corpus / held out) | n/a | n/a | ${p(r.rules.tuned.frameAccuracy?.[f])} / ${p(r.rules.heldout.frameAccuracy?.[f])} | ${p(m?.tuned.accuracy[f])} / ${p(m?.heldout.accuracy[f])} |`);
  lines.push(`| SOP selection (corpus / held out) | n/a | n/a | ${p(r.rules.tuned.sopAccuracy?.fromRules)} / ${p(r.rules.heldout.sopAccuracy?.fromRules)} | ${p(m?.tuned.sop)} / ${p(m?.heldout.sop)} |`);
  lines.push(`| Emergency recall | ${p(t(r.baselines.main).emergency.recall)} | ${p(t(r.baselines.pr11).emergency.recall)} | ${p(r.rules.tuned.emergency.recall)} | ${p(m?.tuned.emergencyRecall)} |`);
  lines.push(`| Emergency precision | ${p(t(r.baselines.main).emergency.precision)} | ${p(t(r.baselines.pr11).emergency.precision)} | ${p(r.rules.tuned.emergency.precision)} | ${p(m?.tuned.emergencyPrecision)} |`);
  lines.push(`| Re-ask rate (scripted) | ${p(t(r.baselines.main).reaskRate)} | ${p(t(r.baselines.pr11).reaskRate)} | ${p(r.rules.tuned.reaskRate)} | – |`);
  lines.push(`| Irrelevant-question rate (scripted) | ${p(t(r.baselines.main).irrelevantRate)} | ${p(t(r.baselines.pr11).irrelevantRate)} | ${p(r.rules.tuned.irrelevantRate)} | – |`);
  lines.push("", "Rules columns: the deterministic tier on the 365-message corpus (the rules were tuned on it; held-out shown where it matters). Model column: this run.", "");

  lines.push(`## Simulated conversations (${conv.length}; the model plays the tenant, a judge scores)`, "");
  if (conv.length) {
    lines.push("| judge metric | value |", "|---|---|");
    lines.push(`| Understood (1–5) | ${avg("understood").toFixed(2)} |`, `| Relevance (1–5) | ${avg("relevance").toFixed(2)} |`, `| Efficiency (1–5) | ${avg("efficiency").toFixed(2)} |`, `| Overall (1–5) | ${avg("overall").toFixed(2)} |`);
    lines.push(`| Chats with an irrelevant question | ${p(rate((c) => c.verdict.irrelevant_questions.length > 0))} |`, `| Chats with a re-asked question | ${p(rate((c) => c.verdict.reasked_questions.length > 0))} |`, `| Safety handled correctly | ${p(rate((c) => c.verdict.safety_ok))} |`, `| Tenant replies per chat | ${turns.toFixed(1)} |`, "");
    const worst = [...conv].sort((a, b) => a.verdict.overall - b.verdict.overall).slice(0, 8).filter((c) => c.verdict.overall <= 3);
    if (worst.length) {
      lines.push("### Lowest-scored chats", "");
      for (const w of worst) {
        lines.push(`**${w.case.id}** (overall ${w.verdict.overall}; SOP ${w.transcript.sop ?? "none"}): ${w.verdict.notes}`, "");
        lines.push("```", `Tenant: ${w.transcript.first}`, ...w.transcript.turns.flatMap((x) => [`Bot: ${x.bot.replace(/\n+/g, " / ")}`, ...(x.tenant ? [`Tenant: ${x.tenant}`] : [])]), "```", "");
        lines.push(`Add it as a regression: \`npx tsx tests/eval/add-regression.ts "${w.transcript.first.replace(/"/g, '\\"')}"\``, "");
      }
    }
  }

  lines.push("## Cost", "", "| purpose | calls | input tokens | output tokens | USD |", "|---|---|---|---|---|");
  for (const [k, v] of Object.entries(r.budget.byPurpose)) lines.push(`| ${k} | ${v.calls} | ${v.input} | ${v.output} | $${v.usd.toFixed(4)} |`);
  lines.push(`| **total** | ${r.budget.calls} | | | **$${r.budget.spent.toFixed(4)}** (cap $${r.budget.maxUsd}) |`, "");
  lines.push(`- One understanding call: $${perUnderstanding.toFixed(5)}. In production a conversation makes one per tenant message (first + ~${turns.toFixed(1)} replies): about **$${(perUnderstanding * (1 + turns)).toFixed(4)} per conversation** for understanding.`);
  lines.push(`- Eval only: simulated tenant + judge add $${perConv.toFixed(4)} per conversation.`);
  return lines.join("\n") + "\n";
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  if (!dryRun && process.env.LIVE_EVAL !== "1") {
    console.log("Live eval is off. Set LIVE_EVAL=1 (and OPENAI_API_KEY) to run it, or pass --dry-run for a no-network rehearsal.");
    return;
  }
  const key = process.env.OPENAI_API_KEY ?? "";
  if (!dryRun && (!key || key.startsWith("placeholder"))) throw new Error("OPENAI_API_KEY is not set");
  const budget = new Budget(Number(arg("--max-usd") ?? process.env.LIVE_EVAL_MAX_USD ?? 2));
  const call = dryRun ? stubCall(budget) : openAICall(budget);
  const understander = dryRun
    ? stubUnderstander(budget)
    : openAIUnderstander({ noCache: true, onUsage: (u) => budget.add("understanding", u.model, u.prompt_tokens, u.completion_tokens) })!;

  const tuned = loadCorpus(TUNED_FILES);
  const heldout = loadCorpus(HELDOUT_FILES);
  const baselines = JSON.parse(readFileSync(join(__dirname, "..", "reports", "baselines.json"), "utf8"));
  const rules = { tuned: await runFrameEval(tuned), heldout: await runFrameEval(heldout) };

  let stoppedEarly: string | null = null;
  let model: { tuned: FrameScore; heldout: FrameScore } | null = null;
  const conversations: { transcript: LiveTranscript; verdict: Verdict; case: CorpusCase }[] = [];
  try {
    model = { tuned: await modelFrames(tuned, understander, budget), heldout: await modelFrames(heldout, understander, budget) };
    const sampleArg = arg("--sample") ?? "40";
    const fixed = tuned.filter((c) => c.source === "transcript" || c.source === "regression");
    const rest = [...tuned, ...heldout].filter((c) => !fixed.includes(c));
    const sample = [...fixed, ...(sampleArg === "all" ? rest : seededSample(rest, Number(sampleArg)))];
    for (const c of sample) {
      budget.check();
      const transcript = await simulateConversation(c, call, understander);
      const verdict = await judge(transcript, c, call);
      conversations.push({ transcript, verdict, case: c });
      process.stdout.write(".");
    }
  } catch (e) {
    if (!(e instanceof BudgetExceeded)) throw e;
    stoppedEarly = e.message;
  }

  const date = new Date().toISOString().slice(0, 10);
  const outDir = arg("--out") ?? join(__dirname, "..", "reports");
  mkdirSync(outDir, { recursive: true });
  const name = `live-${date}${dryRun ? "-dry-run" : ""}`;
  const report = renderReport({ date, dryRun, baselines, rules, model, conversations, budget, stoppedEarly });
  writeFileSync(join(outDir, `${name}.md`), report);
  writeFileSync(join(outDir, `${name}.json`), JSON.stringify({ date, dryRun, model, budget: { spent: budget.spent, byPurpose: budget.byPurpose }, conversations }, null, 1));
  console.log(`\n${report}\nWrote ${join(outDir, name)}.md`);
}

export { renderReport, stubCall, stubUnderstander, modelFrames, TENANT_SYSTEM, JUDGE_SYSTEM };

if (process.argv[1]?.replace(/\.ts$/, "").endsWith("run-live")) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
