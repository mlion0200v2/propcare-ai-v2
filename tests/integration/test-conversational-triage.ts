/**
 * Tests for the conversational triage refactor.
 *
 * Pure tests — no Supabase, no network calls.
 * Tests: classify-issue, detect-safety, acknowledgement,
 * no category menu, targeted safety question, conversational output.
 */

import {
  createRunner,
  printSection,
  type TestResult,
} from "./helpers";
import {
  classifyIssue,
  parseClarifyingResponse,
  buildClarifyingCategoryQuestion,
} from "../../src/lib/triage/classify-issue";
import {
  detectSafety,
  parseSafetyResponse,
} from "../../src/lib/triage/detect-safety";
import {
  buildAcknowledgement,
} from "../../src/lib/triage/acknowledgement";
import {
  step,
  buildInitialReply,
  buildInitialReplyWithClarification,
  buildInitialGathered,
  stepTenantInfo,
  buildInitialTenantInfo,
  getNextMissingField,
  QUESTIONS,
} from "../../src/lib/triage/state-machine";
import { extractLocation, extractTiming, extractCurrentStatus, extractEquipment, detectEquipmentCorrection } from "../../src/lib/triage/extract-details";
import { getFallbackSOP } from "../../src/lib/triage/sop-fallback";
import { filterStepsByEquipment, convertToGuidedSteps, shouldUseGuidedTroubleshooting } from "../../src/lib/triage/grounding";
import {
  classifyStepFeedback,
  determineNextAction,
  buildHelpReply,
} from "../../src/lib/triage/step-feedback";
import type { GuidedStep, GuidedTroubleshootingState } from "../../src/lib/triage/types";
import {
  isGatherComplete,
  getNextExtendedQuestion,
  getExtendedQuestionText,
} from "../../src/lib/triage/gather-issue";
import type { TriageContext, GatheredInfo } from "../../src/lib/triage/types";

