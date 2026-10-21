/**
 * Understanding eval over the labelled first-message corpus. No network.
 *
 * For each message in tests/eval/corpus/first-messages.jsonl:
 *  - frame accuracy per field (rules frame; the model frame in the live tier),
 *  - category accuracy and emergency recall/precision of the opening,
 *  - a scripted conversation with neutral answers, scored for questions
 *    the tenant shouldn't get: re-asks (room/category already said) and
 *    irrelevant ones (water questions when it isn't water).
 *
 * Works on older commits too (the frame metrics are skipped when the
 * understanding layer doesn't exist), so the same file measures a baseline:
 *   npx tsx tests/eval/frame-eval.ts            (summary)
 *   npx tsx tests/eval/frame-eval.ts --json     (machine-readable)
 *   npx tsx tests/eval/frame-eval.ts --failures (list misses)
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runScenario } from "./conversation-eval";
import type { Scenario } from "./conversation-scenarios";
import { createRunner, printSection, type TestResult } from "../integration/helpers";

export interface CorpusCase {
  id: string;
  message: string;
  lang: "en" | "zh" | "fr";
  style: string;
  expected: { equipment: string; symptom: string; substance: string; room: string };
  emergency: boolean;
  sop: string | null;
  /** heldout: written after the rules were tuned; never tune the rules against these. */
  source: "transcript" | "authored" | "regression" | "heldout";
  /** Question topics this case must never get (added to the derived ones). */
  forbid?: string[];
}

export const TUNED_FILES = ["first-messages.jsonl", "regressions.jsonl"];
export const HELDOUT_FILES = ["heldout.jsonl"];

export function loadCorpus(files = TUNED_FILES, dir = join(__dirname, "corpus")): CorpusCase[] {
  const cases: CorpusCase[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(join(dir, file), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) if (line.trim()) cases.push(JSON.parse(line));
  }
  return cases;
}

// Equipment → category (kept here so the eval runs on commits without the taxonomy).
const CATEGORY: Record<string, string> = {
  range_hood: "appliance", stove_oven: "appliance", microwave: "appliance", fridge: "appliance",
  dishwasher: "appliance", garbage_disposal: "appliance", washer: "appliance", dryer: "appliance",
  water_heater: "plumbing", kitchen_sink: "plumbing", bathroom_sink: "plumbing", sink: "plumbing",
  faucet: "plumbing", toilet: "plumbing", tub_shower: "plumbing", pipe: "plumbing", drain: "plumbing",
  outlet: "electrical", light: "electrical", switch: "electrical", breaker: "electrical",
  smoke_alarm: "electrical", co_alarm: "electrical",
  furnace: "hvac", baseboard_heater: "hvac", thermostat: "hvac", ac: "hvac", bathroom_fan: "hvac",
  lock: "locksmith", roof: "roofing", window: "structural", door: "structural",
  ceiling: "*", wall: "*", floor: "*", intercom: "*",
};

function expectedCategory(c: CorpusCase): string | null {
  if (c.expected.symptom === "pests") return "pest_control";
  const cat = CATEGORY[c.expected.equipment];
  return cat && cat !== "*" ? cat : null;
}

/** Legacy question ids → topics. */
export const QUESTION_TOPIC: Record<string, string> = {
  classify_category: "category",
  location_in_unit: "room",
  started_when: "onset",
  current_status: "status",
  leak_where: "water_location",
  leak_part: "fixture_part",
  leak_timing: "water_timing",
  leak_amount: "water_amount",
  leak_electrical: "electrical_near",
  brand_model: "brand_model",
  safety_check: "safety",
};

const WATER_TOPICS = ["water_location", "water_amount", "water_timing", "electrical_near"];

/** Topics this case must not be asked: what was already said, and what doesn't apply. */
export function forbiddenTopics(c: CorpusCase): { reask: string[]; irrelevant: string[] } {
  const reask: string[] = [];
  const irrelevant: string[] = [...(c.forbid ?? [])];
  if (expectedCategory(c)) reask.push("category");
  if (c.expected.room !== "unknown") reask.push("room");
  if (!["water", "unknown"].includes(c.expected.substance)) irrelevant.push(...WATER_TOPICS);
  return { reask, irrelevant };
}

const KITCHEN_ROOMS = ["Kitchen", "Main bathroom (hallway)", "Laundry closet", "Bedroom", "Living room"];

