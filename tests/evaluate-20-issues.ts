/**
 * Comprehensive evaluation of 20 diverse tenant issue descriptions.
 *
 * Tests the full local pipeline:
 *   classification → extraction → safety detection → SOP steps → guided step conversion
 *
 * Evaluates:
 *   1. Correct category classification
 *   2. Correct detail extraction (location, equipment, timing, etc.)
 *   3. Relevant, actionable SOP troubleshooting steps
 *   4. Steps are tenant-safe and easy to understand
 *   5. Guided step kinds (action vs. observation vs. terminal) are appropriate
 */

import { classifyIssue, classifyPest, classifyPlumbing, classifyMold, classifyStructural, classifyApplianceSymptom, classifyHvacSymptom, classifyLandscaping } from "../src/lib/triage/classify-issue";
import { extractLocation, extractTiming, extractCurrentStatus, extractEquipment, extractEntryPoint, inferLocationFromEquipment, detectEquipmentCorrection, getEquipmentCategory, detectEquipmentAmbiguity } from "../src/lib/triage/extract-details";
import { detectSafety } from "../src/lib/triage/detect-safety";
import { buildAcknowledgement } from "../src/lib/triage/acknowledgement";
import { getFallbackSOP } from "../src/lib/triage/sop-fallback";
import { convertToGuidedSteps, shouldUseGuidedTroubleshooting, filterMediaStepLines } from "../src/lib/triage/grounding";
import type { GatheredInfo } from "../src/lib/triage/types";

// ── Test case definition ──

interface TestCase {
  id: number;
  description: string;
  expectedCategory: string;
  expectedSubcategory?: string | null;
  expectedEquipment?: string | null;
  expectedLocation?: string | null;
  expectedEmergency?: boolean;
  /** Keywords that MUST appear in at least one SOP step */
  stepMustMention?: string[];
  /** Keywords that must NOT appear in any SOP step */
  stepMustNotMention?: string[];
  /** Optional: test a follow-up correction message */
  correctionMessage?: string;
  correctionExpectedEquipment?: string;
  correctionExpectedCategory?: string;
}

