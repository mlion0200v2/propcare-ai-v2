/**
 * Conversation eval: scripted multi-turn tenant chats, no network.
 *
 * Drives the same functions as the chat route (src/lib/triage/conversation.ts)
 * with a scripted tenant who answers each question from a fact sheet. The
 * LLM fallback classifier is a stub; retrieval/grounding happen after the
 * questions and aren't reached here.
 *
 * Run:  npx tsx tests/eval/conversation-eval.ts          (table + summary)
 *       npx tsx tests/eval/conversation-eval.ts --json   (machine-readable)
 * Also runs in CI as part of tests/run.ts.
 */
import * as conversation from "../../src/lib/triage/conversation";
import { buildChatHints } from "../../src/lib/triage/hints";
import { readUnitProfile } from "../../src/lib/units/profile";
import type { GatheredInfo, TriageClassification } from "../../src/lib/triage/types";
import { createRunner, printSection, type TestResult } from "../integration/helpers";
import { SCENARIOS, type Scenario } from "./conversation-scenarios";

const DEFAULT_ANSWERS: Record<string, string> = {
  classify_category: "appliance",
  location_in_unit: "Kitchen",
  started_when: "yesterday",
  current_status: "Still happening",
  leak_where: "Not sure",
  leak_part: "Not sure",
  leak_timing: "Not sure",
  leak_amount: "A few drops",
  leak_electrical: "No",
  brand_model: "Unknown",
  safety_check: "no",
};

interface Turn {
  question: string | null;
  reply: string;
  options: string[];
}

interface Transcript {
  turns: Turn[];
  emergencyAtTurn: number | null;
  firstReply: string;
  gathered: GatheredInfo | null;
  category: string | null;
  equipment: string | null;
  asked: string[];
}

function chipsFor(question: string | null, gathered: GatheredInfo, description: string, rooms: string[]): string[] {
  if (!question) return [];
  // buildChatHints may take the gathered state (fixture-aware chips); extra keys are harmless.
  const hints = (buildChatHints as unknown as (p: Record<string, unknown>) => { quickReplies: string[] })({
    currentQuestion: question,
    triageState: "GATHER_INFO",
    category: gathered.category,
    description,
    profile: readUnitProfile({ rooms }),
    locationCandidates: gathered.location_candidates ?? null,
    gathered,
  });
  return hints.quickReplies;
}

export async function runScenario(s: Scenario): Promise<Transcript> {
  const rooms = s.rooms ?? [];
  const fallback = s.fallback ?? null;
  // openConversation may be sync or async, and may accept a fallback classifier.
  const open = await (conversation.openConversation as unknown as (m: string, c: Record<string, unknown>) => unknown)(s.first, {
    rooms,
    classifyFallback: async () => fallback,
  }) as conversation.Opening;

  const t: Transcript = {
    turns: [],
    emergencyAtTurn: null,
    firstReply: open.reply,
    gathered: open.triageClassification.gathered ?? null,
    category: open.triageClassification.gathered?.category ?? null,
    equipment: open.triageClassification.gathered?.equipment ?? null,
    asked: [],
  };
  if (open.emergency) {
    t.emergencyAtTurn = 1;
    return t;
  }

  const stored: TriageClassification = open.triageClassification;
  let question = stored.current_question ?? null;
  let reply = open.reply;
  for (let turn = 1; turn <= 16; turn++) {
    const gathered = stored.gathered!;
    t.turns.push({ question, reply, options: chipsFor(question, gathered, s.first, rooms) });
    if (!question) break;
    t.asked.push(question);

    const answer = s.facts?.[question] ?? DEFAULT_ANSWERS[question] ?? "not sure";
    const emergency = conversation.turnEmergency(answer, "GATHER_INFO", stored);
    if (emergency) {
      t.emergencyAtTurn = turn + 1;
      break;
    }
    const step = conversation.advanceGather({ stored, description: s.first, triageState: "GATHER_INFO", message: answer });
    stored.gathered = step.gathered;
    t.gathered = step.gathered;
    if (step.kind === "emergency") {
      t.emergencyAtTurn = turn + 1;
      break;
    }
    if (step.kind === "ask") {
      question = step.nextQuestion || null;
      reply = step.reply;
      stored.current_question = question;
      continue;
    }
    const next = conversation.afterGather(step.gathered, s.first, stored);
    if (next.kind === "emergency") {
      t.emergencyAtTurn = turn + 1;
      break;
    }
    if (next.kind === "safety_question") {
      question = "safety_check";
      reply = next.question;
      stored.current_question = question;
      continue;
    }
    break; // on to photos
  }
  t.category = t.gathered?.category ?? t.category;
  t.equipment = t.gathered?.equipment ?? t.equipment;
  return t;
}