interface CaseResult {
  id: string;
  message: string;
  lang: string;
  frame?: Record<string, { expected: string; got: string; ok: boolean }>;
  category: { expected: string | null; got: string | null; ok: boolean | null };
  emergency: { expected: boolean; got: boolean };
  asked: string[];
  reasked: string[];
  irrelevant: string[];
  /** SOP chosen from the rules frame, and from the expected (gold) frame. */
  sop?: { expected: string | null; got: string | null; gotFromGold: string | null };
}

export interface FrameEvalReport {
  cases: number;
  byLang: Record<string, number>;
  frameAccuracy: Record<string, number> | null;
  frameAccuracyByLang: Record<string, Record<string, number>> | null;
  categoryAccuracy: number;
  emergency: { recall: number; precision: number; tp: number; fn: number; fp: number };
  reaskRate: number;
  irrelevantRate: number;
  forbiddenRate: number;
  avgQuestions: number;
  /** Among cases with an expected SOP that aren't emergencies. */
  sopAccuracy: { fromRules: number; fromGoldFrame: number; cases: number } | null;
  results: CaseResult[];
}

type RulesFrame = (m: string) => Record<string, unknown> & { severity: string };

async function loadRulesFrame(): Promise<RulesFrame | null> {
  try {
    const mod = await import("../../src/lib/understanding/rules");
    return mod.rulesFrame as unknown as RulesFrame;
  } catch {
    return null; // baseline commit: no understanding layer
  }
}

type SelectSop = (frame: Record<string, unknown>, message: string) => { sop: { issue_key: string } } | null;

async function loadSelectSop(): Promise<SelectSop | null> {
  try {
    const mod = await import("../../src/lib/sops/select");
    return mod.selectSop as unknown as SelectSop;
  } catch {
    return null; // before the SOP catalog
  }
}

/** The labelled frame as a full IssueFrame (confident, medium severity unless an emergency). */
function goldFrame(c: CorpusCase, rules: Record<string, unknown>): Record<string, unknown> {
  return { ...rules, ...c.expected, severity: c.emergency ? "emergency" : "medium" };
}

const FIELDS = ["equipment", "symptom", "substance", "room"] as const;

function pct(n: number, d: number): number {
  return d === 0 ? 1 : Math.round((n / d) * 1000) / 1000;
}

export async function runFrameEval(cases = loadCorpus()): Promise<FrameEvalReport> {
  const rulesFrame = await loadRulesFrame();
  const selectSop = await loadSelectSop();
  const results: CaseResult[] = [];
  for (const c of cases) {
    const scenario: Scenario = { id: c.id, name: c.message, first: c.message, rooms: KITCHEN_ROOMS, fallback: null, expect: {} };
    const t = await runScenario(scenario);
    const asked = t.asked.map((q) => QUESTION_TOPIC[q] ?? q);
    const { reask, irrelevant } = forbiddenTopics(c);
    const r: CaseResult = {
      id: c.id,
      message: c.message,
      lang: c.lang,
      category: { expected: expectedCategory(c), got: t.category, ok: expectedCategory(c) ? t.category === expectedCategory(c) : null },
      emergency: { expected: c.emergency, got: t.emergencyAtTurn === 1 },
      asked,
      reasked: asked.filter((a) => reask.includes(a)),
      irrelevant: asked.filter((a) => irrelevant.includes(a)),
    };
    if (rulesFrame) {
      const f = rulesFrame(c.message);
      r.frame = Object.fromEntries(
        FIELDS.map((k) => [k, { expected: c.expected[k], got: String(f[k]), ok: String(f[k]) === c.expected[k] }])
      );
      if (selectSop) {
        r.sop = {
          expected: c.sop,
          got: selectSop(f, c.message)?.sop.issue_key ?? null,
          gotFromGold: selectSop(goldFrame(c, f), c.message)?.sop.issue_key ?? null,
        };
      }
    }
    results.push(r);
  }

  const byLang: Record<string, number> = {};
  for (const c of cases) byLang[c.lang] = (byLang[c.lang] ?? 0) + 1;
  const accuracy = (rs: CaseResult[]) =>
    Object.fromEntries(FIELDS.map((k) => [k, pct(rs.filter((r) => r.frame![k].ok).length, rs.length)]));
  const frameAccuracy = rulesFrame ? accuracy(results) : null;
  const frameAccuracyByLang = rulesFrame
    ? Object.fromEntries(Object.keys(byLang).map((l) => [l, accuracy(results.filter((r) => r.lang === l))]))
    : null;
  const withCat = results.filter((r) => r.category.ok !== null);
  const tp = results.filter((r) => r.emergency.expected && r.emergency.got).length;
  const fn = results.filter((r) => r.emergency.expected && !r.emergency.got).length;
  const fp = results.filter((r) => !r.emergency.expected && r.emergency.got).length;
  const nonEmergency = results.filter((r) => !r.emergency.got);
  const sopCases = results.filter((r) => r.sop && r.sop.expected && !r.emergency.expected);
  return {
    cases: cases.length,
    byLang,
    frameAccuracy,
    frameAccuracyByLang,
    categoryAccuracy: pct(withCat.filter((r) => r.category.ok).length, withCat.length),
    emergency: { recall: pct(tp, tp + fn), precision: pct(tp, tp + fp), tp, fn, fp },
    reaskRate: pct(nonEmergency.filter((r) => r.reasked.length > 0).length, nonEmergency.length),
    irrelevantRate: pct(nonEmergency.filter((r) => r.irrelevant.length > 0).length, nonEmergency.length),
    forbiddenRate: pct(nonEmergency.filter((r) => r.reasked.length + r.irrelevant.length > 0).length, nonEmergency.length),
    avgQuestions: Math.round((nonEmergency.reduce((n, r) => n + r.asked.length, 0) / Math.max(1, nonEmergency.length)) * 10) / 10,
    sopAccuracy: selectSop
      ? {
          fromRules: pct(sopCases.filter((r) => r.sop!.got === r.sop!.expected).length, sopCases.length),
          fromGoldFrame: pct(sopCases.filter((r) => r.sop!.gotFromGold === r.sop!.expected).length, sopCases.length),
          cases: sopCases.length,
        }
      : null,
    results,
  };
}