const TEST_CASES: TestCase[] = [
  // 1. The bug we just fixed
  {
    id: 1,
    description: "vent leaking oil",
    expectedCategory: "appliance",
    expectedEquipment: null, // "vent" alone isn't in EQUIPMENT_KEYWORDS (ambiguous: HVAC vs range hood)
    expectedLocation: null,
    // Without equipment extraction, falls to generic appliance SOP
    // (range hood SOP requires "range hood" equipment extraction)
    stepMustNotMention: ["shut-off valve", "bucket under"],
  },
  // 2. Fridge making loud noise → noise-specific SOP
  {
    id: 2,
    description: "my fridge is making a really loud buzzing sound since last night",
    expectedCategory: "appliance",
    expectedSubcategory: "noise",
    expectedEquipment: "refrigerator",
    expectedLocation: "kitchen",
    stepMustMention: ["level", "clearance"],
    stepMustNotMention: ["plugged in"],
  },
  // 3. Curtain rod falling off
  {
    id: 3,
    description: "the curtain rod in the bedroom is falling off the wall",
    expectedCategory: "structural",
    expectedLocation: "bedroom",
  },
  // 4. Glass sliding door stuck
  {
    id: 4,
    description: "the glass sliding door is stuck and won't open",
    expectedCategory: "structural",
    stepMustMention: ["photo"],
  },
  // 5. Toilet running non-stop
  {
    id: 5,
    description: "my toilet has been running non-stop since yesterday",
    expectedCategory: "plumbing",
    expectedSubcategory: "running_toilet",
    expectedLocation: "bathroom",
    stepMustMention: ["flapper", "flush handle"],
  },
  // 6. Kitchen sink clogged
  {
    id: 6,
    description: "kitchen sink is clogged and water won't drain",
    expectedCategory: "plumbing",
    expectedSubcategory: "clog",
    expectedLocation: "kitchen",
    stepMustMention: ["plunger"],
    stepMustNotMention: ["shut-off valve"],
  },
  // 7. No hot water
  {
    id: 7,
    description: "we haven't had hot water for two days, only cold water comes out",
    expectedCategory: "plumbing",
    expectedSubcategory: "no_hot_water",
    stepMustMention: ["water heater", "thermostat"],
  },
  // 8. Ants in kitchen
  {
    id: 8,
    description: "I keep seeing ants in my kitchen, mostly around the sink area",
    expectedCategory: "pest_control",
    expectedSubcategory: "ants",
    expectedLocation: "kitchen",
    stepMustMention: ["sealed containers", "bait"],
    stepMustNotMention: ["snap trap"],
  },
  // 9. Mold in bathroom
  {
    id: 9,
    description: "there's black mold growing on the bathroom ceiling",
    expectedCategory: "structural",
    expectedSubcategory: "mold",
    expectedLocation: "bathroom",
    stepMustMention: ["ventilation", "moisture"],
  },
  // 10. Outlet not working
  {
    id: 10,
    description: "the outlet in the living room stopped working, nothing turns on when I plug things in",
    expectedCategory: "electrical",
    expectedLocation: "living room",
    stepMustMention: ["breaker"],
    stepMustNotMention: ["plumber"],
  },
  // 11. Dishwasher leaking
  {
    id: 11,
    description: "my dishwasher is leaking water onto the kitchen floor",
    expectedCategory: "appliance",
    expectedEquipment: "dishwasher",
    expectedLocation: "kitchen",
    stepMustMention: ["dishwasher"],
  },
  // 12. Window screen torn
  {
    id: 12,
    description: "the window screen in the bedroom is torn and bugs are getting in",
    expectedCategory: "structural",
    expectedSubcategory: "window",
    expectedLocation: "bedroom",
    stepMustMention: ["screen", "spline"],
  },
  // 13. AC not cooling
  {
    id: 13,
    description: "the AC unit is running but not cooling, it's been really hot in here for a week",
    expectedCategory: "hvac",
    stepMustMention: ["thermostat", "air filter"],
  },
  // 14. Garbage disposal jammed
  {
    id: 14,
    description: "the garbage disposal is jammed and just hums when I turn it on",
    expectedCategory: "appliance",
    expectedEquipment: "garbage disposal",
    expectedLocation: "kitchen",
    stepMustMention: ["hex key", "reset"],
  },
  // 15. Lock broken
  {
    id: 15,
    description: "the front door lock is broken, the key won't turn",
    expectedCategory: "locksmith",
    stepMustMention: ["lock"],
  },
  // 16. Ceiling leak from rain
  {
    id: 16,
    description: "water is dripping from the ceiling in the hallway when it rains",
    expectedCategory: "roofing",
    expectedLocation: "hallway",
    stepMustMention: ["bucket"],
  },
  // 17. Paint peeling
  {
    id: 17,
    description: "the paint on the bathroom walls is peeling and bubbling",
    expectedCategory: "painting",
    expectedLocation: "bathroom",
    stepMustMention: ["peeling"],
  },
  // 18. Dryer not heating
  {
    id: 18,
    description: "my dryer runs but doesn't heat up, clothes are still wet after a full cycle",
    expectedCategory: "appliance",
    expectedEquipment: "dryer",
    expectedLocation: "laundry room",
    stepMustMention: ["lint", "vent"],
  },
  // 19. Gas smell (emergency)
  {
    id: 19,
    description: "I smell gas near the stove in the kitchen",
    expectedCategory: "appliance",
    expectedEquipment: "oven", // "stove" normalizes to "oven" via EQUIPMENT_ALIASES
    expectedLocation: "kitchen",
    expectedEmergency: true,
  },
  // 20. Range hood dripping grease (compound)
  {
    id: 20,
    description: "the range hood above my stove is dripping grease when I cook",
    expectedCategory: "appliance",
    expectedEquipment: "range hood",
    expectedLocation: "kitchen",
    stepMustMention: ["grease filter", "soak"],
  },
  // 21. AC making rattling noise → HVAC noise SOP
  {
    id: 21,
    description: "my AC is making a loud rattling noise",
    expectedCategory: "hvac",
    expectedSubcategory: "noise",
    expectedEquipment: "air conditioner",
    stepMustMention: ["filter", "vent"],
    stepMustNotMention: ["thermostat"],
  },
  // 22. Washer leaking → appliance leak symptom
  {
    id: 22,
    description: "the washer is leaking water all over the laundry room floor",
    expectedCategory: "appliance",
    expectedSubcategory: "leak",
    expectedEquipment: "washer",
    expectedLocation: "laundry room",
  },
  // 23. Fridge not cooling → appliance temperature symptom (uses generic refrigerator SOP)
  {
    id: 23,
    description: "my fridge is not cooling, the food is getting warm",
    expectedCategory: "appliance",
    expectedSubcategory: "temperature",
    expectedEquipment: "refrigerator",
    expectedLocation: "kitchen",
  },
  // 24. Multi-equipment: fridge vibrating + AC mention
  {
    id: 24,
    description: "fridge making loud vibration noises, happens more when AC is on",
    expectedCategory: "appliance",
    expectedSubcategory: "noise",
    expectedEquipment: "refrigerator",
    expectedLocation: "kitchen",
    stepMustMention: ["level", "clearance"],
    stepMustNotMention: ["plugged in"],
  },
  // 25. Bare "AC" triggers HVAC classification
  {
    id: 25,
    description: "the AC is blowing warm air, it's not cooling at all",
    expectedCategory: "hvac",
    expectedSubcategory: "temperature",
    expectedEquipment: "air conditioner",
    stepMustMention: ["thermostat"],
  },
  // 26. Puddle in front yard → landscaping/water_pooling, location="front yard"
  {
    id: 26,
    description: "puddle of water under the bushes in the front yard",
    expectedCategory: "landscaping",
    expectedSubcategory: "water_pooling",
    expectedLocation: "front yard",
    stepMustMention: ["sprinkler", "downspout"],
  },
  // 27. Tree branch fell in back yard → landscaping/tree_hazard
  {
    id: 27,
    description: "tree branch fell in the back yard",
    expectedCategory: "landscaping",
    expectedSubcategory: "tree_hazard",
    expectedLocation: "back yard",
    stepMustMention: ["cut", "photo"],
    stepMustNotMention: ["sprinkler"],
  },
  // 28. Broken sprinkler → landscaping/irrigation
  {
    id: 28,
    description: "sprinkler is broken and flooding the side yard",
    expectedCategory: "landscaping",
    expectedSubcategory: "irrigation",
    expectedLocation: "side yard",
    stepMustMention: ["sprinkler head", "shut-off"],
  },
];

