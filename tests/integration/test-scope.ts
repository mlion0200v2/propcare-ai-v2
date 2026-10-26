/**
 * Scope rule (src/assistant/sops/scope.ts): questions and options must fit what
 * is known. No network.
 */
import { createRunner, printSection, type TestResult } from "./helpers";
import { scopeOptions, outOfScope } from "../../src/assistant/sops/scope";
import { loadCatalog, sopByKey } from "../../src/assistant/sops/catalog";
import { getExtendedQuestionText } from "../../src/assistant/triage/gather-issue";
import { QUESTIONS } from "../../src/assistant/triage/base-questions";
import { readUnitProfile } from "../../src/lib/units/profile";
import { EQUIPMENT_ROOM } from "../../src/assistant/understanding/taxonomy";
import type { IntakeQuestion } from "../../src/assistant/sops/schema";

const q = (question: string, labels: string[], slot = "timing"): IntakeQuestion => ({
  id: "t",
  slot,
  question,
  prefill: false,
  options: labels.map((label, i) => ({ label, value: `v${i}` })),
});

export async function testScope(): Promise<TestResult> {
  printSection("Scope rule: every question and option fits what's known");
  const { pass, fail, result } = createRunner();
  const check = (ok: boolean, label: string, detail?: unknown) => (ok ? pass(label) : fail(label, detail));
  const labels = (s: ReturnType<typeof scopeOptions>) => s?.options.map((o) => o.label) ?? null;

  const timing = q("When does it leak?", ["All the time", "Only when the shower or bath is used", "When the toilet is flushed", "When an appliance runs", "Not sure"]);
  const fridge = scopeOptions({ equipment: "fridge", substance: "water", room: "kitchen" }, null, timing);
  check(labels(fridge)?.join("|") === "All the time|When an appliance runs|Not sure", "fridge in a kitchen: no shower or toilet timings (Simone's case)", labels(fridge));
  const where = q("Where is the water?", ["Ceiling", "Under the kitchen sink", "Toilet", "Tub or shower", "Dishwasher", "Fridge", "Not sure"], "equipment");
  check(labels(scopeOptions({ equipment: "unknown", substance: "water", room: "kitchen" }, null, where))?.join("|") === "Ceiling|Under the kitchen sink|Dishwasher|Fridge|Not sure", "room kitchen: no toilet or tub options");
  check(!labels(scopeOptions({ equipment: "unknown", substance: "water", room: "bathroom" }, null, where))?.some((l) => /Dishwasher|Fridge|kitchen/.test(l)), "room bathroom: no dishwasher, fridge or kitchen sink");
  const above = q("What's above it?", ["A bathroom", "A kitchen", "Another unit", "Not sure"], "above");
  check(labels(scopeOptions({ equipment: "ceiling", substance: "water", room: "kitchen" }, null, above))?.length === 4, "ceiling leak: may name the room above (exception for ceilings and walls)");
  const ceilingTiming = q("When does it drip?", ["Only when the shower or toilet above is used", "When it rains"]);
  check(labels(scopeOptions({ equipment: "ceiling", substance: "water", room: "kitchen" }, null, ceilingTiming))?.length === 2, "ceiling leak in a kitchen: the shower above is fair");
  check(scopeOptions({ equipment: "range_hood", substance: "grease", room: "kitchen" }, null, q("How much water is there?", ["A few drops", "It's spreading"], "amount")) === null, "grease: no water questions");
  check(scopeOptions({ equipment: "stove_oven", substance: "gas", room: "kitchen" }, null, q("When did it start?", ["Today"], "onset")) === null, "gas smell: no intake questions at all (emergency)");
  check(outOfScope("The dishwasher hose", { equipment: "toilet", substance: "water", room: "bathroom" }, null) !== null, "equipment known: other equipment's parts are out (dishwasher hose for a toilet)");
  check(outOfScope("Is the water near an outlet or a light?", { equipment: "toilet", substance: "water", room: "bathroom" }, null) === null, "safety questions (outlets, lights) always fit");

  // The unit profile wins over the default map: a washer in the kitchen.
  const profile = readUnitProfile({ fixtures: [{ name: "Washer", room: "Kitchen" }] });
  const washerOpt = q("Which appliance?", ["The washer", "The dishwasher"]);
  check(labels(scopeOptions({ equipment: "unknown", substance: "water", room: "kitchen" }, profile, washerOpt))?.includes("The washer") === true, "unit profile: a washer listed in the kitchen is in scope there");
  const bathProfile = readUnitProfile({ fixtures: [{ name: "Dishwasher", room: "Kitchen" }] });
  check(!labels(scopeOptions({ equipment: "unknown", substance: "water", room: "bathroom" }, bathProfile, washerOpt))?.includes("The dishwasher"), "unit profile: the dishwasher is in the kitchen, not the bathroom");

  // Every SOP keeps its own questions in its own context (the filter never empties a legitimate intake).
  const lost: string[] = [];
  for (const sop of loadCatalog().filter((s) => s.selectable)) {
    for (const eq of sop.applies_to.equipment.filter((e) => e !== "unknown")) {
      // Substance unknown: that's when "what's dripping?" is asked.
      const frame = { equipment: eq, substance: "unknown", room: EQUIPMENT_ROOM[eq] ?? "unknown" };
      for (const question of sop.intake_questions) {
        if (question.only_if?.equipment && !question.only_if.equipment.includes(eq)) continue; // not asked for this equipment
        // Options the SOP itself already limits to other rooms (no disposal for a bathroom sink) don't count.
        const own = question.options.filter((o) => !o.only_if?.room || o.only_if.room.includes(frame.room));
        const scoped = scopeOptions(frame, null, question);
        if (!scoped) lost.push(`${sop.issue_key}/${eq}: "${question.question}"`);
        else if (own.some((o) => !scoped.options.includes(o))) lost.push(`${sop.issue_key}/${eq}: ${own.filter((o) => !scoped.options.includes(o)).map((o) => o.label).join(", ")}`);
      }
    }
  }
  check(lost.length === 0, "every SOP's questions and options fit its own equipment", lost.slice(0, 8));

  // The generic fallback questions name no fixture, so they fit anything.
  const generic = [...Object.values(QUESTIONS), getExtendedQuestionText("current_status"), getExtendedQuestionText("brand_model")];
  const bad = generic.filter((t) => outOfScope(t, { equipment: "toilet", substance: "water", room: "bathroom" }, null) || outOfScope(t, { equipment: "fridge", substance: "water", room: "kitchen" }, null));
  check(bad.length === 0, "generic questions name no fixture (they can't know it)", bad);

  check(!!sopByKey("fridge_leak")?.intake_questions.some((x) => x.slot === "supply_line"), "fridge leak asks about the water/ice-maker line");
  return result;
}
