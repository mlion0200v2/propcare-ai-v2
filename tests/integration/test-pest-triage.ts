/**
 * Pest triage tests — classifyPest, extractEntryPoint, checkPestEscalation,
 * validateTenantInfo, pest SOP split, recurring status extraction.
 */
import { createRunner, printSection, type TestResult } from "./helpers";
import { classifyPest, classifyMold, classifyPlumbing, classifyStructural, classifyIssue } from "../../src/lib/triage/classify-issue";
import { extractEntryPoint, extractCurrentStatus, extractLocation, getCanonicalEquipment, inferLocationFromEquipment } from "../../src/lib/triage/extract-details";
import { checkPestEscalation, detectSafety } from "../../src/lib/triage/detect-safety";
import { validateTenantInfo, buildInitialGathered } from "../../src/lib/triage/state-machine";
import { getFallbackSOP } from "../../src/lib/triage/sop-fallback";
import { convertToGuidedSteps, shouldUseGuidedTroubleshooting } from "../../src/lib/triage/grounding";
import type { GatheredInfo, TenantInfo, TroubleshootingStep } from "../../src/lib/triage/types";

export function testPestTriage(): TestResult {
  printSection("Pest Triage");
  const { pass, fail, result } = createRunner();

  // ── classifyPest ──

  const antResult = classifyPest("found ant in the kitchen");
  if (antResult && antResult.group === "insects" && antResult.species === "ants") {
    pass("classifyPest: 'found ant' → insects/ants");
  } else {
    fail("classifyPest: 'found ant' should → insects/ants", antResult);
  }

  const roachResult = classifyPest("cockroach in kitchen");
  if (roachResult && roachResult.group === "insects" && roachResult.species === "cockroaches") {
    pass("classifyPest: 'cockroach in kitchen' → insects/cockroaches");
  } else {
    fail("classifyPest: 'cockroach in kitchen' should → insects/cockroaches", roachResult);
  }

  const miceResult = classifyPest("mice droppings behind the fridge");
  if (miceResult && miceResult.group === "rodents" && miceResult.species === "mice") {
    pass("classifyPest: 'mice droppings' → rodents/mice");
  } else {
    fail("classifyPest: 'mice droppings' should → rodents/mice", miceResult);
  }

  const ratResult = classifyPest("I think I have rats in the wall");
  if (ratResult && ratResult.group === "rodents" && ratResult.species === "rats") {
    pass("classifyPest: 'rats in the wall' → rodents/rats");
  } else {
    fail("classifyPest: 'rats in the wall' should → rodents/rats", ratResult);
  }

  const genericResult = classifyPest("I see a bug in my room");
  if (genericResult === null) {
    pass("classifyPest: 'I see a bug' → null (generic)");
  } else {
    fail("classifyPest: 'I see a bug' should → null", genericResult);
  }

  const bedbugResult = classifyPest("I found bed bugs on the mattress");
  if (bedbugResult && bedbugResult.group === "insects" && bedbugResult.species === "bedbugs") {
    pass("classifyPest: 'bed bugs' → insects/bedbugs");
  } else {
    fail("classifyPest: 'bed bugs' should → insects/bedbugs", bedbugResult);
  }

  const termiteResult = classifyPest("termites in the wood");
  if (termiteResult && termiteResult.group === "insects" && termiteResult.species === "termites") {
    pass("classifyPest: 'termites' → insects/termites");
  } else {
    fail("classifyPest: 'termites' should → insects/termites", termiteResult);
  }

  // ── extractEntryPoint ──

  const ep1 = extractEntryPoint("there's a hole under the carpet");
  if (ep1 && ep1.includes("hole") && ep1.includes("under")) {
    pass("extractEntryPoint: 'hole under the carpet' → match");
  } else {
    fail("extractEntryPoint: 'hole under the carpet' should match", ep1);
  }

  const ep2 = extractEntryPoint("I see a crack in the wall near the door");
  if (ep2 && ep2.includes("crack") && ep2.includes("wall")) {
    pass("extractEntryPoint: 'crack in the wall' → match");
  } else {
    fail("extractEntryPoint: 'crack in the wall' should match", ep2);
  }

  const ep3 = extractEntryPoint("they're coming from under the sink");
  if (ep3 && ep3.includes("entering from")) {
    pass("extractEntryPoint: 'coming from under the sink' → match");
  } else {
    fail("extractEntryPoint: 'coming from under the sink' should match", ep3);
  }

  const ep4 = extractEntryPoint("the faucet is leaking");
  if (ep4 === null) {
    pass("extractEntryPoint: 'faucet is leaking' → null");
  } else {
    fail("extractEntryPoint: 'faucet is leaking' should → null", ep4);
  }

  const ep5 = extractEntryPoint("there's a gap behind the baseboard");
  if (ep5 && ep5.includes("gap") && ep5.includes("behind")) {
    pass("extractEntryPoint: 'gap behind the baseboard' → match");
  } else {
    fail("extractEntryPoint: 'gap behind the baseboard' should match", ep5);
  }

  // ── checkPestEscalation ──

  const pestGathered: GatheredInfo = {
    ...buildInitialGathered(),
    category: "pest_control",
    location_in_unit: "kitchen",
    started_when: "last week",
    current_status: "still happening",
  };

  // Unknown subcategory + mild recurring → escalates (not identified as low-risk)
  const esc1 = checkPestEscalation(pestGathered, "the pests keep coming back");
  if (esc1.shouldEscalate === true) {
    pass("checkPestEscalation: unknown pest + 'keeps coming back' → shouldEscalate");
  } else {
    fail("checkPestEscalation: unknown pest + 'keeps coming back' should escalate", esc1);
  }

  const pestWithEntry: GatheredInfo = {
    ...pestGathered,
    entry_point: "hole under carpet",
  };
  const esc2 = checkPestEscalation(pestWithEntry, "I see ants");
  if (esc2.shouldEscalate === true) {
    pass("checkPestEscalation: pest + entry_point → shouldEscalate");
  } else {
    fail("checkPestEscalation: pest + entry_point should escalate", esc2);
  }

  const esc3 = checkPestEscalation(pestGathered, "I see some ants today");
  if (esc3.shouldEscalate === false) {
    pass("checkPestEscalation: pest + no recurring + no entry → no escalation");
  } else {
    fail("checkPestEscalation: pest + no recurring should not escalate", esc3);
  }

  const plumbingGathered: GatheredInfo = {
    ...buildInitialGathered(),
    category: "plumbing",
    location_in_unit: "bathroom",
    started_when: "yesterday",
    current_status: "keeps coming back",
  };
  const esc4 = checkPestEscalation(plumbingGathered, "keeps coming back");
  if (esc4.shouldEscalate === false) {
    pass("checkPestEscalation: plumbing + recurring → no escalation (wrong category)");
  } else {
    fail("checkPestEscalation: plumbing should not trigger pest escalation", esc4);
  }

  // ── Tiered escalation: low-risk vs high-risk pests ──

  // Ants + "getting worse" → should NOT escalate (low-risk + mild indicator)
  const antsGathered: GatheredInfo = {
    ...buildInitialGathered(),
    category: "pest_control",
    subcategory: "ants",
    location_in_unit: "kitchen",
    started_when: "last week",
    current_status: "getting worse",
  };
  const escAntsWorse = checkPestEscalation(antsGathered, "the ants are getting worse");
  if (escAntsWorse.shouldEscalate === false) {
    pass("checkPestEscalation: ants + 'getting worse' → no escalation (low-risk + mild)");
  } else {
    fail("checkPestEscalation: ants + 'getting worse' should NOT escalate", escAntsWorse);
  }

  // Ants + "keeps coming back" → should NOT escalate (low-risk + mild indicator)
  const escAntsRecur = checkPestEscalation(antsGathered, "the ants keep coming back");
  if (escAntsRecur.shouldEscalate === false) {
    pass("checkPestEscalation: ants + 'keeps coming back' → no escalation (low-risk + mild)");
  } else {
    fail("checkPestEscalation: ants + 'keeps coming back' should NOT escalate", escAntsRecur);
  }

  // Ants + severe indicator → SHOULD escalate (tried professional help)
  const escAntsSevere = checkPestEscalation(antsGathered, "we tried pest control already and they came back");
  if (escAntsSevere.shouldEscalate === true && escAntsSevere.reason.includes("severe")) {
    pass("checkPestEscalation: ants + 'tried pest control' → escalate (severe indicator)");
  } else {
    fail("checkPestEscalation: ants + 'tried pest control' should escalate via severe", escAntsSevere);
  }

  // Ants + no indicators → should NOT escalate
  const escAntsClean = checkPestEscalation(antsGathered, "I see ants on the counter");
  if (escAntsClean.shouldEscalate === false) {
    pass("checkPestEscalation: ants + no indicators → no escalation");
  } else {
    fail("checkPestEscalation: ants + no indicators should NOT escalate", escAntsClean);
  }

  // Cockroaches + "getting worse" → should NOT escalate (low-risk + mild)
  const roachGathered: GatheredInfo = {
    ...buildInitialGathered(),
    category: "pest_control",
    subcategory: "cockroaches",
    location_in_unit: "kitchen",
    started_when: "last week",
    current_status: "getting worse",
  };
  const escRoachWorse = checkPestEscalation(roachGathered, "the roaches are getting worse");
  if (escRoachWorse.shouldEscalate === false) {
    pass("checkPestEscalation: cockroaches + 'getting worse' → no escalation (low-risk)");
  } else {
    fail("checkPestEscalation: cockroaches + 'getting worse' should NOT escalate", escRoachWorse);
  }

  // Rats + "getting worse" → SHOULD escalate (high-risk + mild indicator)
  const ratsGathered: GatheredInfo = {
    ...buildInitialGathered(),
    category: "pest_control",
    subcategory: "rats",
    location_in_unit: "kitchen",
    started_when: "last week",
    current_status: "getting worse",
  };
  const escRatsWorse = checkPestEscalation(ratsGathered, "the rats are getting worse");
  if (escRatsWorse.shouldEscalate === true) {
    pass("checkPestEscalation: rats + 'getting worse' → escalate (high-risk + mild)");
  } else {
    fail("checkPestEscalation: rats + 'getting worse' should escalate", escRatsWorse);
  }

  // Any pest + "infestation" → SHOULD escalate (severe indicator)
  const escAntsInfest = checkPestEscalation(antsGathered, "we have an ant infestation");
  if (escAntsInfest.shouldEscalate === true && escAntsInfest.reason.includes("severe")) {
    pass("checkPestEscalation: ants + 'infestation' → escalate (severe indicator)");
  } else {
    fail("checkPestEscalation: ants + 'infestation' should escalate via severe", escAntsInfest);
  }

  // ── validateTenantInfo ──

  const ti1: TenantInfo = {
    reported_address: "123 Main St",
    reported_unit_number: "non",
    contact_phone: "555-1234",
    contact_email: "a@b.com",
  };
  const invalid1 = validateTenantInfo(ti1);
  if (invalid1.includes("reported_unit_number")) {
    pass("validateTenantInfo: unit='non' → invalid");
  } else {
    fail("validateTenantInfo: unit='non' should be invalid", invalid1);
  }

  const ti2: TenantInfo = {
    reported_address: "123 Main St",
    reported_unit_number: "4B",
    contact_phone: "555-1234",
    contact_email: "a@b.com",
  };
  const invalid2 = validateTenantInfo(ti2);
  if (invalid2.length === 0) {
    pass("validateTenantInfo: unit='4B' → valid");
  } else {
    fail("validateTenantInfo: unit='4B' should be valid", invalid2);
  }

  const ti3: TenantInfo = {
    reported_address: "123 Main St",
    reported_unit_number: "none",
    contact_phone: "555-1234",
    contact_email: "a@b.com",
  };
  const invalid3 = validateTenantInfo(ti3);
  if (!invalid3.includes("reported_unit_number")) {
    pass("validateTenantInfo: unit='none' → valid (intentional no-unit)");
  } else {
    fail("validateTenantInfo: unit='none' should be valid", invalid3);
  }

  const ti4: TenantInfo = {
    reported_address: "123 Main St",
    reported_unit_number: "",
    contact_phone: "555-1234",
    contact_email: "a@b.com",
  };
  const invalid4 = validateTenantInfo(ti4);
  if (invalid4.includes("reported_unit_number")) {
    pass("validateTenantInfo: unit='' → invalid");
  } else {
    fail("validateTenantInfo: unit='' should be invalid", invalid4);
  }

  const ti5: TenantInfo = {
    reported_address: "ab",
    reported_unit_number: "4B",
    contact_phone: "555-1234",
    contact_email: "a@b.com",
  };
  const invalid5 = validateTenantInfo(ti5);
  if (invalid5.includes("reported_address")) {
    pass("validateTenantInfo: address='ab' (too short) → invalid");
  } else {
    fail("validateTenantInfo: short address should be invalid", invalid5);
  }

  // ── Pest SOP split ──

  const insectSOP = getFallbackSOP("pest_control", false, "ants");
  const insectText = insectSOP.display;
  const hasInsectContent = insectText.includes("bait trap") || insectText.includes("crumbs");
  const noRodentInInsect = !insectText.includes("snap trap") && !insectText.includes("droppings");
  if (hasInsectContent && noRodentInInsect) {
    pass("getFallbackSOP: pest_control + ants → insect SOP (no rodent references)");
  } else {
    fail("getFallbackSOP: pest_control + ants should use insect SOP", {
      hasInsectContent,
      noRodentInInsect,
      snippet: insectText.slice(0, 200),
    });
  }

  const rodentSOP = getFallbackSOP("pest_control", false, "rats");
  const rodentText = rodentSOP.display;
  const hasRodentContent = rodentText.includes("snap trap") || rodentText.includes("droppings");
  const noInsectInRodent = !rodentText.includes("bait trap") && !rodentText.includes("crumbs");
  if (hasRodentContent && noInsectInRodent) {
    pass("getFallbackSOP: pest_control + rats → rodent SOP (no insect references)");
  } else {
    fail("getFallbackSOP: pest_control + rats should use rodent SOP", {
      hasRodentContent,
      noInsectInRodent,
      snippet: rodentText.slice(0, 200),
    });
  }

  const genericPestSOP = getFallbackSOP("pest_control", false);
  const genericText = genericPestSOP.display;
  if (genericText.includes("type of pest")) {
    pass("getFallbackSOP: pest_control + no subcategory → generic pest SOP");
  } else {
    fail("getFallbackSOP: pest_control alone should use generic pest SOP", genericText.slice(0, 200));
  }

  // ── extractCurrentStatus: recurring phrases ──

  const status1 = extractCurrentStatus("the ants keeps coming back every day");
  if (status1 === "keeps coming back") {
    pass("extractCurrentStatus: 'keeps coming back' → extracted");
  } else {
    fail("extractCurrentStatus: 'keeps coming back' should be extracted", status1);
  }

  const status2 = extractCurrentStatus("this is a recurring problem");
  if (status2 === "recurring") {
    pass("extractCurrentStatus: 'recurring' → extracted");
  } else {
    fail("extractCurrentStatus: 'recurring' should be extracted", status2);
  }

  const status3 = extractCurrentStatus("the mice came back after the traps");
  if (status3 === "came back") {
    pass("extractCurrentStatus: 'came back' → extracted");
  } else {
    fail("extractCurrentStatus: 'came back' should be extracted", status3);
  }

  const status4 = extractCurrentStatus("it's not going away");
  if (status4 === "not going away") {
    pass("extractCurrentStatus: 'not going away' → extracted");
  } else {
    fail("extractCurrentStatus: 'not going away' should be extracted", status4);
  }

  // ── checkPestEscalation: bed bugs always escalate ──

  const bedbugGathered: GatheredInfo = {
    ...buildInitialGathered(),
    category: "pest_control",
    subcategory: "bedbugs",
    location_in_unit: "bedroom",
    started_when: "yesterday",
    current_status: "still happening",
  };
  const escBedbugs = checkPestEscalation(bedbugGathered, "I found bed bugs on the mattress");
  if (escBedbugs.shouldEscalate === true && escBedbugs.reason.includes("professional_only")) {
    pass("checkPestEscalation: bed bugs → always escalate (professional only)");
  } else {
    fail("checkPestEscalation: bed bugs should always escalate", escBedbugs);
  }

  // ── shouldUseGuidedTroubleshooting ──

  // Faucet leak (plumbing) → guided when SOP has actionable steps
  const plumbingSOP = getFallbackSOP("plumbing", false);
  const plumbingGuided = convertToGuidedSteps(plumbingSOP.steps);
  if (shouldUseGuidedTroubleshooting(plumbingGuided, false)) {
    pass("shouldUseGuided: plumbing fallback SOP → guided (has actionable steps)");
  } else {
    fail("shouldUseGuided: plumbing fallback SOP should enter guided mode", {
      kinds: plumbingGuided.map(s => s.step_kind),
    });
  }

  // General SOP → NOT guided (all steps are info-gathering meta-prompts)
  const generalSOP = getFallbackSOP("general", false);
  const generalGuided = convertToGuidedSteps(generalSOP.steps);
  if (!shouldUseGuidedTroubleshooting(generalGuided, false)) {
    pass("shouldUseGuided: general fallback SOP → NOT guided (info-gathering meta-prompts)");
  } else {
    fail("shouldUseGuided: general fallback SOP should NOT enter guided mode", {
      kinds: generalGuided.map(s => s.step_kind),
    });
  }

  // Ants (pest_insects) → guided when SOP has actionable steps
  const antsSOP = getFallbackSOP("pest_control", false, "ants");
  const antsGuided = convertToGuidedSteps(antsSOP.steps);
  if (shouldUseGuidedTroubleshooting(antsGuided, false)) {
    pass("shouldUseGuided: ants fallback SOP → guided (has actionable steps)");
  } else {
    fail("shouldUseGuided: ants fallback SOP should enter guided mode", {
      kinds: antsGuided.map(s => s.step_kind),
    });
  }

  // HVAC → guided when SOP has actionable steps
  const hvacSOP = getFallbackSOP("hvac", false);
  const hvacGuided = convertToGuidedSteps(hvacSOP.steps);
  if (shouldUseGuidedTroubleshooting(hvacGuided, false)) {
    pass("shouldUseGuided: hvac fallback SOP → guided (has actionable steps)");
  } else {
    fail("shouldUseGuided: hvac fallback SOP should enter guided mode", {
      kinds: hvacGuided.map(s => s.step_kind),
    });
  }

  // Appliance → guided
  const applianceSOP = getFallbackSOP("appliance", false);
  const applianceGuided = convertToGuidedSteps(applianceSOP.steps);
  if (shouldUseGuidedTroubleshooting(applianceGuided, false)) {
    pass("shouldUseGuided: appliance fallback SOP → guided (has actionable steps)");
  } else {
    fail("shouldUseGuided: appliance fallback SOP should enter guided mode", {
      kinds: applianceGuided.map(s => s.step_kind),
    });
  }

  // Emergency → never guided (regardless of step content)
  if (!shouldUseGuidedTroubleshooting(plumbingGuided, true)) {
    pass("shouldUseGuided: emergency=true → no guided (even with actionable steps)");
  } else {
    fail("shouldUseGuided: emergency should bypass guided mode");
  }

  // No steps → no guided
  if (!shouldUseGuidedTroubleshooting([], false)) {
    pass("shouldUseGuided: empty steps → no guided");
  } else {
    fail("shouldUseGuided: empty steps should not enter guided mode");
  }

  // All terminal steps → no guided (professional-only SOP)
  const terminalOnlySteps: TroubleshootingStep[] = [
    { step: 1, description: "Do NOT attempt repairs yourself.", completed: false },
    { step: 2, description: "Avoid touching any damaged areas.", completed: false },
    { step: 3, description: "Do not use chemical treatments.", completed: false },
  ];
  const terminalGuided = convertToGuidedSteps(terminalOnlySteps);
  if (!shouldUseGuidedTroubleshooting(terminalGuided, false)) {
    pass("shouldUseGuided: all-terminal steps → no guided (professional only)");
  } else {
    fail("shouldUseGuided: all-terminal steps should not enter guided mode", {
      kinds: terminalGuided.map(s => s.step_kind),
    });
  }

  // ── classifyMold ──

  const moldResult1 = classifyMold("mold on the wall");
  if (moldResult1 === "mold") {
    pass("classifyMold: 'mold on the wall' → 'mold'");
  } else {
    fail("classifyMold: 'mold on the wall' should → 'mold'", moldResult1);
  }

  const moldResult2 = classifyMold("musty smell");
  if (moldResult2 === "musty") {
    pass("classifyMold: 'musty smell' → 'musty'");
  } else {
    fail("classifyMold: 'musty smell' should → 'musty'", moldResult2);
  }

  const moldResult3 = classifyMold("just a crack");
  if (moldResult3 === null) {
    pass("classifyMold: 'just a crack' → null");
  } else {
    fail("classifyMold: 'just a crack' should → null", moldResult3);
  }

  const moldResult4 = classifyMold("there's fungus growing on the ceiling");
  if (moldResult4 === "fungus") {
    pass("classifyMold: 'fungus growing' → 'fungus'");
  } else {
    fail("classifyMold: 'fungus growing' should → 'fungus'", moldResult4);
  }

  const moldResult5 = classifyMold("mildew in the bathroom");
  if (moldResult5 === "mold") {
    pass("classifyMold: 'mildew in the bathroom' → 'mold'");
  } else {
    fail("classifyMold: 'mildew in the bathroom' should → 'mold'", moldResult5);
  }

  // ── Mold SOP split ──

  const moldSOP = getFallbackSOP("structural", false, "mold");
  const moldText = moldSOP.display;
  const hasMoldContent = moldText.includes("ventilation") && moldText.includes("damp");
  const noStructuralInMold = !moldText.includes("sagging") && !moldText.includes("hanging");
  if (hasMoldContent && noStructuralInMold) {
    pass("getFallbackSOP: structural + mold → mold SOP (no generic structural references)");
  } else {
    fail("getFallbackSOP: structural + mold should use mold SOP", {
      hasMoldContent,
      noStructuralInMold,
      snippet: moldText.slice(0, 200),
    });
  }

  const mustySOP = getFallbackSOP("structural", false, "musty");
  if (mustySOP.display.includes("ventilation")) {
    pass("getFallbackSOP: structural + musty → mold SOP");
  } else {
    fail("getFallbackSOP: structural + musty should use mold SOP", mustySOP.display.slice(0, 200));
  }

  const genericStructuralSOP = getFallbackSOP("structural", false);
  if (genericStructuralSOP.display.includes("cracks")) {
    pass("getFallbackSOP: structural + no subcategory → generic structural SOP");
  } else {
    fail("getFallbackSOP: structural alone should use generic structural SOP", genericStructuralSOP.display.slice(0, 200));
  }

  // ── shouldUseGuidedTroubleshooting: mold SOP → guided ──
  const moldGuidedSteps = convertToGuidedSteps(moldSOP.steps);
  if (shouldUseGuidedTroubleshooting(moldGuidedSteps, false)) {
    pass("shouldUseGuided: structural_mold fallback SOP → guided (has actionable steps)");
  } else {
    fail("shouldUseGuided: structural_mold fallback SOP should enter guided mode", {
      kinds: moldGuidedSteps.map(s => s.step_kind),
    });
  }

  // ── classifyPlumbing ──

  const plumb1 = classifyPlumbing("toilet handle is broken");
  if (plumb1 === "broken_fixture") {
    pass("classifyPlumbing: 'toilet handle is broken' → 'broken_fixture'");
  } else {
    fail("classifyPlumbing: 'toilet handle is broken' should → 'broken_fixture'", plumb1);
  }

  const plumb2 = classifyPlumbing("toilet won't stop running");
  if (plumb2 === "running_toilet") {
    pass("classifyPlumbing: 'toilet won't stop running' → 'running_toilet'");
  } else {
    fail("classifyPlumbing: 'toilet won't stop running' should → 'running_toilet'", plumb2);
  }

  const plumb3 = classifyPlumbing("sink is clogged");
  if (plumb3 === "clog") {
    pass("classifyPlumbing: 'sink is clogged' → 'clog'");
  } else {
    fail("classifyPlumbing: 'sink is clogged' should → 'clog'", plumb3);
  }

  const plumb4 = classifyPlumbing("pipe is leaking");
  if (plumb4 === "leak") {
    pass("classifyPlumbing: 'pipe is leaking' → 'leak'");
  } else {
    fail("classifyPlumbing: 'pipe is leaking' should → 'leak'", plumb4);
  }

  const plumb5 = classifyPlumbing("no hot water in the shower");
  if (plumb5 === "no_hot_water") {
    pass("classifyPlumbing: 'no hot water in the shower' → 'no_hot_water'");
  } else {
    fail("classifyPlumbing: 'no hot water in the shower' should → 'no_hot_water'", plumb5);
  }

  const plumb6 = classifyPlumbing("very low water pressure");
  if (plumb6 === "water_pressure") {
    pass("classifyPlumbing: 'very low water pressure' → 'water_pressure'");
  } else {
    fail("classifyPlumbing: 'very low water pressure' should → 'water_pressure'", plumb6);
  }

  const plumb7 = classifyPlumbing("toilet not flushing");
  if (plumb7 === "broken_fixture") {
    pass("classifyPlumbing: 'toilet not flushing' → 'broken_fixture' (via won't flush)");
  } else {
    fail("classifyPlumbing: 'toilet not flushing' should → 'broken_fixture'", plumb7);
  }

  const plumb8 = classifyPlumbing("I need a plumber");
  if (plumb8 === null) {
    pass("classifyPlumbing: 'I need a plumber' → null (generic)");
  } else {
    fail("classifyPlumbing: 'I need a plumber' should → null", plumb8);
  }

  // ── Plumbing SOP split ──

  const brokenFixtureSOP = getFallbackSOP("plumbing", false, "broken_fixture");
  const brokenText = brokenFixtureSOP.display;
  const hasBrokenContent = brokenText.toLowerCase().includes("force");
  const noBucketInBroken = !brokenText.toLowerCase().includes("bucket");
  if (hasBrokenContent && noBucketInBroken) {
    pass("getFallbackSOP: plumbing + broken_fixture → broken fixture SOP (no bucket references)");
  } else {
    fail("getFallbackSOP: plumbing + broken_fixture should use broken fixture SOP", {
      hasBrokenContent,
      noBucketInBroken,
      snippet: brokenText.slice(0, 200),
    });
  }

  const clogSOP = getFallbackSOP("plumbing", false, "clog");
  const clogText = clogSOP.display;
  const hasClogContent = clogText.toLowerCase().includes("plunger");
  const noShutoffInClog = !clogText.toLowerCase().includes("shut-off valve");
  if (hasClogContent && noShutoffInClog) {
    pass("getFallbackSOP: plumbing + clog → clog SOP (has plunger, no shut-off valve)");
  } else {
    fail("getFallbackSOP: plumbing + clog should use clog SOP", {
      hasClogContent,
      noShutoffInClog,
      snippet: clogText.slice(0, 200),
    });
  }

  const leakSOP = getFallbackSOP("plumbing", false, "leak");
  const leakText = leakSOP.display;
  if (leakText.toLowerCase().includes("shut-off")) {
    pass("getFallbackSOP: plumbing + leak → leak SOP (has shut-off)");
  } else {
    fail("getFallbackSOP: plumbing + leak should use leak SOP", leakText.slice(0, 200));
  }

  const genericPlumbingSOP = getFallbackSOP("plumbing", false);
  const genericPlumbingText = genericPlumbingSOP.display;
  if (genericPlumbingText.includes("leak")) {
    pass("getFallbackSOP: plumbing + no subcategory → generic plumbing SOP");
  } else {
    fail("getFallbackSOP: plumbing alone should use generic plumbing SOP", genericPlumbingText.slice(0, 200));
  }

  // ── shouldUseGuidedTroubleshooting: plumbing_broken_fixture SOP → guided ──
  const brokenFixtureGuidedSteps = convertToGuidedSteps(brokenFixtureSOP.steps);
  if (shouldUseGuidedTroubleshooting(brokenFixtureGuidedSteps, false)) {
    pass("shouldUseGuided: plumbing_broken_fixture fallback SOP → guided (has actionable steps)");
  } else {
    fail("shouldUseGuided: plumbing_broken_fixture fallback SOP should enter guided mode", {
      kinds: brokenFixtureGuidedSteps.map(s => s.step_kind),
    });
  }

  // ── getCanonicalEquipment ──

  if (getCanonicalEquipment("stove") === "oven") {
    pass("getCanonicalEquipment: 'stove' → 'oven'");
  } else {
    fail("getCanonicalEquipment: 'stove' should → 'oven'", getCanonicalEquipment("stove"));
  }

  if (getCanonicalEquipment("range") === "oven") {
    pass("getCanonicalEquipment: 'range' → 'oven'");
  } else {
    fail("getCanonicalEquipment: 'range' should → 'oven'", getCanonicalEquipment("range"));
  }

  if (getCanonicalEquipment("oven") === "oven") {
    pass("getCanonicalEquipment: 'oven' → 'oven' (already canonical)");
  } else {
    fail("getCanonicalEquipment: 'oven' should → 'oven'", getCanonicalEquipment("oven"));
  }

  if (getCanonicalEquipment("fridge") === "refrigerator") {
    pass("getCanonicalEquipment: 'fridge' → 'refrigerator'");
  } else {
    fail("getCanonicalEquipment: 'fridge' should → 'refrigerator'", getCanonicalEquipment("fridge"));
  }

  if (getCanonicalEquipment("freezer") === "refrigerator") {
    pass("getCanonicalEquipment: 'freezer' → 'refrigerator'");
  } else {
    fail("getCanonicalEquipment: 'freezer' should → 'refrigerator'", getCanonicalEquipment("freezer"));
  }

  if (getCanonicalEquipment("hood fan") === "range hood") {
    pass("getCanonicalEquipment: 'hood fan' → 'range hood'");
  } else {
    fail("getCanonicalEquipment: 'hood fan' should → 'range hood'", getCanonicalEquipment("hood fan"));
  }

  // ── SOP alias resolution ──

  const stoveSOP = getFallbackSOP("appliance", false, null, "stove");
  const stoveText = stoveSOP.display;
  if (stoveText.includes("heating element") && !stoveText.includes("refrigerator")) {
    pass("getFallbackSOP: equipment='stove' → oven SOP (has heating element, no refrigerator)");
  } else {
    fail("getFallbackSOP: equipment='stove' should use oven SOP", stoveText.slice(0, 200));
  }

  const rangeSOP = getFallbackSOP("appliance", false, null, "range");
  const rangeText = rangeSOP.display;
  if (rangeText.includes("heating element")) {
    pass("getFallbackSOP: equipment='range' → oven SOP (has heating element)");
  } else {
    fail("getFallbackSOP: equipment='range' should use oven SOP", rangeText.slice(0, 200));
  }

  const fridgeSOP = getFallbackSOP("appliance", false, null, "fridge");
  const fridgeText = fridgeSOP.display;
  if (fridgeText.includes("temperature") && fridgeText.includes("door seal")) {
    pass("getFallbackSOP: equipment='fridge' → refrigerator SOP");
  } else {
    fail("getFallbackSOP: equipment='fridge' should use refrigerator SOP", fridgeText.slice(0, 200));
  }

  // ── inferLocationFromEquipment ──

  if (inferLocationFromEquipment("stove is not working") === "kitchen") {
    pass("inferLocation: 'stove is not working' → 'kitchen'");
  } else {
    fail("inferLocation: 'stove is not working' should → 'kitchen'", inferLocationFromEquipment("stove is not working"));
  }

  if (inferLocationFromEquipment("toilet handle is broken") === "bathroom") {
    pass("inferLocation: 'toilet handle is broken' → 'bathroom'");
  } else {
    fail("inferLocation: 'toilet handle is broken' should → 'bathroom'", inferLocationFromEquipment("toilet handle is broken"));
  }

  if (inferLocationFromEquipment("washer won't drain") === "laundry room") {
    pass("inferLocation: 'washer won't drain' → 'laundry room'");
  } else {
    fail("inferLocation: 'washer won't drain' should → 'laundry room'", inferLocationFromEquipment("washer won't drain"));
  }

  if (inferLocationFromEquipment("furnace is making noise") === "basement") {
    pass("inferLocation: 'furnace is making noise' → 'basement'");
  } else {
    fail("inferLocation: 'furnace is making noise' should → 'basement'", inferLocationFromEquipment("furnace is making noise"));
  }

  if (inferLocationFromEquipment("garbage disposal is jammed") === "kitchen") {
    pass("inferLocation: 'garbage disposal is jammed' → 'kitchen'");
  } else {
    fail("inferLocation: 'garbage disposal is jammed' should → 'kitchen'", inferLocationFromEquipment("garbage disposal is jammed"));
  }

  if (inferLocationFromEquipment("the shower is leaking") === "bathroom") {
    pass("inferLocation: 'the shower is leaking' → 'bathroom'");
  } else {
    fail("inferLocation: 'the shower is leaking' should → 'bathroom'", inferLocationFromEquipment("the shower is leaking"));
  }

  if (inferLocationFromEquipment("the dishwasher won't start") === "kitchen") {
    pass("inferLocation: 'the dishwasher won't start' → 'kitchen'");
  } else {
    fail("inferLocation: 'the dishwasher won't start' should → 'kitchen'", inferLocationFromEquipment("the dishwasher won't start"));
  }

  if (inferLocationFromEquipment("something is broken") === null) {
    pass("inferLocation: 'something is broken' → null (no appliance)");
  } else {
    fail("inferLocation: 'something is broken' should → null", inferLocationFromEquipment("something is broken"));
  }

  // Explicit location wins over inferred (extractLocation runs first via ??)
  const explicitLoc = extractLocation("the bathroom stove");
  if (explicitLoc === "bathroom") {
    pass("inferLocation priority: 'the bathroom stove' → extractLocation returns 'bathroom' (explicit wins)");
  } else {
    fail("inferLocation priority: extractLocation('the bathroom stove') should → 'bathroom'", explicitLoc);
  }

  // ── classifyIssue: structural classification for window/screen/door ──

  const structClass1 = classifyIssue("window screen is loose");
  if (structClass1.category === "structural" && (structClass1.confidence === "high" || structClass1.confidence === "medium")) {
    pass("classifyIssue: 'window screen is loose' → structural (high/medium confidence)");
  } else {
    fail("classifyIssue: 'window screen is loose' should → structural", structClass1);
  }

  const structClass2 = classifyIssue("screen is torn");
  if (structClass2.category === "structural") {
    pass("classifyIssue: 'screen is torn' → structural");
  } else {
    fail("classifyIssue: 'screen is torn' should → structural", structClass2);
  }

  const structClass3 = classifyIssue("door is loose");
  if (structClass3.category === "structural") {
    pass("classifyIssue: 'door is loose' → structural");
  } else {
    fail("classifyIssue: 'door is loose' should → structural", structClass3);
  }

  // ── classifyStructural ──

  const structSub1 = classifyStructural("window screen is loose");
  if (structSub1 === "window") {
    pass("classifyStructural: 'window screen is loose' → 'window'");
  } else {
    fail("classifyStructural: 'window screen is loose' should → 'window'", structSub1);
  }

  const structSub2 = classifyStructural("door is stuck");
  if (structSub2 === null) {
    pass("classifyStructural: 'door is stuck' → null");
  } else {
    fail("classifyStructural: 'door is stuck' should → null", structSub2);
  }

  // ── Structural window SOP ──

  const windowSOP = getFallbackSOP("structural", false, "window");
  const windowText = windowSOP.display;
  const hasWindowContent = windowText.includes("spline") || windowText.includes("screen");
  const noSaggingInWindow = !windowText.includes("sagging");
  if (hasWindowContent && noSaggingInWindow) {
    pass("getFallbackSOP: structural + window → window SOP (has spline/screen, no sagging)");
  } else {
    fail("getFallbackSOP: structural + window should use window SOP", {
      hasWindowContent,
      noSaggingInWindow,
      snippet: windowText.slice(0, 200),
    });
  }

  // Generic structural SOP unchanged
  const genericStructSOP2 = getFallbackSOP("structural", false);
  if (genericStructSOP2.display.includes("cracks")) {
    pass("getFallbackSOP: structural + no subcategory → generic structural SOP (unchanged)");
  } else {
    fail("getFallbackSOP: structural alone should still use generic structural SOP", genericStructSOP2.display.slice(0, 200));
  }

  // ── detectSafety: structural no longer in HIGH_RISK_CATEGORIES ──

  const structuralGathered: GatheredInfo = {
    ...buildInitialGathered(),
    category: "structural",
    location_in_unit: "living room",
    started_when: "yesterday",
    current_status: null,
  };

  // "window screen is loose" — no risk indicators → no safety question
  const safetyLoose = detectSafety("window screen is loose", structuralGathered);
  if (!safetyLoose.detected && !safetyLoose.needsQuestion) {
    pass("detectSafety: 'window screen is loose' (structural) → no question (0 risk indicators)");
  } else {
    fail("detectSafety: 'window screen is loose' should not trigger safety question", safetyLoose);
  }

  // "large crack getting worse" — 3 risk indicators → safety question asked
  const safetyCrack = detectSafety("large crack getting worse", structuralGathered);
  if (!safetyCrack.detected && safetyCrack.needsQuestion) {
    pass("detectSafety: 'large crack getting worse' (structural) → question (3 risk indicators)");
  } else {
    fail("detectSafety: 'large crack getting worse' should trigger safety question", safetyCrack);
  }

  // "ceiling is sagging and leaning" — only 1 risk indicator group → no question
  // (sagging + leaning are in the same regex pattern, so matchCount = 1)
  const safetySag = detectSafety("ceiling is sagging and leaning", structuralGathered);
  if (!safetySag.detected && !safetySag.needsQuestion) {
    pass("detectSafety: 'ceiling is sagging and leaning' (structural) → no question (1 pattern group)");
  } else {
    fail("detectSafety: 'ceiling is sagging and leaning' should not trigger safety question (single pattern)", safetySag);
  }

  // "large sagging ceiling" — 2 risk indicator groups → safety question asked
  // (large matches group 1, sagging matches group 2 → matchCount = 2)
  const safetySag2 = detectSafety("large sagging ceiling", structuralGathered);
  if (!safetySag2.detected && safetySag2.needsQuestion) {
    pass("detectSafety: 'large sagging ceiling' (structural) → question (2 pattern groups)");
  } else {
    fail("detectSafety: 'large sagging ceiling' should trigger safety question", safetySag2);
  }

  // Electrical still in HIGH_RISK_CATEGORIES → always gets safety question
  const electricalGathered: GatheredInfo = {
    ...buildInitialGathered(),
    category: "electrical",
    location_in_unit: "living room",
    started_when: "today",
    current_status: null,
  };

  const safetyElectrical = detectSafety("outlet not working", electricalGathered);
  if (!safetyElectrical.detected && safetyElectrical.needsQuestion) {
    pass("detectSafety: 'outlet not working' (electrical) → question (high-risk category)");
  } else {
    fail("detectSafety: electrical should still trigger safety question", safetyElectrical);
  }

  // Electrical with sparks → auto-detected emergency (conditional emergency)
  const safetyElecSparks = detectSafety("sparks from outlet", electricalGathered);
  if (safetyElecSparks.detected && !safetyElecSparks.needsQuestion) {
    pass("detectSafety: 'sparks from outlet' (electrical) → auto-detected emergency");
  } else {
    fail("detectSafety: 'sparks from outlet' should be auto-detected emergency", safetyElecSparks);
  }

  return result;
}

// Standalone execution
if (require.main === module) {
  const { runStandalone } = require("./helpers");
  runStandalone(testPestTriage);
}
