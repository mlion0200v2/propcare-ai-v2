/**
 * Pest triage tests — classifyPest, extractEntryPoint, checkPestEscalation,
 * validateTenantInfo, pest SOP split, recurring status extraction.
 */
import { createRunner, printSection, type TestResult } from "./helpers";
import { classifyPest } from "../../src/lib/triage/classify-issue";
import { extractEntryPoint, extractCurrentStatus } from "../../src/lib/triage/extract-details";
import { checkPestEscalation } from "../../src/lib/triage/detect-safety";
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

  // Mold / general → guided when SOP has actionable steps
  const generalSOP = getFallbackSOP("general", false);
  const generalGuided = convertToGuidedSteps(generalSOP.steps);
  if (shouldUseGuidedTroubleshooting(generalGuided, false)) {
    pass("shouldUseGuided: general/mold fallback SOP → guided (has actionable steps)");
  } else {
    fail("shouldUseGuided: general/mold fallback SOP should enter guided mode", {
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

  return result;
}

// Standalone execution
if (require.main === module) {
  const { runStandalone } = require("./helpers");
  runStandalone(testPestTriage);
}
