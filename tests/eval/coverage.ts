/**
 * Coverage matrix: every common residential maintenance area × its SOPs ×
 * the labelled eval cases × how many pass, plus the diagnosis cards.
 *
 *   npx tsx tests/eval/coverage.ts            (prints the matrix)
 *   npx tsx tests/eval/coverage.ts --write    (also writes tests/eval/reports/coverage.md)
 *
 * A case passes when: emergencies are escalated at once; otherwise the
 * right SOP is chosen and no question is re-asked, irrelevant or out of scope.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadCatalog } from "../../src/assistant/sops/catalog";
import { isGeneralSop } from "../../src/assistant/sops/general";
import { HELDOUT_FILES, TUNED_FILES, loadCorpus, runFrameEval, type FrameEvalReport } from "./frame-eval";
import { runDiagnosisEval, type DiagnosisReport } from "./diagnosis-eval";

/** Simone's list of areas (addendum C), each with the SOPs that cover it. */
export const AREAS: Record<string, string[]> = {
  Plumbing: [
    "under_sink_leak", "faucet_leak_intermittent", "faucet_leak_continuous", "faucet_drip_cartridge", "ptrap_slip_nut_leak",
    "sink_supply_line_leak", "sink_clog", "tub_shower_clog", "shower_surround_leak", "tub_spout_drip", "toilet_running",
    "toilet_fill_valve", "toilet_clog", "toilet_base_leak", "low_water_pressure", "no_water", "no_hot_water", "water_heater_leak",
    "water_heater_relief_valve", "drain_smell", "sewage_backup", "water_leak_unknown",
  ],
  Appliances: [
    "fridge_leak", "fridge_not_cooling", "freezer_not_freezing", "oven_not_heating", "stove_burner_not_working",
    "range_hood_grease_drip", "range_hood_fan_not_working", "range_hood_light_out", "microwave_not_working",
    "dishwasher_not_draining", "dishwasher_leak", "dishwasher_drain_hose_leak", "dishwasher_not_starting", "washer_leak",
    "washer_not_spinning", "washer_not_starting", "dryer_not_heating", "dryer_not_starting", "disposal_jam", "disposal_leak",
  ],
  Electrical: ["outlet_not_working", "gfci_tripped", "breaker_tripped", "light_fixture_out", "flickering_lights", "switch_not_working", "partial_power_outage", "burning_smell_outlet", "sparks"],
  "Heating and air": ["furnace_no_heat", "no_heat_winter", "radiator_no_heat", "heat_pump_not_working", "thermostat_not_responding", "ac_not_cooling", "hvac_noise", "hvac_water_leak", "vent_no_airflow", "vent_fan_not_working"],
  Safety: ["smoke_alarm_chirping", "smoke_alarm_sounding", "co_alarm_chirping", "co_alarm_sounding", "gas_smell"],
  "Doors, windows and locks": ["lockout", "deadbolt_sticking", "key_stuck", "smart_lock_battery", "door_frame_shift", "window_broken", "window_leak", "blinds_broken"],
  Building: ["mold_suspicion", "ceiling_stain", "active_roof_leak", "wall_ceiling_crack", "flooring_damage", "drafts"],
  Pests: ["rodent_signs", "cockroaches", "bedbug_suspicion", "ants", "wasps"],
  "Outdoor and common areas": ["balcony_drain", "gutter_overflow", "garage_door", "intercom_not_working", "elevator_out", "common_laundry", "garbage_room"],
  "Noise and neighbours": ["noise_complaint"],
};

export interface AreaRow {
  area: string;
  sops: number;
  cases: number;
  passed: number;
  cards: number;
  diagnosed: number;
  /** SOPs in the area without any labelled case (should be none). */
  uncovered: string[];
}

export function caseResults(reports: FrameEvalReport[]) {
  const cases = [...loadCorpus(TUNED_FILES), ...loadCorpus(HELDOUT_FILES)];
  const results = reports.flatMap((r) => r.results);
  return cases.map((c) => {
    const r = results.find((x) => x.id === c.id)!;
    const pass = c.emergency
      ? r.emergency.got
      : r.sop?.got === c.sop && r.reasked.length === 0 && r.irrelevant.length === 0 && r.outOfScope.length === 0 && !r.emergency.got;
    return { c, pass };
  });
}

export function coverageMatrix(reports: FrameEvalReport[], diagnosis: DiagnosisReport): AreaRow[] {
  const graded = caseResults(reports);
  return Object.entries(AREAS).map(([area, keys]) => {
    const inArea = graded.filter((g) => g.c.sop && keys.includes(g.c.sop));
    const cards = diagnosis.results.filter((r) => keys.includes(r.card.sop));
    return {
      area,
      sops: keys.length,
      cases: inArea.length,
      passed: inArea.filter((g) => g.pass).length,
      cards: cards.length,
      diagnosed: cards.filter((r) => r.top2 && r.tradeOk && r.partsOk).length,
      uncovered: keys.filter((k) => !graded.some((g) => g.c.sop === k)),
    };
  });
}