// ── Correction test cases (test detectEquipmentCorrection) ──

interface CorrectionTestCase {
  id: number;
  message: string;
  currentEquipment: string | null;
  currentCategory: string;
  expectedDetected: boolean;
  expectedEquipment?: string | null;
}

const CORRECTION_TESTS: CorrectionTestCase[] = [
  {
    id: 1,
    message: "it's not the sink, it's the range hood dripping oil",
    currentEquipment: null,
    currentCategory: "plumbing",
    expectedDetected: true,
    expectedEquipment: "range hood",
  },
  {
    id: 2,
    message: "it's range hood dripping oil",
    currentEquipment: null,
    currentCategory: "plumbing",
    expectedDetected: true,
    expectedEquipment: "range hood",
  },
  {
    id: 3,
    message: "actually it's the dishwasher, not the sink",
    currentEquipment: null,
    currentCategory: "plumbing",
    expectedDetected: true,
    expectedEquipment: "dishwasher",
  },
  {
    id: 4,
    message: "the problem is with my range hood",
    currentEquipment: null,
    currentCategory: "plumbing",
    expectedDetected: true,
    expectedEquipment: "range hood",
  },
  {
    id: 5,
    message: "yes I tried that, still dripping",
    currentEquipment: "range hood",
    currentCategory: "appliance",
    expectedDetected: false,
    expectedEquipment: null,
  },
  {
    id: 6,
    message: "it's still leaking",
    currentEquipment: null,
    currentCategory: "plumbing",
    expectedDetected: false,
    expectedEquipment: null,
  },
];

