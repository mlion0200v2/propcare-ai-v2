/**
 * Conversation eval: scripted multi-turn tenant chats, no network.
 *
 * Drives the assistant through `turn()` (tests/eval/drive.ts), exactly as
 * the chat route does, with a scripted tenant who answers each question
 * from a fact sheet. Stops when the questions are done (photos) or on an
 * emergency; retrieval and troubleshooting aren't reached.
 *
 * Run:  npx tsx tests/eval/conversation-eval.ts          (table + summary)
 *       npx tsx tests/eval/conversation-eval.ts --json   (machine-readable)
 * Also runs in CI as part of tests/run.ts.
 */
import type { GatheredInfo } from "../../src/assistant/triage/types";
import { createRunner, printSection, type TestResult } from "../integration/helpers";
import { SCENARIOS, type Scenario } from "./conversation-scenarios";
import { newChat, say, stubUnderstander } from "./drive";

/** Neutral answers by question id, for questions a scenario's facts don't cover. */
const DEFAULT_ANSWERS: Record<string, string> = {
  classify_category: "appliance",
  location_in_unit: "Kitchen",
  started_when: "yesterday",
  current_status: "Still happening",
  brand_model: "Unknown",
  safety_check: "no",
  "intake:onset": "Yesterday",
  "intake:status": "Still happening",
  "intake:amount": "A few drops",
  "intake:electrical_near": "No",
  "intake:brand_model": "Unknown",
};

export interface Turn {
  question: string | null;
  reply: string;
  options: string[];
  /** What the chat understood when it asked. */
  known?: { equipment: string; substance: string; room: string };
}

export interface Transcript {
  turns: Turn[];
  emergencyAtTurn: number | null;
  firstReply: string;
  gathered: GatheredInfo | null;
  category: string | null;
  equipment: string | null;
  asked: string[];
}

export async function runScenario(s: Scenario): Promise<Transcript> {
  const chat = newChat({ rooms: s.rooms ?? [], understander: s.model ? stubUnderstander(s.model) : null });
  let response = await say(chat, s.first);
  const t: Transcript = { turns: [], emergencyAtTurn: null, firstReply: response.reply, gathered: null, category: null, equipment: null, asked: [] };
  for (let turn = 1; turn <= 16; turn++) {
    const state = response.state;
    t.gathered = state.gathered ?? null;
    if (response.emergency) {
      t.emergencyAtTurn = turn;
      break;
    }
    if (response.phase !== "GATHER_INFO") break; // on to photos
    const question = state.current_question;
    const f = state.issue_frame;
    t.turns.push({ question, reply: response.reply, options: response.options, known: f ? { equipment: f.equipment, substance: f.substance, room: f.room } : undefined });
    if (!question) break;
    t.asked.push(question);
    response = await say(chat, s.facts?.[question] ?? DEFAULT_ANSWERS[question] ?? "not sure");
  }
  t.category = t.gathered?.category ?? null;
  t.equipment = t.gathered?.equipment ?? null;
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
  return g?.sop?.cause?.label ?? "";
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
  for (const w of e.neverSay ?? []) {
    const said = [t.firstReply, ...t.turns.flatMap((turn) => [turn.reply, ...turn.options])].filter((x) => new RegExp(`\\b${w}\\b`, "i").test(x));
    add(`never says "${w}"`, said.length === 0, said.slice(0, 2));
  }
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