interface ScenarioResult {
  id: string;
  name: string;
  passed: boolean;
  checks: { label: string; ok: boolean; detail?: unknown }[];
  asked: string[];
}

function likelySourceLabel(g: GatheredInfo | null): string {
  const src = (g as unknown as { leak_likely_source?: { label?: string } | string | null } | null)?.leak_likely_source;
  if (!src) return "";
  return typeof src === "string" ? src : src.label ?? "";
}

export async function evaluate(s: Scenario): Promise<ScenarioResult> {
  const t = await runScenario(s);
  const checks: ScenarioResult["checks"] = [];
  const add = (label: string, ok: boolean, detail?: unknown) => checks.push({ label, ok, detail });
  const e = s.expect;
  const lower = (x: string) => x.toLowerCase();

  if (e.emergencyAtTurn !== undefined) add(`emergency at turn ${e.emergencyAtTurn}`, t.emergencyAtTurn === e.emergencyAtTurn, t.emergencyAtTurn);
  if (e.emergency) add("escalated as an emergency", t.emergencyAtTurn !== null, t.asked);
  if (e.category) add(`category = ${e.category}`, t.category === e.category, t.category);
  if (e.equipment) add(`equipment = ${e.equipment}`, t.equipment === e.equipment, t.equipment);
  if (e.noCategoryQuestion) {
    add("no 'what type of issue' question", !t.asked.includes("classify_category") && !/what type of issue/i.test(t.firstReply), t.firstReply.slice(0, 120));
  }
  for (const q of e.neverAsk ?? []) add(`never asks ${q}`, !t.asked.includes(q), t.asked);
  for (const q of e.mustAsk ?? []) add(`asks ${q}`, t.asked.includes(q), t.asked);
  for (const [q, opts] of Object.entries(e.optionsInclude ?? {})) {
    const offered = t.turns.find((turn) => turn.question === q)?.options ?? [];
    for (const o of opts) add(`${q} offers "${o}"`, offered.some((x) => lower(x) === lower(o)), offered);
  }
  for (const [q, words] of Object.entries(e.optionsExclude ?? {})) {
    const offered = t.turns.find((turn) => turn.question === q)?.options ?? [];
    for (const w of words) add(`${q} has no "${w}" option`, offered.length > 0 && !offered.some((x) => lower(x).includes(lower(w))), offered);
  }
  if (e.likelySource) add(`likely source ~ "${e.likelySource}"`, lower(likelySourceLabel(t.gathered)).includes(lower(e.likelySource)), likelySourceLabel(t.gathered));
  for (const x of e.firstReplyExcludes ?? []) add(`first reply doesn't say "${x}"`, !lower(t.firstReply).includes(lower(x)), t.firstReply.slice(0, 160));

  return { id: s.id, name: s.name, passed: checks.every((c) => c.ok), checks, asked: t.asked };
}

export async function runConversationEval() {
  const results: ScenarioResult[] = [];
  for (const s of SCENARIOS) results.push(await evaluate(s));
  const checks = results.flatMap((r) => r.checks);
  return {
    results,
    scenarios: results.length,
    scenariosPassed: results.filter((r) => r.passed).length,
    checks: checks.length,
    checksPassed: checks.filter((c) => c.ok).length,
  };
}

/** CI entry (tests/run.ts): every scenario must pass. */
export async function testConversationEval(): Promise<TestResult> {
  printSection("Conversation eval (scripted multi-turn, no network)");
  const { pass, fail, result } = createRunner();
  const summary = await runConversationEval();
  for (const r of summary.results) {
    if (r.passed) pass(`${r.id}: ${r.name}`);
    else fail(`${r.id}: ${r.name}`, r.checks.filter((c) => !c.ok).map((c) => `${c.label} (got ${JSON.stringify(c.detail)})`).join("; "));
  }
  console.log(
    `\n  Conversation eval: ${summary.scenariosPassed}/${summary.scenarios} scenarios, ${summary.checksPassed}/${summary.checks} checks`
  );
  return result;
}

const isMain = process.argv[1]?.replace(/\.ts$/, "").endsWith("conversation-eval");
if (isMain) {
  runConversationEval().then((summary) => {
    if (process.argv.includes("--json")) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      for (const r of summary.results) {
        console.log(`${r.passed ? "PASS" : "FAIL"}  ${r.id.padEnd(30)} ${r.name}`);
        for (const c of r.checks.filter((x) => !x.ok)) console.log(`        ✗ ${c.label}  (got ${JSON.stringify(c.detail)})`);
      }
      console.log(`\nScenarios: ${summary.scenariosPassed}/${summary.scenarios}   Checks: ${summary.checksPassed}/${summary.checks}`);
    }
    process.exit(summary.scenariosPassed === summary.scenarios ? 0 : 1);
  });
}