// ── Runner ──

function buildGathered(
  category: string,
  description: string,
  subcategory: string | null = null,
  equipment: string | null = null,
  location: string | null = null,
  isEmergency: boolean | null = null,
): GatheredInfo {
  return {
    category,
    location_in_unit: location ?? extractLocation(description) ?? inferLocationFromEquipment(description),
    started_when: extractTiming(description),
    is_emergency: isEmergency,
    current_status: extractCurrentStatus(description),
    brand_model: null,
    subcategory,
    entry_point: extractEntryPoint(description),
    equipment: equipment ?? extractEquipment(description),
  };
}

interface EvalResult {
  id: number;
  description: string;
  passed: boolean;
  issues: string[];
  details: {
    classifiedCategory: string;
    classifiedConfidence: string;
    subcategory: string | null;
    equipment: string | null;
    location: string | null;
    timing: string | null;
    isEmergency: boolean;
    safetyDetected: boolean;
    safetyNeedsQuestion: boolean;
    acknowledgement: string;
    sopStepCount: number;
    sopSteps: string[];
    guidedMode: boolean;
    guidedStepKinds: string[];
  };
}

function evaluateCase(tc: TestCase): EvalResult {
  const issues: string[] = [];

  // 1. Classify
  const classification = classifyIssue(tc.description);

  if (classification.category !== tc.expectedCategory) {
    issues.push(`CATEGORY: expected "${tc.expectedCategory}", got "${classification.category}" (${classification.rationale})`);
  }

  // 2. Subcategory
  let subcategory: string | null = null;
  if (classification.category === "pest_control") {
    subcategory = classifyPest(tc.description)?.species ?? null;
  } else if (classification.category === "plumbing") {
    subcategory = classifyPlumbing(tc.description);
  } else if (classification.category === "structural") {
    subcategory = classifyMold(tc.description) ?? classifyStructural(tc.description);
  } else if (classification.category === "appliance") {
    subcategory = classifyApplianceSymptom(tc.description);
  } else if (classification.category === "hvac") {
    subcategory = classifyHvacSymptom(tc.description);
  } else if (classification.category === "landscaping") {
    subcategory = classifyLandscaping(tc.description);
  }

  if (tc.expectedSubcategory !== undefined && subcategory !== tc.expectedSubcategory) {
    issues.push(`SUBCATEGORY: expected "${tc.expectedSubcategory}", got "${subcategory}"`);
  }

  // 3. Equipment
  const equipment = extractEquipment(tc.description);
  if (tc.expectedEquipment !== undefined && equipment !== tc.expectedEquipment) {
    issues.push(`EQUIPMENT: expected "${tc.expectedEquipment}", got "${equipment}"`);
  }

  // 4. Location
  const location = extractLocation(tc.description) ?? inferLocationFromEquipment(tc.description);
  if (tc.expectedLocation !== undefined && location !== tc.expectedLocation) {
    issues.push(`LOCATION: expected "${tc.expectedLocation}", got "${location}"`);
  }

  // 5. Build gathered info for safety + SOP
  const gathered = buildGathered(
    classification.category,
    tc.description,
    subcategory,
    equipment,
    location,
  );

  // 6. Safety detection
  const safety = detectSafety(tc.description, gathered);
  const isEmergency = safety.detected || (tc.expectedEmergency ?? false);
  gathered.is_emergency = isEmergency;

  if (tc.expectedEmergency !== undefined) {
    // Check if the emergency was auto-detected (or at least flagged for question)
    if (tc.expectedEmergency && !safety.detected && !safety.needsQuestion) {
      issues.push(`EMERGENCY: expected emergency detection but got neither detected nor needsQuestion`);
    }
  }

  // 7. Acknowledgement
  const timing = extractTiming(tc.description);
  const status = extractCurrentStatus(tc.description);
  const ack = buildAcknowledgement(tc.description, { timing, status });

  // 8. SOP steps (pass subcategory as symptom for appliance/hvac)
  const sop = getFallbackSOP(classification.category, isEmergency, subcategory, equipment, subcategory);

  // 9. Check step content requirements
  if (tc.stepMustMention) {
    for (const keyword of tc.stepMustMention) {
      const found = sop.steps.some(s => s.description.toLowerCase().includes(keyword.toLowerCase()));
      if (!found) {
        issues.push(`STEP_MISSING: expected steps to mention "${keyword}" but none do`);
      }
    }
  }

  if (tc.stepMustNotMention) {
    for (const keyword of tc.stepMustNotMention) {
      const found = sop.steps.find(s => s.description.toLowerCase().includes(keyword.toLowerCase()));
      if (found) {
        issues.push(`STEP_UNWANTED: step should NOT mention "${keyword}" but found: "${found.description.slice(0, 60)}..."`);
      }
    }
  }

  // 10. Guided step conversion
  const guidedSteps = convertToGuidedSteps(sop.steps);
  const guidedMode = shouldUseGuidedTroubleshooting(guidedSteps, isEmergency);
  const guidedStepKinds = guidedSteps.map(s => s.step_kind);

  // Quality checks on steps
  for (const step of sop.steps) {
    if (step.description.length > 200) {
      issues.push(`STEP_TOO_LONG: "${step.description.slice(0, 60)}..." (${step.description.length} chars)`);
    }
    if (/\[SOP-\d+\]/.test(step.description)) {
      issues.push(`STEP_RAW_CITATION: "${step.description.slice(0, 60)}..."`);
    }
  }

  return {
    id: tc.id,
    description: tc.description,
    passed: issues.length === 0,
    issues,
    details: {
      classifiedCategory: classification.category,
      classifiedConfidence: classification.confidence,
      subcategory,
      equipment,
      location,
      timing,
      isEmergency,
      safetyDetected: safety.detected,
      safetyNeedsQuestion: safety.needsQuestion,
      acknowledgement: ack,
      sopStepCount: sop.steps.length,
      sopSteps: sop.steps.map(s => s.description),
      guidedMode,
      guidedStepKinds,
    },
  };
}

