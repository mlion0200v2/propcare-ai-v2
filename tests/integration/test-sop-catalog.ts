/**
 * SOP catalog: schema, references, tenant safety, and that every SOP the
 * eval expects exists. No network.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRunner, printSection, type TestResult } from "./helpers";
import { loadCatalog, sopByKey } from "../../src/lib/sops/catalog";
import { selectSop } from "../../src/lib/sops/select";
import { rulesFrame } from "../../src/lib/understanding/rules";
import { sopRecordMetadata } from "../../scripts/ingest_sops";

/** Things tenants must never be told to do. */
const UNSAFE = [
  /\b(use|climb|get|grab) (a |the )?(ladder|step ?stool|chair)\b/i,
  /\bstand on (a |the )?(chair|counter|table|furniture)\b/i,
  /\b(relight|light) the pilot\b/i,
  /\b(turn|shut|close) (off )?the gas\b/i,
  /\b(remove|open|unscrew) the (panel|breaker panel) cover\b/i,
  /\bopen the (furnace|electrical panel|fixture)\b/i,
];
const FRAME_SLOTS = new Set(["equipment", "symptom", "substance", "room", "onset", "status"]);

export async function testSopCatalog(): Promise<TestResult> {
  printSection("SOP catalog v2 (schema, references, tenant safety)");
  const { pass, fail, result } = createRunner();
  const check = (ok: boolean, label: string, detail?: unknown) => (ok ? pass(label) : fail(label, detail));

  const sops = loadCatalog();
  check(sops.length >= 75, `catalog loads and validates (${sops.length} SOPs)`);
  const keys = new Set(sops.map((s) => s.issue_key));
  check(keys.size === sops.length, "issue keys are unique");
  check(new Set(sops.map((s) => s.id)).size === sops.length, "ids are unique");

  const problems: string[] = [];
  for (const sop of sops) {
    const slots = new Set([...FRAME_SLOTS, ...sop.intake_questions.map((q) => q.slot)]);
    for (const q of sop.intake_questions) {
      for (const o of q.options) {
        if (o.match) {
          try {
            new RegExp(o.match, "i");
          } catch {
            problems.push(`${sop.issue_key}/${q.id}: bad regex ${o.match}`);
          }
        }
        for (const s of Object.keys(o.only_if ?? {})) if (!slots.has(s)) problems.push(`${sop.issue_key}/${q.id}: option only_if on unknown slot ${s}`);
      }
      for (const s of Object.keys(q.only_if ?? {})) if (!slots.has(s)) problems.push(`${sop.issue_key}/${q.id}: only_if on unknown slot ${s}`);
    }
    const causeIds = new Set(sop.causes.map((c) => c.id));
    for (const c of sop.causes) {
      if (c.refine_to && !keys.has(c.refine_to)) problems.push(`${sop.issue_key}: refine_to ${c.refine_to} doesn't exist`);
      if (!c.trade) problems.push(`${sop.issue_key}: cause ${c.id} has no trade`);
      if (c.visit_minutes[0] > c.visit_minutes[1]) problems.push(`${sop.issue_key}: cause ${c.id} visit range reversed`);
    }
    for (const q of sop.intake_questions) {
      for (const o of q.options) {
        for (const id of [...(o.rules_in ?? []), ...(o.rules_out ?? [])]) if (!causeIds.has(id)) problems.push(`${sop.issue_key}/${q.id}: rules ${id}, not one of its causes`);
      }
    }
    for (const id of sop.diagnostic_questions) if (!sop.intake_questions.some((q) => q.id === id)) problems.push(`${sop.issue_key}: diagnostic question ${id} doesn't exist`);
    if (sop.selectable && !sop.route_to_manager && sop.causes.length === 0) problems.push(`${sop.issue_key}: no causes`);
    if (sop.selectable && sop.causes.length > 1 && sop.diagnostic_questions.length === 0) problems.push(`${sop.issue_key}: several causes but no question tells them apart`);
    if (sop.selectable && sop.tenant_steps.length === 0) problems.push(`${sop.issue_key}: no tenant steps`);
    for (const step of [...sop.tenant_steps, ...sop.prevention]) {
      // Clause by clause; "Don't use a ladder" is the rule, not a breach.
      const clauses = step.split(/[.;,()]|\band\b/).filter((c) => !/\b(don'?t|do not|never|avoid|without)\b/i.test(c));
      for (const p of UNSAFE) if (clauses.some((c) => p.test(c))) problems.push(`${sop.issue_key}: unsafe step "${step}"`);
    }
    const size = Buffer.byteLength(JSON.stringify(sopRecordMetadata(sop)));
    if (size > 40000) problems.push(`${sop.issue_key}: Pinecone metadata ${size} bytes`);
  }
  check(problems.length === 0, "questions, conditions, causes and steps are consistent and tenant-safe", problems.slice(0, 10).join(" | "));

  // Every SOP the eval expects exists.
  const expected = new Set<string>();
  for (const f of ["first-messages.jsonl", "heldout.jsonl"]) {
    for (const line of readFileSync(join(__dirname, "..", "eval", "corpus", f), "utf8").split("\n")) {
      if (line.trim()) {
        const sop = JSON.parse(line).sop;
        if (sop) expected.add(sop);
      }
    }
  }
  const missing = [...expected].filter((k) => !sopByKey(k));
  check(missing.length === 0, `every SOP the eval expects exists (${expected.size})`, missing);

  // The brief's list of new procedures
  for (const k of ["range_hood_grease_drip", "range_hood_fan_not_working", "range_hood_light_out", "fridge_not_cooling", "fridge_leak", "dishwasher_not_draining", "washer_leak", "dryer_not_heating", "disposal_jam", "toilet_running", "toilet_clog", "smoke_alarm_chirping", "co_alarm_chirping", "radiator_no_heat", "gfci_tripped", "window_broken", "deadbolt_sticking", "cockroaches"]) {
    const sop = sopByKey(k);
    check(!!sop && sop.selectable && sop.intake_questions.length > 0, `SOP ${k} has intake questions`);
  }

  // Selection
  const pick = (m: string) => selectSop(rulesFrame(m), m)?.sop.issue_key ?? null;
  check(pick("rangehood is leaking gease") === "range_hood_grease_drip", "Simone: rangehood leaking gease → range hood grease SOP", pick("rangehood is leaking gease"));
  check(pick("my rangehood is not working") === "range_hood_fan_not_working", "Simone: rangehood not working → fan SOP");
  check(pick("my sink is leaking") === "under_sink_leak", "Simone: sink leaking → under-sink leak SOP");
  check(pick("help") === null, "too vague → no SOP (generic questions)");
  check(pick("the water heater pipe on the side is dripping") === "water_heater_relief_valve", "strong keywords pick the sibling (relief valve)");

  return result;
}