export function testConversationalTriage(): TestResult {
  // ══════════════════════════════════════════════════════
  // Issue Classification
  // ══════════════════════════════════════════════════════
  printSection("Issue Classification — Auto-classify");
  const { pass, fail, result } = createRunner();

  // ── High-confidence classification ──

  try {
    const r = classifyIssue("my faucet is leaking");
    if (r.category === "plumbing") {
      pass("classifyIssue: 'my faucet is leaking' → plumbing");
    } else {
      fail("classifyIssue: expected plumbing", r);
    }
    if (r.confidence === "high") {
      pass("classifyIssue: faucet leaking → high confidence");
    } else {
      fail("classifyIssue: expected high confidence", r.confidence);
    }
  } catch (e) {
    fail("classifyIssue plumbing threw", e);
  }

  try {
    const r = classifyIssue("the outlet in my bedroom stopped working");
    if (r.category === "electrical") {
      pass("classifyIssue: outlet not working → electrical");
    } else {
      fail("classifyIssue: expected electrical", r);
    }
  } catch (e) {
    fail("classifyIssue electrical threw", e);
  }

  try {
    const r = classifyIssue("my AC unit is not cooling and making a loud noise");
    if (r.category === "hvac") {
      pass("classifyIssue: AC not cooling → hvac");
    } else {
      fail("classifyIssue: expected hvac", r);
    }
  } catch (e) {
    fail("classifyIssue hvac threw", e);
  }

  try {
    const r = classifyIssue("there are roaches in the kitchen");
    if (r.category === "pest_control") {
      pass("classifyIssue: roaches → pest_control");
    } else {
      fail("classifyIssue: expected pest_control", r);
    }
  } catch (e) {
    fail("classifyIssue pest_control threw", e);
  }

  try {
    const r = classifyIssue("the refrigerator is not getting cold");
    if (r.category === "appliance") {
      pass("classifyIssue: refrigerator → appliance");
    } else {
      fail("classifyIssue: expected appliance", r);
    }
  } catch (e) {
    fail("classifyIssue appliance threw", e);
  }

  // ── Appliance misclassification guard ──

  try {
    const r = classifyIssue("my range hood is dripping oil");
    if (r.category === "appliance") {
      pass("classifyIssue: 'my range hood is dripping oil' → appliance");
    } else {
      fail("classifyIssue: expected appliance for range hood dripping oil", r);
    }
  } catch (e) {
    fail("classifyIssue range hood dripping oil threw", e);
  }

  try {
    const r = classifyIssue("range hood leaking grease");
    if (r.category === "appliance") {
      pass("classifyIssue: 'range hood leaking grease' → appliance");
    } else {
      fail("classifyIssue: expected appliance for range hood leaking grease", r);
    }
  } catch (e) {
    fail("classifyIssue range hood leaking grease threw", e);
  }

  try {
    const r = classifyIssue("stove dripping oil");
    if (r.category === "appliance") {
      pass("classifyIssue: 'stove dripping oil' → appliance");
    } else {
      fail("classifyIssue: expected appliance for stove dripping oil", r);
    }
  } catch (e) {
    fail("classifyIssue stove dripping oil threw", e);
  }

  // ── Plumbing still works for actual plumbing ──

  try {
    const r = classifyIssue("kitchen sink is dripping");
    if (r.category === "plumbing") {
      pass("classifyIssue: 'kitchen sink is dripping' → plumbing");
    } else {
      fail("classifyIssue: expected plumbing for kitchen sink dripping", r);
    }
  } catch (e) {
    fail("classifyIssue kitchen sink dripping threw", e);
  }

  try {
    const r = classifyIssue("faucet is leaking");
    if (r.category === "plumbing") {
      pass("classifyIssue: 'faucet is leaking' → plumbing (still works)");
    } else {
      fail("classifyIssue: expected plumbing for faucet leaking", r);
    }
  } catch (e) {
    fail("classifyIssue faucet leaking guard threw", e);
  }

  // ── Low-confidence classification ──

  try {
    const r = classifyIssue("something is wrong");
    if (r.confidence === "low") {
      pass("classifyIssue: 'something is wrong' → low confidence");
    } else {
      fail("classifyIssue: expected low confidence for vague description", r.confidence);
    }
  } catch (e) {
    fail("classifyIssue low confidence threw", e);
  }

  // ── No category menu shown when confidence is high ──

  try {
    const description = "my sink is leaking in the kitchen";
    const classification = classifyIssue(description);
    const gathered = buildInitialGathered();

    // With high confidence, category should be set directly
    if (classification.confidence === "high" || classification.confidence === "medium") {
      gathered.category = classification.category;
    }

    // Extract location from description
    const loc = extractLocation(description);
    if (loc) gathered.location_in_unit = loc;

    const ack = buildAcknowledgement(description);
    const nextField = getNextMissingField(gathered) ?? "started_when";
    const reply = buildInitialReply(ack, QUESTIONS[nextField]);

    // The reply should NOT contain a numbered category list
    if (!reply.includes("Reply with a number")) {
      pass("no category menu shown when classification confidence is high");
    } else {
      fail("category menu shown despite high confidence", reply.slice(0, 200));
    }

    // Location was extracted from "in the kitchen", so reply should ask started_when
    if (reply.includes("When did this start")) {
      pass("reply asks started_when when location already extracted from description");
    } else {
      fail("reply should ask started_when, not location", reply.slice(0, 200));
    }
  } catch (e) {
    fail("no category menu test threw", e);
  }

  // ── When no location in message, still asks location_in_unit ──

  try {
    const description = "my faucet is leaking";
    const gathered = buildInitialGathered();
    gathered.category = "plumbing";

    const loc = extractLocation(description);
    if (loc) gathered.location_in_unit = loc;

    const ack = buildAcknowledgement(description);
    const nextField = getNextMissingField(gathered) ?? "started_when";
    const reply = buildInitialReply(ack, QUESTIONS[nextField]);

    if (reply.includes("Where in your unit")) {
      pass("reply asks location_in_unit when no location found in description");
    } else {
      fail("reply should ask location when not extracted", reply.slice(0, 200));
    }
  } catch (e) {
    fail("no-location fallback test threw", e);
  }

  // ── Clarifying question for low confidence ──

  try {
    const q = buildClarifyingCategoryQuestion("something is wrong", ["general"]);
    if (q.includes("type of issue") || q.includes("plumbing") || q.includes("route this correctly")) {
      pass("buildClarifyingCategoryQuestion returns a natural question");
    } else {
      fail("buildClarifyingCategoryQuestion unexpected output", q);
    }
  } catch (e) {
    fail("buildClarifyingCategoryQuestion threw", e);
  }

  // ── Parse clarifying response ──

  try {
    const prev = { category: "general" as const, confidence: "low" as const, rationale: "test" };
    const r = parseClarifyingResponse("plumbing", prev);
    if (r.category === "plumbing" && r.confidence === "high") {
      pass("parseClarifyingResponse: direct name match works");
    } else {
      fail("parseClarifyingResponse: direct match failed", r);
    }
  } catch (e) {
    fail("parseClarifyingResponse threw", e);
  }

  try {
    const prev = { category: "plumbing" as const, confidence: "medium" as const, rationale: "test" };
    const r = parseClarifyingResponse("yes", prev);
    if (r.category === "plumbing" && r.confidence === "high") {
      pass("parseClarifyingResponse: affirmative confirms previous category");
    } else {
      fail("parseClarifyingResponse: affirmative failed", r);
    }
  } catch (e) {
    fail("parseClarifyingResponse affirmative threw", e);
  }

  // ══════════════════════════════════════════════════════
  // Safety Detection
  // ══════════════════════════════════════════════════════
  printSection("Safety Detection — Targeted questions");

  // ── Auto-detection from keywords ──

  try {
    const gathered: GatheredInfo = {
      ...buildInitialGathered(),
      category: "plumbing",
      location_in_unit: "kitchen",
    };
    const r = detectSafety("I smell gas in my kitchen", gathered);
    if (r.detected && !r.needsQuestion) {
      pass("detectSafety: 'smell gas' auto-detected as emergency");
    } else {
      fail("detectSafety: expected auto-detection", r);
    }
  } catch (e) {
    fail("detectSafety auto-detect threw", e);
  }

  // ── Targeted question for high-risk category ──

  try {
    const gathered: GatheredInfo = {
      ...buildInitialGathered(),
      category: "electrical",
      location_in_unit: "bedroom",
    };
    const r = detectSafety("the outlet doesn't work", gathered);
    if (r.needsQuestion && r.question) {
      pass("detectSafety: electrical issue gets targeted safety question");
    } else {
      fail("detectSafety: expected targeted question for electrical", r);
    }
    if (r.question && (r.question.includes("sparks") || r.question.includes("burning"))) {
      pass("detectSafety: electrical safety question mentions sparks/burning");
    } else {
      fail("detectSafety: electrical question not specific enough", r.question);
    }
  } catch (e) {
    fail("detectSafety electrical threw", e);
  }

  // ── Targeted question instead of generic YES/NO ──

  try {
    const gathered: GatheredInfo = {
      ...buildInitialGathered(),
      category: "plumbing",
      location_in_unit: "bathroom",
    };
    // A serious plumbing issue with risk indicators
    const r = detectSafety("there is a big water leak spreading under the cabinet", gathered);
    if (r.needsQuestion && r.question) {
      if (!r.question.includes("Reply **YES** or **NO**") && !r.question.includes("Reply YES or NO")) {
        pass("targeted safety question does not use generic YES/NO format");
      } else {
        fail("safety question still uses generic YES/NO format", r.question);
      }
    } else if (r.detected) {
      pass("safety auto-detected for serious plumbing issue");
    } else {
      fail("expected either auto-detect or targeted question", r);
    }
  } catch (e) {
    fail("detectSafety targeted question threw", e);
  }

  // ── No safety question for low-risk categories ──

  try {
    const gathered: GatheredInfo = {
      ...buildInitialGathered(),
      category: "painting",
      location_in_unit: "bedroom",
    };
    const r = detectSafety("wall paint is peeling", gathered);
    if (!r.detected && !r.needsQuestion) {
      pass("detectSafety: no safety question for low-risk painting issue");
    } else {
      fail("detectSafety: unexpected safety concern for painting", r);
    }
  } catch (e) {
    fail("detectSafety low-risk threw", e);
  }

  // ── Category+severity: mold is NOT an emergency ──

  try {
    const gathered: GatheredInfo = {
      ...buildInitialGathered(),
      category: "structural",
      location_in_unit: "bathroom",
      current_status: "getting worse",
    };
    const r = detectSafety("mold on bathroom ceiling", gathered);
    if (!r.detected) {
      pass("detectSafety: mold + getting worse → NOT auto-detected as emergency");
    } else {
      fail("detectSafety: mold should NOT be auto-detected as emergency", r);
    }
  } catch (e) {
    fail("detectSafety mold not emergency threw", e);
  }

  // ── Category+severity: dripping water is NOT an emergency ──

  try {
    const gathered: GatheredInfo = {
      ...buildInitialGathered(),
      category: "plumbing",
      location_in_unit: "kitchen",
    };
    const r = detectSafety("faucet is dripping water", gathered);
    if (!r.detected) {
      pass("detectSafety: dripping water → NOT auto-detected as emergency");
    } else {
      fail("detectSafety: dripping should NOT be emergency", r);
    }
  } catch (e) {
    fail("detectSafety dripping not emergency threw", e);
  }

  // ── Category+severity: burst pipe IS an emergency ──

  try {
    const gathered: GatheredInfo = {
      ...buildInitialGathered(),
      category: "plumbing",
      location_in_unit: "kitchen",
    };
    const r = detectSafety("pipe burst and water is pouring everywhere", gathered);
    if (r.detected) {
      pass("detectSafety: burst pipe + pouring → auto-detected as emergency");
    } else {
      fail("detectSafety: burst pipe should be emergency", r);
    }
  } catch (e) {
    fail("detectSafety burst pipe threw", e);
  }

  // ── Category+severity: flooding without active flow is NOT emergency ──

  try {
    const gathered: GatheredInfo = {
      ...buildInitialGathered(),
      category: "plumbing",
      location_in_unit: "bathroom",
    };
    const r = detectSafety("there was some flooding in the bathroom", gathered);
    if (!r.detected) {
      pass("detectSafety: past flooding without active flow → NOT auto-detected");
    } else {
      fail("detectSafety: past flooding should NOT be auto-detected", r);
    }
  } catch (e) {
    fail("detectSafety past flooding threw", e);
  }

  // ── Emergency messages include FortisBC + 2 hours ──

  try {
    const sop = getFallbackSOP("plumbing", true);
    if (sop.display.includes("FortisBC")) {
      pass("emergency SOP: includes FortisBC gas emergency line");
    } else {
      fail("emergency SOP: should include FortisBC", sop.display.slice(0, 300));
    }
    if (!sop.display.includes("call 911") || sop.display.includes("fire or smoke")) {
      pass("emergency SOP: 911 only for fire/smoke, not default");
    } else {
      fail("emergency SOP: should not default to 911", sop.display.slice(0, 300));
    }
  } catch (e) {
    fail("emergency SOP FortisBC test threw", e);
  }

  try {
    const gathered = buildInitialGathered();
    gathered.category = "plumbing";
    gathered.location_in_unit = "Kitchen";
    gathered.is_emergency = true;

    const ctx: TriageContext = {
      triage_state: "GATHER_INFO",
      description: "Gas smell",
      gathered,
      current_question: "started_when",
    };
    const r = step(ctx, "Just now");
    if (r.reply.includes("within 2 hours")) {
      pass("emergency reply: includes 'within 2 hours' for property manager");
    } else {
      fail("emergency reply: should include 'within 2 hours'", r.reply.slice(0, 300));
    }
    if (r.reply.includes("FortisBC")) {
      pass("emergency reply: includes FortisBC for gas");
    } else {
      fail("emergency reply: should include FortisBC", r.reply.slice(0, 300));
    }
    if (r.reply.includes("turn off the main water valve")) {
      pass("emergency reply: includes water valve instruction for flooding");
    } else {
      fail("emergency reply: should include water valve instruction", r.reply.slice(0, 300));
    }
  } catch (e) {
    fail("emergency reply content threw", e);
  }

  // ── parseSafetyResponse ──

  try {
    if (parseSafetyResponse("yes") === true) {
      pass("parseSafetyResponse: 'yes' → true");
    } else {
      fail("parseSafetyResponse: 'yes' should be true");
    }
    if (parseSafetyResponse("no") === false) {
      pass("parseSafetyResponse: 'no' → false");
    } else {
      fail("parseSafetyResponse: 'no' should be false");
    }
    if (parseSafetyResponse("I see sparks") === true) {
      pass("parseSafetyResponse: 'I see sparks' → true");
    } else {
      fail("parseSafetyResponse: 'I see sparks' should be true");
    }
    if (parseSafetyResponse("doesn't seem like it") === false) {
      pass("parseSafetyResponse: negative response → false");
    } else {
      fail("parseSafetyResponse: negative should be false");
    }
  } catch (e) {
    fail("parseSafetyResponse threw", e);
  }

  // ══════════════════════════════════════════════════════
  // Acknowledgement
  // ══════════════════════════════════════════════════════
  printSection("Acknowledgement — Friendly first response");

  try {
    const ack = buildAcknowledgement("my faucet is leaking");
    if (ack.includes("sorry") || ack.includes("sounds like") || ack.includes("hear")) {
      pass("buildAcknowledgement: has empathetic tone");
    } else {
      fail("buildAcknowledgement: missing empathy", ack);
    }
    if (ack.includes("faucet") || ack.includes("leaking")) {
      pass("buildAcknowledgement: reflects the reported issue");
    } else {
      fail("buildAcknowledgement: doesn't reflect issue", ack);
    }
    if (ack.includes("quick questions") || ack.includes("help faster")) {
      pass("buildAcknowledgement: transitions to questions");
    } else {
      fail("buildAcknowledgement: missing transition", ack);
    }
  } catch (e) {
    fail("buildAcknowledgement leaking threw", e);
  }

  try {
    const ack = buildAcknowledgement("the toilet won't flush");
    if (ack.includes("toilet") || ack.includes("flush")) {
      pass("buildAcknowledgement: toilet won't flush reflected");
    } else {
      fail("buildAcknowledgement: toilet issue not reflected", ack);
    }
  } catch (e) {
    fail("buildAcknowledgement toilet threw", e);
  }

  try {
    const ack = buildAcknowledgement("help something is wrong idk");
    if (ack.includes("Thanks for letting us know") || ack.includes("sorry")) {
      pass("buildAcknowledgement: vague issue gets generic empathy");
    } else {
      fail("buildAcknowledgement: vague issue handling", ack);
    }
  } catch (e) {
    fail("buildAcknowledgement vague threw", e);
  }

  // ══════════════════════════════════════════════════════
  // Conversational troubleshooting output
  // ══════════════════════════════════════════════════════
  printSection("Conversational Troubleshooting Output");

  try {
    const sop = getFallbackSOP("plumbing", false);
    // The grounding module now formats conversationally;
    // test that the fallback SOP itself still works
    if (sop.steps.length > 0) {
      pass(`fallback SOP: plumbing returns ${sop.steps.length} steps`);
    } else {
      fail("fallback SOP: no steps returned");
    }
    if (sop.display.includes("Troubleshooting Steps")) {
      pass("fallback SOP: display includes header");
    } else {
      fail("fallback SOP: display missing header", sop.display.slice(0, 100));
    }
  } catch (e) {
    fail("fallback SOP threw", e);
  }

  // ══════════════════════════════════════════════════════
  // State machine — updated flow
  // ══════════════════════════════════════════════════════
  printSection("State Machine — Updated Flow (no category menu)");

  // ── step: with category pre-set, asks location first ──

  try {
    const gathered = buildInitialGathered();
    gathered.category = "plumbing"; // Pre-set by classifier

    const ctx: TriageContext = {
      triage_state: "GATHER_INFO",
      description: "my faucet is leaking",
      gathered,
      current_question: "location_in_unit",
    };

    const r = step(ctx, "Kitchen");
    if (r.gathered.location_in_unit === "Kitchen") {
      pass("step: location collected when category pre-set");
    } else {
      fail("step: location not collected", r.gathered.location_in_unit);
    }
    if (r.current_question === "started_when") {
      pass("step: asks started_when after location");
    } else {
      fail("step: expected started_when next", r.current_question);
    }
  } catch (e) {
    fail("step: pre-set category flow threw", e);
  }

  // ── step: full flow with pre-set category (2 turns → DONE) ──

  try {
    const gathered = buildInitialGathered();
    gathered.category = "plumbing";
    gathered.is_emergency = false; // Pre-set by safety detection

    let ctx: TriageContext = {
      triage_state: "GATHER_INFO",
      description: "leaking faucet",
      gathered,
      current_question: "location_in_unit",
    };

    // Turn 1: location
    let r = step(ctx, "Kitchen");
    ctx = {
      triage_state: r.next_state,
      description: ctx.description,
      gathered: r.gathered,
      current_question: r.current_question,
    };

    // Turn 2: started_when → DONE
    r = step(ctx, "Yesterday");
    if (r.next_state === "DONE") {
      pass("step: full flow with pre-set fields ends in DONE after 2 turns");
    } else {
      fail("step: expected DONE after 2 turns", r.next_state);
    }
  } catch (e) {
    fail("step: full flow with pre-set threw", e);
  }

  // ── stepTenantInfo: transition does NOT include category menu ──

  try {
    const info = buildInitialTenantInfo();
    info.reported_address = "123 Main St";
    info.reported_unit_number = "Unit 4B";
    info.contact_phone = "555-123-4567";

    const r = stepTenantInfo(info, "contact_email", "jane@example.com");
    if (r.next_state === "GATHER_INFO") {
      pass("stepTenantInfo: transitions to GATHER_INFO");
    } else {
      fail("stepTenantInfo: expected GATHER_INFO", r.next_state);
    }
    if (!r.reply.includes("Reply with a number")) {
      pass("stepTenantInfo: transition reply does NOT include numbered category list");
    } else {
      fail("stepTenantInfo: transition reply has numbered list", r.reply.slice(0, 200));
    }
    if (r.reply.includes("Where in your unit") || r.reply.includes("location") || r.current_question === "location_in_unit") {
      pass("stepTenantInfo: transition asks location instead of category");
    } else {
      fail("stepTenantInfo: transition doesn't ask location", { reply: r.reply.slice(0, 100), question: r.current_question });
    }
  } catch (e) {
    fail("stepTenantInfo no-category-menu threw", e);
  }

  // ── emergency keyword auto-detection still works ──

  try {
    const gathered = buildInitialGathered();
    gathered.category = "plumbing";

    const ctx: TriageContext = {
      triage_state: "GATHER_INFO",
      description: "gas leak",
      gathered,
      current_question: "location_in_unit",
    };
    const r = step(ctx, "I smell gas in the kitchen");
    if (r.gathered.is_emergency === true) {
      pass("step: emergency keyword 'gas' still auto-detected");
    } else {
      fail("step: emergency keyword not detected", r.gathered.is_emergency);
    }
  } catch (e) {
    fail("step: emergency keyword threw", e);
  }

  // ══════════════════════════════════════════════════════
  // Media upload/skip path
  // ══════════════════════════════════════════════════════
  printSection("Media Upload — Skip Path");

  // Test that AWAITING_MEDIA is a valid state (type check)
  try {
    const state: import("../../src/lib/triage/types").TriageStateName = "AWAITING_MEDIA";
    if (state === "AWAITING_MEDIA") {
      pass("AWAITING_MEDIA is a valid TriageStateName");
    } else {
      fail("AWAITING_MEDIA type check failed");
    }
  } catch (e) {
    fail("AWAITING_MEDIA type check threw", e);
  }

  // Test classification shape includes new fields
  try {
    const classification: import("../../src/lib/triage/types").TriageClassification = {
      gathered: buildInitialGathered(),
      current_question: null,
      issue_classification: {
        category: "plumbing",
        confidence: "high",
        rationale: "keyword_match",
      },
      safety_detection: {
        detected: false,
        method: "skipped",
        rationale: "low_risk",
      },
      media_refs: ["photo1.jpg"],
    };
    if (classification.issue_classification?.category === "plumbing") {
      pass("TriageClassification: issue_classification field works");
    } else {
      fail("TriageClassification: issue_classification field missing");
    }
    if (classification.safety_detection?.method === "skipped") {
      pass("TriageClassification: safety_detection field works");
    } else {
      fail("TriageClassification: safety_detection field missing");
    }
    if (classification.media_refs?.[0] === "photo1.jpg") {
      pass("TriageClassification: media_refs field works");
    } else {
      fail("TriageClassification: media_refs field missing");
    }
  } catch (e) {
    fail("TriageClassification shape threw", e);
  }

  // ══════════════════════════════════════════════════════
  // Location extraction from initial message
  // ══════════════════════════════════════════════════════
  printSection("Location Extraction — Skip redundant questions");

  // ── Test 1: "my kitchen faucet is leaking" ──

  try {
    const desc = "my kitchen faucet is leaking";
    const loc = extractLocation(desc);
    if (loc === "kitchen") {
      pass("extractLocation: 'my kitchen faucet is leaking' → kitchen");
    } else {
      fail("extractLocation: expected kitchen", loc);
    }

    // Simulates handleFirstMessage: category + location pre-set, next question is started_when
    const gathered = buildInitialGathered();
    const cls = classifyIssue(desc);
    gathered.category = cls.category;
    gathered.location_in_unit = loc;
    const nextField = getNextMissingField(gathered);
    if (nextField === "started_when") {
      pass("location extracted → next question is started_when (skips location)");
    } else {
      fail("expected started_when as next field", nextField);
    }

    const ack = buildAcknowledgement(desc);
    const reply = buildInitialReply(ack, QUESTIONS[nextField!]);
    if (reply.includes("When did this start") && !reply.includes("Where in your unit")) {
      pass("reply asks started_when, does NOT ask location");
    } else {
      fail("reply should ask started_when only", reply.slice(0, 200));
    }
  } catch (e) {
    fail("location extraction test 1 threw", e);
  }

  // ── Test 2: "bathroom outlet is sparking" ──

  try {
    const desc = "bathroom outlet is sparking";
    const loc = extractLocation(desc);
    if (loc === "bathroom") {
      pass("extractLocation: 'bathroom outlet is sparking' → bathroom");
    } else {
      fail("extractLocation: expected bathroom", loc);
    }

    const cls = classifyIssue(desc);
    if (cls.category === "electrical") {
      pass("classifyIssue: 'bathroom outlet is sparking' → electrical");
    } else {
      fail("classifyIssue: expected electrical", cls.category);
    }

    // "sparking" is an emergency keyword
    const gathered = buildInitialGathered();
    gathered.category = cls.category;
    gathered.location_in_unit = loc;

    const safety = detectSafety(desc, gathered);
    if (safety.detected || safety.needsQuestion) {
      pass("safety detection triggered for 'sparking'");
    } else {
      fail("safety detection should trigger for sparking", safety);
    }
  } catch (e) {
    fail("location extraction test 2 threw", e);
  }

  // ── Test 3: "bedroom heater not working" ──

  try {
    const desc = "bedroom heater not working";
    const loc = extractLocation(desc);
    if (loc === "bedroom") {
      pass("extractLocation: 'bedroom heater not working' → bedroom");
    } else {
      fail("extractLocation: expected bedroom", loc);
    }

    const cls = classifyIssue(desc);
    if (cls.category === "hvac") {
      pass("classifyIssue: 'bedroom heater not working' → hvac");
    } else {
      fail("classifyIssue: expected hvac", cls.category);
    }
  } catch (e) {
    fail("location extraction test 3 threw", e);
  }

  // ── Additional locations: multi-word and edge cases ──

  try {
    if (extractLocation("the living room fan is making noise") === "living room") {
      pass("extractLocation: 'living room' multi-word match");
    } else {
      fail("extractLocation: expected living room");
    }

    if (extractLocation("laundry room drain is clogged") === "laundry room") {
      pass("extractLocation: 'laundry room' matches before 'laundry'");
    } else {
      fail("extractLocation: expected laundry room (longest match)");
    }

    if (extractLocation("master bathroom toilet won't flush") === "master bathroom") {
      pass("extractLocation: 'master bathroom' multi-word match");
    } else {
      fail("extractLocation: expected master bathroom");
    }

    if (extractLocation("garage door opener is broken") === "garage") {
      pass("extractLocation: 'garage' extracted");
    } else {
      fail("extractLocation: expected garage");
    }

    if (extractLocation("something is wrong with my place") === null) {
      pass("extractLocation: no location found → null");
    } else {
      fail("extractLocation: should return null for vague description");
    }
  } catch (e) {
    fail("extractLocation edge cases threw", e);
  }

  // ══════════════════════════════════════════════════════
  // Timing extraction from initial message
  // ══════════════════════════════════════════════════════
  printSection("Timing Extraction — Skip redundant questions");

  // ── extractTiming: keyword phrases ──

  try {
    if (extractTiming("yesterday my faucet started leaking") === "yesterday") {
      pass("extractTiming: 'yesterday my faucet...' → yesterday");
    } else {
      fail("extractTiming: expected yesterday");
    }

    if (extractTiming("my faucet started leaking today") === "today") {
      pass("extractTiming: '...leaking today' → today");
    } else {
      fail("extractTiming: expected today");
    }

    if (extractTiming("last night my faucet started dripping") === "last night") {
      pass("extractTiming: 'last night...' → last night");
    } else {
      fail("extractTiming: expected last night");
    }

    if (extractTiming("this morning I noticed a leak in the kitchen") === "this morning") {
      pass("extractTiming: 'this morning...' → this morning");
    } else {
      fail("extractTiming: expected this morning");
    }

    if (extractTiming("a few days ago the toilet started running") === "a few days ago") {
      pass("extractTiming: 'a few days ago...' → a few days ago");
    } else {
      fail("extractTiming: expected a few days ago");
    }

    if (extractTiming("my faucet is leaking") === null) {
      pass("extractTiming: no timing → null");
    } else {
      fail("extractTiming: expected null for no timing");
    }
  } catch (e) {
    fail("extractTiming keyword phrases threw", e);
  }

  // ── extractTiming: "since X" and "for X" regex patterns ──

  try {
    if (extractTiming("the faucet has been dripping since yesterday") === "since yesterday") {
      pass("extractTiming: 'since yesterday' → since yesterday");
    } else {
      fail("extractTiming: expected since yesterday");
    }

    if (extractTiming("my AC hasn't worked for a few days") === "for a few days") {
      pass("extractTiming: 'for a few days' → for a few days");
    } else {
      fail("extractTiming: expected for a few days");
    }

    if (extractTiming("the heater has been broken since last week") === "since last week") {
      pass("extractTiming: 'since last week' → since last week");
    } else {
      fail("extractTiming: expected since last week");
    }
  } catch (e) {
    fail("extractTiming regex patterns threw", e);
  }

  // ══════════════════════════════════════════════════════
  // Current status extraction from initial message
  // ══════════════════════════════════════════════════════
  printSection("Current Status Extraction");

  try {
    if (extractCurrentStatus("my faucet is leaking and it's still happening") === "still happening") {
      pass("extractCurrentStatus: 'still happening' extracted");
    } else {
      fail("extractCurrentStatus: expected still happening");
    }

    if (extractCurrentStatus("the leak comes and goes throughout the day") === "comes and goes") {
      pass("extractCurrentStatus: 'comes and goes' extracted");
    } else {
      fail("extractCurrentStatus: expected comes and goes");
    }

    if (extractCurrentStatus("it's getting worse every day") === "getting worse") {
      pass("extractCurrentStatus: 'getting worse' extracted");
    } else {
      fail("extractCurrentStatus: expected getting worse");
    }

    if (extractCurrentStatus("the dripping is intermittent") === "intermittent") {
      pass("extractCurrentStatus: 'intermittent' extracted");
    } else {
      fail("extractCurrentStatus: expected intermittent");
    }

    if (extractCurrentStatus("the faucet hasn't stopped dripping") === "hasn't stopped") {
      pass("extractCurrentStatus: \"hasn't stopped\" extracted");
    } else {
      fail("extractCurrentStatus: expected hasn't stopped");
    }

    if (extractCurrentStatus("my faucet is leaking") === null) {
      pass("extractCurrentStatus: no status phrase → null");
    } else {
      fail("extractCurrentStatus: expected null for no status");
    }
  } catch (e) {
    fail("extractCurrentStatus threw", e);
  }

  // ══════════════════════════════════════════════════════
  // Multi-field extraction — integration tests
  // ══════════════════════════════════════════════════════
  printSection("Multi-field Extraction — Skip redundant questions");

  // ── Test 1: location + timing extracted → next question is current_status (extended) ──

  try {
    const desc = "yesterday, my kitchen faucet started to leak";
    const loc = extractLocation(desc);
    const timing = extractTiming(desc);
    const status = extractCurrentStatus(desc);

    if (loc === "kitchen") {
      pass("multi-extract: location → kitchen");
    } else {
      fail("multi-extract: expected kitchen", loc);
    }

    if (timing === "yesterday") {
      pass("multi-extract: timing → yesterday");
    } else {
      fail("multi-extract: expected yesterday", timing);
    }

    if (status === null) {
      pass("multi-extract: no status in message → null");
    } else {
      fail("multi-extract: expected null status", status);
    }

    // Simulate handleFirstMessage: category + location + timing pre-set
    const gathered = buildInitialGathered();
    const cls = classifyIssue(desc);
    gathered.category = cls.category;
    gathered.location_in_unit = loc;
    gathered.started_when = timing;

    // All base fields filled → getNextMissingField returns null
    const nextBase = getNextMissingField(gathered);
    if (nextBase === null) {
      pass("multi-extract: all base fields filled → getNextMissingField returns null");
    } else {
      fail("multi-extract: expected null base field", nextBase);
    }

    // Extended field: current_status is next
    const nextExtended = getNextExtendedQuestion(gathered);
    if (nextExtended === "current_status") {
      pass("multi-extract: next extended question is current_status");
    } else {
      fail("multi-extract: expected current_status", nextExtended);
    }

    const ack = buildAcknowledgement(desc, { timing, status });
    const questionText = getExtendedQuestionText(nextExtended!);
    const reply = buildInitialReply(ack, questionText);

    if (reply.includes("current status") && !reply.includes("Where in your unit") && !reply.includes("When did this start")) {
      pass("multi-extract: reply asks current_status, skips location AND started_when");
    } else {
      fail("multi-extract: reply should ask current_status only", reply.slice(0, 300));
    }

    // Acknowledgement should include timing
    if (ack.includes("yesterday")) {
      pass("multi-extract: acknowledgement reflects extracted timing");
    } else {
      fail("multi-extract: acknowledgement should mention yesterday", ack);
    }
  } catch (e) {
    fail("multi-field extraction test 1 threw", e);
  }

  // ── Test 2: location + status extracted, no timing → next question is started_when ──

  try {
    const desc = "my kitchen faucet is leaking and it's still happening";
    const loc = extractLocation(desc);
    const timing = extractTiming(desc);
    const status = extractCurrentStatus(desc);

    if (loc === "kitchen" && timing === null && status === "still happening") {
      pass("extract: kitchen + null timing + still happening");
    } else {
      fail("extract: unexpected values", { loc, timing, status });
    }

    const gathered = buildInitialGathered();
    gathered.category = "plumbing";
    gathered.location_in_unit = loc;
    if (status) gathered.current_status = status;

    // started_when is still missing
    const nextBase = getNextMissingField(gathered);
    if (nextBase === "started_when") {
      pass("location+status: next base field is started_when");
    } else {
      fail("location+status: expected started_when", nextBase);
    }

    const ack = buildAcknowledgement(desc, { timing, status });
    const reply = buildInitialReply(ack, QUESTIONS[nextBase!]);
    if (reply.includes("When did this start") && !reply.includes("Where in your unit")) {
      pass("location+status: reply asks started_when, skips location");
    } else {
      fail("location+status: reply should ask started_when", reply.slice(0, 300));
    }

    // Acknowledgement should include status
    if (ack.includes("still happening")) {
      pass("location+status: acknowledgement reflects extracted status");
    } else {
      fail("location+status: acknowledgement should mention status", ack);
    }
  } catch (e) {
    fail("multi-field extraction test 2 threw", e);
  }

  // ── Test 3: all three extracted → isGatherComplete for plumbing ──

  try {
    const desc = "yesterday, my kitchen faucet started leaking and it's still happening";
    const loc = extractLocation(desc);
    const timing = extractTiming(desc);
    const status = extractCurrentStatus(desc);

    if (loc === "kitchen" && timing === "yesterday" && status === "still happening") {
      pass("all-three: kitchen + yesterday + still happening");
    } else {
      fail("all-three: unexpected values", { loc, timing, status });
    }

    const gathered = buildInitialGathered();
    gathered.category = "plumbing";
    gathered.location_in_unit = loc;
    gathered.started_when = timing;
    gathered.current_status = status;

    // For plumbing, brand_model is not needed
    if (isGatherComplete(gathered)) {
      pass("all-three: isGatherComplete returns true for plumbing");
    } else {
      fail("all-three: expected gather complete for plumbing");
    }

    // getNextMissingField should be null AND getNextExtendedQuestion should be null
    if (getNextMissingField(gathered) === null && getNextExtendedQuestion(gathered) === null) {
      pass("all-three: no more questions to ask");
    } else {
      fail("all-three: expected no more questions");
    }

    // Acknowledgement should reflect both timing and status
    const ack = buildAcknowledgement(desc, { timing, status });
    if (ack.includes("yesterday") && ack.includes("still happening")) {
      pass("all-three: acknowledgement reflects both timing and status");
    } else {
      fail("all-three: acknowledgement should mention both", ack);
    }
  } catch (e) {
    fail("multi-field extraction test 3 threw", e);
  }

  // ── Test 4: timing only extracted, no location → still asks location first ──

  try {
    const desc = "yesterday my faucet started leaking";
    const loc = extractLocation(desc);
    const timing = extractTiming(desc);

    if (loc === null && timing === "yesterday") {
      pass("timing-only: no location, timing=yesterday");
    } else {
      fail("timing-only: unexpected values", { loc, timing });
    }

    const gathered = buildInitialGathered();
    gathered.category = "plumbing";
    if (timing) gathered.started_when = timing;

    // location is still missing
    const nextBase = getNextMissingField(gathered);
    if (nextBase === "location_in_unit") {
      pass("timing-only: next question is location_in_unit");
    } else {
      fail("timing-only: expected location_in_unit", nextBase);
    }
  } catch (e) {
    fail("timing-only extraction test threw", e);
  }

  // ── Test 5: no extraction at all → normal flow (ask location first) ──

  try {
    const desc = "something is wrong with my plumbing";
    const loc = extractLocation(desc);
    const timing = extractTiming(desc);
    const status = extractCurrentStatus(desc);

    if (loc === null && timing === null && status === null) {
      pass("no-extraction: all null for vague description");
    } else {
      fail("no-extraction: expected all null", { loc, timing, status });
    }

    const gathered = buildInitialGathered();
    gathered.category = "plumbing";
    const nextBase = getNextMissingField(gathered);
    if (nextBase === "location_in_unit") {
      pass("no-extraction: first question is location_in_unit");
    } else {
      fail("no-extraction: expected location_in_unit first", nextBase);
    }
  } catch (e) {
    fail("no-extraction test threw", e);
  }

  // ── Test 6: acknowledgement without extras (backwards compatibility) ──

  try {
    const ack = buildAcknowledgement("my faucet is leaking");
    if (ack.includes("sorry") && ack.includes("faucet")) {
      pass("acknowledgement: works without extras param (backwards compat)");
    } else {
      fail("acknowledgement: backwards compat failed", ack);
    }
  } catch (e) {
    fail("acknowledgement backwards compat threw", e);
  }

  // ══════════════════════════════════════════════════════
  // Equipment extraction
  // ══════════════════════════════════════════════════════
  printSection("Equipment Extraction");

  try {
    if (extractEquipment("my range hood is dripping oil") === "range hood") {
      pass("extractEquipment: 'range hood is dripping oil' → range hood");
    } else {
      fail("extractEquipment: expected range hood", extractEquipment("my range hood is dripping oil"));
    }

    if (extractEquipment("the refrigerator is not cooling") === "refrigerator") {
      pass("extractEquipment: 'refrigerator is not cooling' → refrigerator");
    } else {
      fail("extractEquipment: expected refrigerator");
    }

    // Alias: "fridge" → "refrigerator"
    if (extractEquipment("my fridge stopped working") === "refrigerator") {
      pass("extractEquipment: 'fridge' alias → refrigerator");
    } else {
      fail("extractEquipment: expected refrigerator for fridge alias");
    }

    // Alias: "hood fan" → "range hood"
    if (extractEquipment("the hood fan is making noise") === "range hood") {
      pass("extractEquipment: 'hood fan' alias → range hood");
    } else {
      fail("extractEquipment: expected range hood for hood fan alias");
    }

    // Longest-first: "range hood" beats "range"
    if (extractEquipment("my range hood over the stove") === "range hood") {
      pass("extractEquipment: 'range hood' matches before bare 'range'");
    } else {
      fail("extractEquipment: longest-first matching failed");
    }

    if (extractEquipment("the dishwasher won't drain") === "dishwasher") {
      pass("extractEquipment: dishwasher");
    } else {
      fail("extractEquipment: expected dishwasher");
    }

    if (extractEquipment("washing machine is leaking") === "washer") {
      pass("extractEquipment: 'washing machine' alias → washer");
    } else {
      fail("extractEquipment: expected washer for washing machine");
    }

    if (extractEquipment("something is broken") === null) {
      pass("extractEquipment: no equipment keyword → null");
    } else {
      fail("extractEquipment: should return null for vague description");
    }

    // Word boundary: should not match inside other words
    if (extractEquipment("the rangefinder is broken") === null) {
      pass("extractEquipment: word boundary excludes 'rangefinder'");
    } else {
      fail("extractEquipment: should not match inside 'rangefinder'");
    }
  } catch (e) {
    fail("extractEquipment threw", e);
  }

  // ══════════════════════════════════════════════════════
  // Equipment correction detection
  // ══════════════════════════════════════════════════════
  printSection("Equipment Correction Detection");

  try {
    const r = detectEquipmentCorrection(
      "it's not a refrigerator, it's a range hood",
      "refrigerator"
    );
    if (r.detected && r.equipment === "range hood") {
      pass("detectEquipmentCorrection: 'not refrigerator, it's a range hood' → range hood");
    } else {
      fail("detectEquipmentCorrection: expected range hood", r);
    }
  } catch (e) {
    fail("detectEquipmentCorrection basic threw", e);
  }

  try {
    const r = detectEquipmentCorrection(
      "this isn't about the oven, it's the dishwasher",
      "oven"
    );
    if (r.detected && r.equipment === "dishwasher") {
      pass("detectEquipmentCorrection: 'isn't about oven, it's dishwasher' → dishwasher");
    } else {
      fail("detectEquipmentCorrection: expected dishwasher", r);
    }
  } catch (e) {
    fail("detectEquipmentCorrection isn't threw", e);
  }

  try {
    // No negation → no correction
    const r = detectEquipmentCorrection("the refrigerator is cold", "refrigerator");
    if (!r.detected) {
      pass("detectEquipmentCorrection: no negation → not detected");
    } else {
      fail("detectEquipmentCorrection: should not detect without negation", r);
    }
  } catch (e) {
    fail("detectEquipmentCorrection no-negation threw", e);
  }

  try {
    // Negation of non-appliance → no correction
    const r = detectEquipmentCorrection("it's not working", "refrigerator");
    if (!r.detected) {
      pass("detectEquipmentCorrection: 'not working' (no appliance) → not detected");
    } else {
      fail("detectEquipmentCorrection: should not detect generic 'not working'", r);
    }
  } catch (e) {
    fail("detectEquipmentCorrection generic threw", e);
  }

  // ══════════════════════════════════════════════════════
  // Regression: "range hood dripping oil" end-to-end
  // ══════════════════════════════════════════════════════

  printSection("Regression — Range Hood Dripping Oil");

  try {
    const description = "my range hood is dripping oil";

    // Step 1: Classification
    const classification = classifyIssue(description);
    if (classification.category === "appliance") {
      pass("regression: range hood classified as appliance");
    } else {
      fail("regression: expected appliance", classification);
    }

    // Step 2: Equipment extraction
    const equipment = extractEquipment(description);
    if (equipment === "range hood") {
      pass("regression: equipment extracted as range hood");
    } else {
      fail("regression: expected range hood", equipment);
    }

    // Step 3: Fallback SOP (simulates lowConfidence path)
    const sop = getFallbackSOP("appliance", false, null, "range hood");

    const FORBIDDEN_PATTERNS = [
      /\brefrigerator\b/i,
      /\bdishwasher\b/i,
      /\bwasher\b/i,
      /\bplug(?:ged)?\s+in\b/i,
      /\bbreaker/i,
      /\bgas appliance/i,
    ];

    const hasForbidden = sop.steps.some((s) =>
      FORBIDDEN_PATTERNS.some((p) => p.test(s.description))
    );
    if (!hasForbidden) {
      pass("regression: range hood fallback SOP has no cross-appliance steps");
    } else {
      const offending = sop.steps
        .filter((s) => FORBIDDEN_PATTERNS.some((p) => p.test(s.description)))
        .map((s) => s.description);
      fail("regression: forbidden steps in range hood fallback", offending);
    }

    const hasRelevant = sop.steps.some((s) =>
      /grease|oil|hood|filter|vent|duct/i.test(s.description)
    );
    if (hasRelevant) {
      pass("regression: range hood fallback has grease/oil/filter content");
    } else {
      fail("regression: expected grease/oil/filter content", sop.steps.map((s) => s.description));
    }

    // Step 4: Simulate the full production path (lowConfidence → equipment-specific fallback)
    // In production, generateGroundedSteps calls getFallbackSOP with equipment,
    // so the fallback SOP is already equipment-specific.
    const productionFallback = {
      reply: sop.display,
      steps: sop.steps,
      usedFallback: true,
    };

    // filterStepsByEquipment runs on the already-equipment-specific result
    const filtered = filterStepsByEquipment(productionFallback, "range hood", "appliance", false, null);

    // Verify filtered steps contain NO forbidden terms
    const filteredForbidden = filtered.steps.some((s) =>
      FORBIDDEN_PATTERNS.some((p) => p.test(s.description))
    );
    if (!filteredForbidden) {
      pass("regression: production path has no forbidden steps for range hood");
    } else {
      const offending = filtered.steps
        .filter((s) => FORBIDDEN_PATTERNS.some((p) => p.test(s.description)))
        .map((s) => s.description);
      fail("regression: forbidden steps in production path", offending);
    }

    // Step 5: LLM-grounded steps with cross-appliance noise get filtered
    const llmResult = {
      reply: "Here are some steps: [SOP-1]",
      steps: [
        { step: 1, description: "Clean the range hood grease filters [SOP-1]", completed: false },
        { step: 2, description: "Check the refrigerator temperature [SOP-1]", completed: false },
        { step: 3, description: "Check the dishwasher drain [SOP-1]", completed: false },
      ],
      usedFallback: false,
    };
    const llmFiltered = filterStepsByEquipment(llmResult, "range hood", "appliance", false, null);
    if (llmFiltered.steps.length === 1 && /range hood/i.test(llmFiltered.steps[0].description)) {
      pass("regression: LLM cross-appliance noise filtered for range hood");
    } else {
      fail("regression: expected only range hood step", llmFiltered.steps.map((s) => s.description));
    }

    // Step 6: Guided steps should be clean
    const guidedSteps = convertToGuidedSteps(filtered.steps);
    const guidedForbidden = guidedSteps.some((s) =>
      FORBIDDEN_PATTERNS.some((p) => p.test(s.description))
    );
    if (!guidedForbidden) {
      pass("regression: guided steps clean for range hood");
    } else {
      fail("regression: guided steps have forbidden content");
    }

    if (shouldUseGuidedTroubleshooting(guidedSteps, false)) {
      pass("regression: guided troubleshooting activates for range hood");
    } else {
      fail("regression: expected guided mode to activate");
    }
  } catch (e) {
    fail("regression: range hood end-to-end threw", e);
  }

  // ══════════════════════════════════════════════════════
  // Asking How Detection
  // ══════════════════════════════════════════════════════
  printSection("Asking How Detection — Regex patterns");

  const testStep: GuidedStep = {
    index: 0,
    description: "Check under the kitchen sink for any visible leaks.",
    citation: null,
    step_kind: "action",
    depends_on: null,
    stop_if_unsure: false,
    escalation_if_failed: false,
    request_media_after: false,
  };

  try {
    const r = classifyStepFeedback("how do I check that", testStep);
    if (r === "asking_how") {
      pass("classifyStepFeedback: 'how do I check that' → asking_how");
    } else {
      fail("classifyStepFeedback: expected asking_how", r);
    }
  } catch (e) {
    fail("classifyStepFeedback asking_how 1 threw", e);
  }

  try {
    const r = classifyStepFeedback("can you explain how to do this", testStep);
    if (r === "asking_how") {
      pass("classifyStepFeedback: 'can you explain how to do this' → asking_how");
    } else {
      fail("classifyStepFeedback: expected asking_how", r);
    }
  } catch (e) {
    fail("classifyStepFeedback asking_how 2 threw", e);
  }

  try {
    const r = classifyStepFeedback("do you know how to check it", testStep);
    if (r === "asking_how") {
      pass("classifyStepFeedback: 'do you know how to check it' → asking_how");
    } else {
      fail("classifyStepFeedback: expected asking_how", r);
    }
  } catch (e) {
    fail("classifyStepFeedback asking_how 3 threw", e);
  }

  try {
    const r = classifyStepFeedback("where do I find the filter", testStep);
    if (r === "asking_how") {
      pass("classifyStepFeedback: 'where do I find the filter' → asking_how");
    } else {
      fail("classifyStepFeedback: expected asking_how", r);
    }
  } catch (e) {
    fail("classifyStepFeedback asking_how 4 threw", e);
  }

  try {
    const r = classifyStepFeedback("what does that mean", testStep);
    if (r === "asking_how") {
      pass("classifyStepFeedback: 'what does that mean' → asking_how");
    } else {
      fail("classifyStepFeedback: expected asking_how", r);
    }
  } catch (e) {
    fail("classifyStepFeedback asking_how 5 threw", e);
  }

  try {
    const r = classifyStepFeedback("I'm not sure how to do this", testStep);
    if (r === "asking_how") {
      pass("classifyStepFeedback: 'I'm not sure how to do this' → asking_how");
    } else {
      fail("classifyStepFeedback: expected asking_how", r);
    }
  } catch (e) {
    fail("classifyStepFeedback asking_how 6 threw", e);
  }

  // ── Asking How → provide_help action ──
  printSection("Asking How → provide_help action");

  try {
    const guidedState: GuidedTroubleshootingState = {
      steps: [testStep],
      current_step_index: 0,
      log: [{
        step_index: 0,
        presented_at: new Date().toISOString(),
        responded_at: null,
        raw_response: null,
        result: null,
      }],
      outcome: "in_progress",
    };

    const action = determineNextAction(guidedState, "asking_how", null);
    if (action.type === "provide_help") {
      pass("determineNextAction: asking_how + null previous → provide_help");
    } else {
      fail("determineNextAction: expected provide_help", action);
    }
  } catch (e) {
    fail("determineNextAction asking_how threw", e);
  }

  try {
    const secondStep: GuidedStep = {
      index: 1,
      description: "Try tightening the connection under the sink.",
      citation: null,
      step_kind: "action",
      depends_on: null,
      stop_if_unsure: false,
      escalation_if_failed: false,
      request_media_after: false,
    };
    const guidedState: GuidedTroubleshootingState = {
      steps: [testStep, secondStep],
      current_step_index: 0,
      log: [{
        step_index: 0,
        presented_at: new Date().toISOString(),
        responded_at: null,
        raw_response: null,
        result: "asking_how",
      }],
      outcome: "in_progress",
    };

    const action = determineNextAction(guidedState, "asking_how", "asking_how");
    if (action.type === "next_step") {
      pass("determineNextAction: asking_how + asking_how previous → next_step (escape hatch)");
    } else {
      fail("determineNextAction: expected next_step escape hatch", action);
    }
  } catch (e) {
    fail("determineNextAction asking_how escape hatch threw", e);
  }

  // ── Asking How escape hatch with no more steps → all_steps_done ──
  try {
    const singleStepState: GuidedTroubleshootingState = {
      steps: [testStep],
      current_step_index: 0,
      log: [{
        step_index: 0,
        presented_at: new Date().toISOString(),
        responded_at: null,
        raw_response: null,
        result: "asking_how",
      }],
      outcome: "in_progress",
    };

    const action = determineNextAction(singleStepState, "asking_how", "asking_how");
    if (action.type === "all_steps_done") {
      pass("determineNextAction: asking_how escape hatch, no more steps → all_steps_done");
    } else {
      fail("determineNextAction: expected all_steps_done", action);
    }
  } catch (e) {
    fail("determineNextAction asking_how no-steps escape threw", e);
  }

  // ── buildHelpReply ──
  printSection("buildHelpReply — Help message formatting");

  try {
    const helpText = "Look under the kitchen sink. You should see pipes connected to the faucet above.";
    const reply = buildHelpReply(helpText, testStep);
    if (reply.includes(helpText)) {
      pass("buildHelpReply: includes help text");
    } else {
      fail("buildHelpReply: missing help text", reply);
    }
    if (reply.includes("Give it a try")) {
      pass("buildHelpReply: includes try prompt for non-stop_if_unsure step");
    } else {
      fail("buildHelpReply: missing try prompt", reply);
    }
  } catch (e) {
    fail("buildHelpReply basic threw", e);
  }

  try {
    const unsureStep: GuidedStep = {
      ...testStep,
      stop_if_unsure: true,
    };
    const helpText = "This requires checking inside the electrical panel.";
    const reply = buildHelpReply(helpText, unsureStep);
    if (reply.includes("not comfortable")) {
      pass("buildHelpReply: stop_if_unsure step includes comfort prompt");
    } else {
      fail("buildHelpReply: missing comfort prompt for stop_if_unsure", reply);
    }
  } catch (e) {
    fail("buildHelpReply stop_if_unsure threw", e);
  }

  return result;
}

// Allow standalone execution
if (require.main === module) {
  const { runStandalone } = require("./helpers");
  runStandalone(testConversationalTriage);
}