export function summarise(r: FrameEvalReport): string {
  const lines = [
    `cases: ${r.cases} (${Object.entries(r.byLang).map(([l, n]) => `${l} ${n}`).join(", ")})`,
    r.frameAccuracy
      ? `frame accuracy: ${FIELDS.map((k) => `${k} ${(r.frameAccuracy![k] * 100).toFixed(1)}%`).join(", ")}`
      : "frame accuracy: n/a (no understanding layer)",
    `category accuracy: ${(r.categoryAccuracy * 100).toFixed(1)}%`,
    `emergency: recall ${(r.emergency.recall * 100).toFixed(1)}%, precision ${(r.emergency.precision * 100).toFixed(1)}% (tp ${r.emergency.tp}, fn ${r.emergency.fn}, fp ${r.emergency.fp})`,
    `re-ask rate: ${(r.reaskRate * 100).toFixed(1)}%  irrelevant-question rate: ${(r.irrelevantRate * 100).toFixed(1)}%  any forbidden: ${(r.forbiddenRate * 100).toFixed(1)}%`,
    r.sopAccuracy
      ? `SOP selection: ${(r.sopAccuracy.fromRules * 100).toFixed(1)}% from the rules frame, ${(r.sopAccuracy.fromGoldFrame * 100).toFixed(1)}% from the labelled frame (${r.sopAccuracy.cases} cases)`
      : "SOP selection: n/a (no SOP catalog)",
    `avg questions before photos: ${r.avgQuestions}`,
  ];
  return lines.join("\n");
}

/** CI floors (deterministic tier, rules only). Raise them as the rules improve; never lower to pass. */
export const FLOORS = {
  tuned: { frameField: 0.95, emergencyRecall: 1, emergencyPrecision: 0.95, forbiddenRate: 0.03, sopFromRules: 0.9 },
  heldout: { equipment: 0.8, emergencyRecall: 1, forbiddenRate: 0.12, sopFromGoldFrame: 0.9 },
};

