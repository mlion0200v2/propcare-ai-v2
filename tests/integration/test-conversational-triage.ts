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
import { extractLocation, extractTiming, extractCurrentStatus } from "../../src/lib/triage/extract-details";
import { getFallbackSOP } from "../../src/lib/triage/sop-fallback";
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

  return result;
}

// Allow standalone execution
if (require.main === module) {
  const { runStandalone } = require("./helpers");
  runStandalone(testConversationalTriage);
}