export function renderMatrix(rows: AreaRow[]): string {
  const pct = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(0)}%` : "–");
  const lines = [
    "| Area | SOPs | Eval cases | Cases passing | Diagnosis cards | Cause in top 2 (with trade and parts) |",
    "|---|---|---|---|---|---|",
    ...rows.map((r) => `| ${r.area} | ${r.sops} | ${r.cases} | ${r.passed} (${pct(r.passed, r.cases)}) | ${r.cards} | ${r.diagnosed} (${pct(r.diagnosed, r.cards)}) |`),
  ];
  const t = rows.reduce((a, r) => ({ sops: a.sops + r.sops, cases: a.cases + r.cases, passed: a.passed + r.passed, cards: a.cards + r.cards, diagnosed: a.diagnosed + r.diagnosed }), { sops: 0, cases: 0, passed: 0, cards: 0, diagnosed: 0 });
  lines.push(`| **All** | ${t.sops} | ${t.cases} | ${t.passed} (${pct(t.passed, t.cases)}) | ${t.cards} | ${t.diagnosed} (${pct(t.diagnosed, t.cards)}) |`);
  return lines.join("\n");
}

const isMain = process.argv[1]?.replace(/\.ts$/, "").endsWith("coverage");
if (isMain) {
  (async () => {
    const reports = [await runFrameEval(loadCorpus(TUNED_FILES)), await runFrameEval(loadCorpus(HELDOUT_FILES))];
    const rows = coverageMatrix(reports, await runDiagnosisEval());
    const md = renderMatrix(rows);
    console.log(md);
    const missing = rows.flatMap((r) => r.uncovered);
    if (missing.length) console.log(`\nSOPs without eval cases: ${missing.join(", ")}`);
    const all = new Set(Object.values(AREAS).flat());
    const unassigned = loadCatalog().filter((s) => s.selectable && !isGeneralSop(s) && !all.has(s.issue_key)).map((s) => s.issue_key);
    if (unassigned.length) console.log(`SOPs in no area: ${unassigned.join(", ")}`);
    if (process.argv.includes("--write")) {
      writeFileSync(
        join(__dirname, "reports", "coverage.md"),
        `# Coverage matrix (deterministic tier, rules only)\n\nGenerated by \`npx tsx tests/eval/coverage.ts --write\`. A case passes when emergencies are escalated at once; otherwise the right SOP is chosen and no question is re-asked, irrelevant or out of scope. Diagnosis cards: every SOP × cause, scripted tenant answers, run end to end.\n\n${md}\n`
      );
    }
  })();
}

/** CI: every area covered, every SOP has eval cases, diagnosis finds the true cause. Floors only go up. */
export const COVERAGE_FLOORS = { casePass: 0.85, areaCasePass: 0.75, diagnosisTop2: 0.95 };

export async function testCoverage(): Promise<import("../integration/helpers").TestResult> {
  const { createRunner, printSection } = await import("../integration/helpers");
  printSection("Coverage and diagnosis (every area × SOP × eval cases; SOP × cause cards)");
  const { pass, fail, result } = createRunner();
  const check = (ok: boolean, label: string, detail?: unknown) => (ok ? pass(label) : fail(label, detail));
  const reports = [await runFrameEval(loadCorpus(TUNED_FILES)), await runFrameEval(loadCorpus(HELDOUT_FILES))];
  const diagnosis = await runDiagnosisEval();
  const rows = coverageMatrix(reports, diagnosis);
  const all = new Set(Object.values(AREAS).flat());
  const unassigned = loadCatalog().filter((s) => s.selectable && !isGeneralSop(s) && !all.has(s.issue_key)).map((s) => s.issue_key);
  check(unassigned.length === 0, "every selectable SOP belongs to an area", unassigned);
  check(rows.every((r) => r.uncovered.length === 0), "every SOP has labelled eval cases", rows.flatMap((r) => r.uncovered));
  const cases = rows.reduce((n, r) => n + r.cases, 0);
  const passed = rows.reduce((n, r) => n + r.passed, 0);
  check(passed / cases >= COVERAGE_FLOORS.casePass, `cases passing ≥ ${COVERAGE_FLOORS.casePass * 100}% (${passed}/${cases})`);
  for (const r of rows) check(r.cases > 0 && r.passed / r.cases >= COVERAGE_FLOORS.areaCasePass, `${r.area}: ${r.passed}/${r.cases} cases pass (≥ ${COVERAGE_FLOORS.areaCasePass * 100}%)`);
  check(diagnosis.top2 >= COVERAGE_FLOORS.diagnosisTop2, `diagnosis: true cause in the top 2 with trade and parts ≥ ${COVERAGE_FLOORS.diagnosisTop2 * 100}% (${(diagnosis.top2 * 100).toFixed(1)}% of ${diagnosis.cards} cards)`);
  console.log("\n" + renderMatrix(rows));
  return result;
}
