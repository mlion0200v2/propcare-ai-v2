/**
 * A general SOP for every kind of equipment: the fallback when the tenant
 * names the equipment but no written SOP fits what's wrong ("the microwave
 * smells", "the dishwasher is noisy"). Built at load time from the
 * taxonomy and the equipment's own SOPs, so new equipment and new SOPs are
 * covered without anyone writing a catch-all by hand.
 *
 * It asks what the equipment is doing (an answer that matches a written SOP
 * switches to it), then what a tech needs (details, room, onset, model), and
 * hands the manager a "needs assessment" diagnosis with the right trade.
 */
import { EQUIPMENT, EQUIPMENT_CATEGORY, EQUIPMENT_LABEL, SYMPTOM_LEXICON, type Equipment, type Symptom } from "@/assistant/understanding/taxonomy";
import type { Cause, IntakeOption, IntakeQuestion, Sop } from "./schema";

export const GENERAL_VERSION = "general";

export function isGeneralSop(sop: Sop): boolean {
  return sop.version === GENERAL_VERSION;
}

export function generalIssueKey(equipment: string): string {
  return `${equipment}_general`;
}

/** How a tenant would say each symptom, as a tap option. */
const SYMPTOM_OPTION: Partial<Record<Symptom, string>> = {
  leaking: "It's leaking or dripping",
  not_working: "It doesn't work at all",
  noisy: "It's making a noise",
  smell: "There's a smell",
  clogged: "It's clogged or won't drain",
  broken: "Something is broken or loose",
  pests: "Pests or droppings",
  no_heat: "It doesn't heat",
  not_cooling: "It doesn't cool",
  no_hot_water: "No hot water",
  tripping: "It trips the breaker",
  beeping: "It beeps or chirps",
  stuck: "It's stuck or jammed",
  running: "It keeps running",
  mold: "Mould or mildew",
  damaged: "Cracked, stained or damaged",
  no_water: "No water comes out",
  draft: "Cold air or a draft",
};

/** Trade when the equipment has no written SOP to borrow one from. */
const CATEGORY_TRADE: Record<string, string> = {
  appliance: "appliance technician",
  plumbing: "plumber",
  electrical: "electrician",
  hvac: "HVAC technician",
  locksmith: "locksmith",
  roofing: "roofer",
  structural: "handyperson",
  flooring: "flooring installer",
  general: "handyperson",
};

/** Questions copied from the equipment's SOPs, in this order, when one of them asks it. */
const SHARED_SLOTS = ["room", "onset", "brand_model", "amount", "electrical_near"];
/** Water questions only make sense for a leak. */
const LEAK_ONLY = new Set(["amount", "electrical_near"]);

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mostCommon(values: string[], fallback: string): string {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? fallback;
}

function unique(values: string[], max: number): string[] {
  return [...new Set(values)].slice(0, max);
}

function symptomQuestion(label: string, symptoms: Symptom[]): IntakeQuestion {
  const options: IntakeOption[] = symptoms
    .filter((s) => SYMPTOM_OPTION[s])
    .map((s) => ({
      label: SYMPTOM_OPTION[s]!,
      value: s,
      match: (SYMPTOM_LEXICON[s as keyof typeof SYMPTOM_LEXICON] ?? []).map(escapeRegex).join("|") || undefined,
    }));
  options.push({ label: "Something else", value: "other" });
  return { id: "general_symptom", slot: "symptom", question: `What is the ${label} doing?`, options, prefill: false };
}

function buildGeneralSop(equipment: Equipment, catalog: Sop[]): Sop {
  const label = EQUIPMENT_LABEL[equipment];
  const siblings = catalog.filter((s) => s.selectable && !s.route_to_manager && s.applies_to.equipment.includes(equipment));
  const category = mostCommon(siblings.map((s) => s.category), EQUIPMENT_CATEGORY[equipment]);
  const trade = mostCommon(siblings.flatMap((s) => s.causes.map((c) => c.trade)), CATEGORY_TRADE[category] ?? "handyperson");
  const visits = siblings.flatMap((s) => s.causes.map((c) => c.visit_minutes)).sort((a, b) => a[0] - b[0]);
  const visit = visits[Math.floor(visits.length / 2)] ?? [30, 90];
  const symptoms = unique(siblings.flatMap((s) => s.applies_to.symptoms), 12) as Symptom[];

  const shared: IntakeQuestion[] = [];
  for (const slot of SHARED_SLOTS) {
    const q = siblings.flatMap((s) => s.intake_questions).find((x) => x.slot === slot);
    if (q) shared.push(LEAK_ONLY.has(slot) ? { ...q, only_if: { ...q.only_if, symptom: ["leaking"] } } : q);
  }
  const details: IntakeQuestion = {
    id: "general_details",
    slot: "details",
    question: `What exactly is the ${label} doing? Any error code, light, sound or smell helps the technician.`,
    options: [],
    prefill: false,
  };

  const cause: Cause = {
    id: "needs_assessment",
    label: `${label[0].toUpperCase()}${label.slice(1)} problem not covered by a written procedure: needs an assessment`,
    sop_query: `${label} problem troubleshooting`,
    prevention: "",
    candidate_parts: [],
    trade,
    visit_minutes: visit,
    prior: 1,
  };
  const alarm = equipment === "smoke_alarm" || equipment === "co_alarm";

  return {
    id: `sop_general_${equipment}`,
    issue_key: generalIssueKey(equipment),
    title: `${label[0].toUpperCase()}${label.slice(1)}: other problem`,
    category,
    severity: "medium",
    tenant_safe: true,
    version: GENERAL_VERSION,
    selectable: true,
    applies_to: { equipment: [equipment], symptoms: [], substances: [] },
    intake_questions: [symptomQuestion(label, symptoms), details, ...shared],
    causes: [cause],
    diagnostic_questions: [],
    identify: unique(siblings.flatMap((s) => s.identify), 3),
    route_to_manager: false,
    priority: -2,
    keywords: [label],
    strong_keywords: [],
    prevention: [],
    tenant_steps: [
      `If anything looks unsafe (sparks, a burning smell, water near an outlet or light), stop using the ${label} and keep away from it.`,
      `Note what the ${label} shows or does: any error code or blinking light, the sound, and when it happens.`,
      `Take a photo or a short video of the problem.`,
    ],
    escalate_if: unique(["Sparks, smoke or a burning smell", "Water reaching an outlet, light or panel", ...siblings.flatMap((s) => s.escalate_if)], 5),
    photos: unique([`The ${label} and the problem area`, ...siblings.flatMap((s) => s.photos)], 3),
    ask_safety_check: !alarm,
  };
}

/** One general SOP for each kind of equipment the catalog doesn't already have one for. */
export function generalSops(catalog: Sop[]): Sop[] {
  const keys = new Set(catalog.map((s) => s.issue_key));
  return EQUIPMENT.filter((e) => e !== "unknown" && !keys.has(generalIssueKey(e))).map((e) => buildGeneralSop(e, catalog));
}