function evaluateCorrection(tc: CorrectionTestCase): { passed: boolean; issues: string[] } {
  const issues: string[] = [];
  const result = detectEquipmentCorrection(tc.message, tc.currentEquipment);

  if (result.detected !== tc.expectedDetected) {
    issues.push(`CORRECTION_DETECTED: expected ${tc.expectedDetected}, got ${result.detected}`);
  }

  if (tc.expectedEquipment !== undefined && result.equipment !== tc.expectedEquipment) {
    issues.push(`CORRECTION_EQUIPMENT: expected "${tc.expectedEquipment}", got "${result.equipment}"`);
  }

  if (result.detected && result.equipment) {
    const category = getEquipmentCategory(result.equipment);
    if (category && category !== tc.currentCategory) {
      // Verify category change is correct
    } else if (tc.expectedDetected && tc.expectedEquipment && !category) {
      issues.push(`CORRECTION_CATEGORY: no category mapped for "${result.equipment}"`);
    }
  }

  return { passed: issues.length === 0, issues };
}

// ── Main ──

function main() {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║  20-Issue Triage Evaluation Suite                           ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  let passCount = 0;
  let failCount = 0;
  const allResults: EvalResult[] = [];

  for (const tc of TEST_CASES) {
    const result = evaluateCase(tc);
    allResults.push(result);

    const status = result.passed ? "\x1b[32m✓ PASS\x1b[0m" : "\x1b[31m✗ FAIL\x1b[0m";
    console.log(`${status}  #${tc.id}: "${tc.description}"`);
    console.log(`       Category: ${result.details.classifiedCategory} (${result.details.classifiedConfidence})`);
    if (result.details.subcategory) console.log(`       Subcategory: ${result.details.subcategory}`);
    if (result.details.equipment) console.log(`       Equipment: ${result.details.equipment}`);
    if (result.details.location) console.log(`       Location: ${result.details.location}`);
    if (result.details.timing) console.log(`       Timing: ${result.details.timing}`);
    console.log(`       Emergency: ${result.details.isEmergency} | Safety detected: ${result.details.safetyDetected} | Needs question: ${result.details.safetyNeedsQuestion}`);
    console.log(`       Guided mode: ${result.details.guidedMode} | Steps: ${result.details.sopStepCount} (${result.details.guidedStepKinds.join(", ")})`);

    if (!result.passed) {
      for (const issue of result.issues) {
        console.log(`       \x1b[31m→ ${issue}\x1b[0m`);
      }
      failCount++;
    } else {
      passCount++;
    }

    // Show acknowledgement
    console.log(`       Ack: "${result.details.acknowledgement.split("\n")[0]}"`);

    // Show steps (abbreviated)
    for (const step of result.details.sopSteps) {
      console.log(`       Step: ${step.slice(0, 100)}${step.length > 100 ? "..." : ""}`);
    }
    console.log();
  }

  // ── Multi-equipment ambiguity tests ──
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║  Multi-Equipment Ambiguity Tests                            ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  {
    const ambiguityTests = [
      { text: "fridge making loud vibration noises, happens more when AC is on", expectCandidates: ["refrigerator", "air conditioner"], expectAmbiguous: true },
      { text: "my fridge is making a buzzing sound", expectCandidates: ["refrigerator"], expectAmbiguous: false },
      { text: "the stove and microwave both stopped working", expectCandidates: ["oven", "microwave"], expectAmbiguous: false },
    ];

    for (const at of ambiguityTests) {
      const result = detectEquipmentAmbiguity(at.text);
      const candidatesOk = at.expectCandidates.every(c => result.candidates.includes(c)) && result.candidates.length === at.expectCandidates.length;
      const ambiguousOk = result.ambiguous === at.expectAmbiguous;
      const ok = candidatesOk && ambiguousOk;

      if (ok) {
        console.log(`\x1b[32m✓ PASS\x1b[0m  "${at.text}" → [${result.candidates.join(", ")}] ambiguous=${result.ambiguous}`);
        passCount++;
      } else {
        console.log(`\x1b[31m✗ FAIL\x1b[0m  "${at.text}"`);
        if (!candidatesOk) console.log(`       \x1b[31m→ CANDIDATES: expected [${at.expectCandidates.join(", ")}], got [${result.candidates.join(", ")}]\x1b[0m`);
        if (!ambiguousOk) console.log(`       \x1b[31m→ AMBIGUOUS: expected ${at.expectAmbiguous}, got ${result.ambiguous}\x1b[0m`);
        failCount++;
      }
    }
    console.log();
  }

  // ── Correction tests ──
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║  Equipment Correction Detection Tests                       ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  let corrPass = 0;
  let corrFail = 0;

  for (const tc of CORRECTION_TESTS) {
    const result = evaluateCorrection(tc);
    const status = result.passed ? "\x1b[32m✓ PASS\x1b[0m" : "\x1b[31m✗ FAIL\x1b[0m";
    console.log(`${status}  Correction #${tc.id}: "${tc.message}" (current: ${tc.currentEquipment ?? "none"})`);
    if (!result.passed) {
      for (const issue of result.issues) {
        console.log(`       \x1b[31m→ ${issue}\x1b[0m`);
      }
      corrFail++;
    } else {
      corrPass++;
    }
  }

  // ── Summary ──
  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║  SUMMARY                                                    ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log(`  Issue Classification: ${passCount} passed, ${failCount} failed / ${TEST_CASES.length} total`);
  console.log(`  Correction Detection: ${corrPass} passed, ${corrFail} failed / ${CORRECTION_TESTS.length} total`);
  console.log(`  Overall: ${passCount + corrPass} passed, ${failCount + corrFail} failed\n`);

  if (failCount + corrFail > 0) {
    console.log("  \x1b[31mSome tests failed — see issues above.\x1b[0m\n");
    process.exit(1);
  } else {
    console.log("  \x1b[32mAll tests passed!\x1b[0m\n");
  }
}

main();