export async function testFrameEval(): Promise<TestResult> {
  printSection("Understanding eval (labelled first messages, rules tier, no network)");
  const { pass, fail, result } = createRunner();
  const check = (ok: boolean, label: string, detail?: unknown) => (ok ? pass(label) : fail(label, detail));
  const tuned = await runFrameEval(loadCorpus(TUNED_FILES));
  const heldout = await runFrameEval(loadCorpus(HELDOUT_FILES));
  const fa = tuned.frameAccuracy;
  check(!!fa, "understanding layer present");
  for (const k of FIELDS) check((fa?.[k] ?? 0) >= FLOORS.tuned.frameField, `corpus: ${k} accuracy ≥ ${FLOORS.tuned.frameField * 100}%`, fa?.[k]);
  check(tuned.emergency.recall >= FLOORS.tuned.emergencyRecall, "corpus: every emergency caught", tuned.emergency);
  check(tuned.emergency.precision >= FLOORS.tuned.emergencyPrecision, `corpus: emergency precision ≥ ${FLOORS.tuned.emergencyPrecision * 100}%`, tuned.emergency);
  check(tuned.forbiddenRate <= FLOORS.tuned.forbiddenRate, `corpus: forbidden-question rate ≤ ${FLOORS.tuned.forbiddenRate * 100}%`, tuned.forbiddenRate);
  check((heldout.frameAccuracy?.equipment ?? 0) >= FLOORS.heldout.equipment, `held out: equipment accuracy ≥ ${FLOORS.heldout.equipment * 100}%`, heldout.frameAccuracy);
  if (tuned.sopAccuracy) check(tuned.sopAccuracy.fromRules >= FLOORS.tuned.sopFromRules, `corpus: SOP selection ≥ ${FLOORS.tuned.sopFromRules * 100}%`, tuned.sopAccuracy);
  if (heldout.sopAccuracy) check(heldout.sopAccuracy.fromGoldFrame >= FLOORS.heldout.sopFromGoldFrame, `held out: SOP selection from the labelled frame ≥ ${FLOORS.heldout.sopFromGoldFrame * 100}%`, heldout.sopAccuracy);
  check(heldout.emergency.recall >= FLOORS.heldout.emergencyRecall, "held out: every emergency caught", heldout.emergency);
  check(heldout.forbiddenRate <= FLOORS.heldout.forbiddenRate, `held out: forbidden-question rate ≤ ${FLOORS.heldout.forbiddenRate * 100}%`, heldout.forbiddenRate);
  // Real transcripts and regressions must pass exactly.
  const cases = loadCorpus(TUNED_FILES);
  for (const r of tuned.results) {
    const c = cases.find((x) => x.id === r.id)!;
    if (c.source !== "transcript" && c.source !== "regression") continue;
    const misses = [
      ...Object.entries(r.frame ?? {}).filter(([, v]) => !v.ok).map(([k, v]) => `${k} ${v.got}≠${v.expected}`),
      ...(r.emergency.expected !== r.emergency.got ? [`emergency ${r.emergency.got}`] : []),
      ...r.reasked.map((t) => `re-asked ${t}`),
      ...r.irrelevant.map((t) => `asked ${t}`),
    ];
    check(misses.length === 0, `${c.source}: "${c.message}"`, misses.join("; "));
  }
  console.log(["", summarise(tuned), "  held out:", summarise(heldout)].join("\n"));
  return result;
}

const isMain = process.argv[1]?.replace(/\.ts$/, "").endsWith("frame-eval");
if (isMain) {
  (async () => {
    const tuned = await runFrameEval(loadCorpus(TUNED_FILES));
    const heldout = await runFrameEval(loadCorpus(HELDOUT_FILES));
    if (process.argv.includes("--json")) {
      const strip = ({ results, ...summary }: FrameEvalReport) => (void results, summary);
      const full = process.argv.includes("--full");
      console.log(JSON.stringify({ tuned: full ? tuned : strip(tuned), heldout: full ? heldout : strip(heldout) }, null, 2));
      return;
    }
    console.log("── corpus (the rules were tuned on it) ──");
    console.log(summarise(tuned));
    console.log("── held out (never tuned on) ──");
    console.log(summarise(heldout));
    const r = { results: [...tuned.results, ...heldout.results] };
    if (process.argv.includes("--failures")) {
      for (const x of r.results) {
        const misses = x.frame ? Object.entries(x.frame).filter(([, v]) => !v.ok).map(([k, v]) => `${k}: ${v.got}≠${v.expected}`) : [];
        const em = x.emergency.expected !== x.emergency.got ? [`emergency: ${x.emergency.got}≠${x.emergency.expected}`] : [];
        const q = [...x.reasked.map((a) => `re-ask ${a}`), ...x.irrelevant.map((a) => `irrelevant ${a}`)];
        if (x.sop?.expected && x.sop.got !== x.sop.expected) q.push(`sop ${x.sop.got} (gold frame: ${x.sop.gotFromGold}) ≠ ${x.sop.expected}`);
        if (misses.length + em.length + q.length) console.log(`${x.id}  "${x.message}"\n    ${[...misses, ...em, ...q].join("; ")}`);
      }
    }
  })();
}
