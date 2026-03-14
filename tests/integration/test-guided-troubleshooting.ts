/**
 * Tests for Guided Troubleshooting — pure logic (no network).
 *
 * Run:  npx tsx tests/integration/test-guided-troubleshooting.ts
 */
import { createRunner, printSection, runStandalone, type TestResult } from "./helpers";

import {
  classifyStepFeedback,
  determineNextAction,
  findNextEligibleStep,
  getTerminalGuidance,
  buildStepMessage,
  buildFeedbackReply,
  buildClarifyReply,
} from "../../src/lib/triage/step-feedback";

import {
  mapToStepResult,
  parseInterpretation,
  classifyStepHybrid,
} from "../../src/lib/triage/interpret-step-response";

import { convertToGuidedSteps, stripCitations, filterMediaStepLines } from "../../src/lib/triage/grounding";

import type {
  GuidedStep,
  GuidedStepKind,
  GuidedTroubleshootingState,
  TroubleshootingStep,
  InterpretedStepResponse,
} from "../../src/lib/triage/types";

// ── Helpers ──

function makeStep(overrides?: Partial<GuidedStep>): GuidedStep {
  return {
    index: 0,
    description: "Check under the sink for visible leaks",
    citation: "[SOP-1]",
    step_kind: "action",
    depends_on: null,
    stop_if_unsure: false,
    escalation_if_failed: false,
    request_media_after: false,
    ...overrides,
  };
}

function makeState(overrides?: Partial<GuidedTroubleshootingState>): GuidedTroubleshootingState {
  return {
    steps: [
      makeStep({ index: 0, description: "Check under the sink" }),
      makeStep({ index: 1, description: "Tighten the fitting" }),
      makeStep({ index: 2, description: "Replace the washer" }),
    ],
    current_step_index: 0,
    log: [],
    outcome: "in_progress",
    ...overrides,
  };
}

export function testGuidedTroubleshooting(): TestResult {
  printSection("Guided Troubleshooting");
  const { pass, fail, result } = createRunner();

  // ── filterMediaStepLines ──
  {
    const text = "1. Check under the sink\n2. Take a photo of the leak\n3. Turn off the valve";
    const filtered = filterMediaStepLines(text);
    !filtered.includes("Take a photo") && filtered.includes("Check under the sink") && filtered.includes("Turn off the valve")
      ? pass("filterMediaStepLines: removes 'Take a photo' step")
      : fail("filterMediaStepLines: should remove photo step", filtered);
  }

  {
    const text = "1. Check the breaker\n2. Send a video of the sparks\n3. Do NOT touch exposed wires";
    const filtered = filterMediaStepLines(text);
    !filtered.includes("Send a video") && filtered.includes("Check the breaker")
      ? pass("filterMediaStepLines: removes 'Send a video' step")
      : fail("filterMediaStepLines: should remove video step", filtered);
  }

  {
    const text = "1. Check under the sink\n2. Turn off the valve\n3. Place a bucket";
    const filtered = filterMediaStepLines(text);
    filtered === text
      ? pass("filterMediaStepLines: no-op when no media steps")
      : fail("filterMediaStepLines: should not change text without media steps");
  }

  {
    const text = "**Troubleshooting Steps:**\n1. Check the pipe\n2. Upload a photo of the damage\n3. Avoid using faucet";
    const filtered = filterMediaStepLines(text);
    !filtered.includes("Upload a photo") && filtered.includes("Check the pipe")
      ? pass("filterMediaStepLines: removes 'Upload a photo' step in SOP format")
      : fail("filterMediaStepLines: should remove upload step from SOP", filtered);
  }

  // ── stripCitations (multi-line) ──
  {
    const text = "1. Check the sink [SOP-1]\n2. Turn off valve [SOP-2]\n3. Place a bucket [SOP-1]";
    const stripped = stripCitations(text);
    !stripped.includes("[SOP-") && stripped.includes("\n")
      ? pass("stripCitations: multi-line — strips citations, preserves newlines")
      : fail("stripCitations: should strip citations and preserve newlines", stripped);
  }

  // ── classifyStepFeedback ──
  const step = makeStep();

  classifyStepFeedback("There's a gas smell, I'm scared", step) === "unsafe"
    ? pass("classifyStepFeedback: unsafe — gas smell")
    : fail("classifyStepFeedback: expected unsafe for gas smell", classifyStepFeedback("There's a gas smell, I'm scared", step));

  classifyStepFeedback("That worked! The dripping stopped", step) === "helped"
    ? pass("classifyStepFeedback: helped — worked")
    : fail("classifyStepFeedback: expected helped", classifyStepFeedback("That worked! The dripping stopped", step));

  classifyStepFeedback("stopped dripping", step) === "helped"
    ? pass("classifyStepFeedback: helped — stopped dripping")
    : fail("classifyStepFeedback: expected helped for stopped dripping", classifyStepFeedback("stopped dripping", step));

  classifyStepFeedback("It helped a little but still dripping some", step) === "partial"
    ? pass("classifyStepFeedback: partial — a little")
    : fail("classifyStepFeedback: expected partial", classifyStepFeedback("It helped a little but still dripping some", step));

  classifyStepFeedback("slowed down", step) === "partial"
    ? pass("classifyStepFeedback: partial — slowed down")
    : fail("classifyStepFeedback: expected partial for slowed down", classifyStepFeedback("slowed down", step));

  classifyStepFeedback("Didn't work, still the same problem", step) === "did_not_help"
    ? pass("classifyStepFeedback: did_not_help — didn't work")
    : fail("classifyStepFeedback: expected did_not_help", classifyStepFeedback("Didn't work, still the same problem", step));

  classifyStepFeedback("still leaking", step) === "did_not_help"
    ? pass("classifyStepFeedback: did_not_help — still leaking")
    : fail("classifyStepFeedback: expected did_not_help for still leaking", classifyStepFeedback("still leaking", step));

  classifyStepFeedback("I can't find the valve, where is it?", step) === "unable_to_access"
    ? pass("classifyStepFeedback: unable_to_access — can't find")
    : fail("classifyStepFeedback: expected unable_to_access", classifyStepFeedback("I can't find the valve, where is it?", step));

  classifyStepFeedback("not sure where the shut-off valves", step) === "unable_to_access"
    ? pass("classifyStepFeedback: unable_to_access — not sure where")
    : fail("classifyStepFeedback: expected unable_to_access for 'not sure where'", classifyStepFeedback("not sure where the shut-off valves", step));

  classifyStepFeedback("cannot find it", step) === "unable_to_access"
    ? pass("classifyStepFeedback: unable_to_access — cannot find")
    : fail("classifyStepFeedback: expected unable_to_access for 'cannot find'", classifyStepFeedback("cannot find it", step));

  classifyStepFeedback("I'd rather not try that, skip please", step) === "did_not_try"
    ? pass("classifyStepFeedback: did_not_try — skip")
    : fail("classifyStepFeedback: expected did_not_try", classifyStepFeedback("I'd rather not try that, skip please", step));

  classifyStepFeedback("Done, what's next?", step) === "completed"
    ? pass("classifyStepFeedback: completed — done what's next")
    : fail("classifyStepFeedback: expected completed", classifyStepFeedback("Done, what's next?", step));

  classifyStepFeedback("ok", step) === "completed"
    ? pass("classifyStepFeedback: completed — ok")
    : fail("classifyStepFeedback: expected completed for 'ok'", classifyStepFeedback("ok", step));

  classifyStepFeedback("I turned them off", step) === "completed"
    ? pass("classifyStepFeedback: completed — turned them off")
    : fail("classifyStepFeedback: expected completed for 'turned them off'", classifyStepFeedback("I turned them off", step));

  // Step-kind-aware bare "no"
  {
    const obsStep = makeStep({ step_kind: "observation" });
    classifyStepFeedback("no", obsStep) === "did_not_help"
      ? pass("classifyStepFeedback: bare 'no' on observation → did_not_help")
      : fail("classifyStepFeedback: bare 'no' on observation should be did_not_help", classifyStepFeedback("no", obsStep));
  }

  {
    const actStep = makeStep({ step_kind: "action" });
    classifyStepFeedback("no", actStep) === "did_not_try"
      ? pass("classifyStepFeedback: bare 'no' on action → did_not_try")
      : fail("classifyStepFeedback: bare 'no' on action should be did_not_try", classifyStepFeedback("no", actStep));
  }

  // Unclear default
  classifyStepFeedback("some random unrelated text about weather", step) === "unclear"
    ? pass("classifyStepFeedback: ambiguous text → unclear (NOT completed)")
    : fail("classifyStepFeedback: expected unclear for ambiguous text", classifyStepFeedback("some random unrelated text about weather", step));

  // Getting worse → unsafe
  classifyStepFeedback("it's getting worse", step) === "unsafe"
    ? pass("classifyStepFeedback: unsafe — getting worse")
    : fail("classifyStepFeedback: expected unsafe for getting worse", classifyStepFeedback("it's getting worse", step));

  classifyStepFeedback("not safe to go near it", step) === "unsafe"
    ? pass("classifyStepFeedback: unsafe — not safe")
    : fail("classifyStepFeedback: expected unsafe for 'not safe'", classifyStepFeedback("not safe to go near it", step));

  // ── determineNextAction ──
  const state = makeState();

  {
    const action = determineNextAction(state, "unsafe");
    action.type === "escalate" && action.reason === "tenant_reported_unsafe"
      ? pass("determineNextAction: unsafe → escalate (tenant_reported_unsafe)")
      : fail("determineNextAction: unsafe should escalate", action);
  }

  {
    const action = determineNextAction(state, "helped");
    action.type === "resolved"
      ? pass("determineNextAction: helped → resolved")
      : fail("determineNextAction: helped should resolve", action);
  }

  {
    const action = determineNextAction(state, "unclear");
    action.type === "clarify"
      ? pass("determineNextAction: unclear → clarify")
      : fail("determineNextAction: unclear should clarify", action);
  }

  {
    const action = determineNextAction(state, "did_not_help");
    action.type === "next_step"
      ? pass("determineNextAction: did_not_help (no escalation flag) → next_step")
      : fail("determineNextAction: did_not_help should go next_step", action);
  }

  {
    // did_not_help on a step with escalation_if_failed
    const criticalState = makeState({
      steps: [
        makeStep({ index: 0, escalation_if_failed: true }),
        makeStep({ index: 1 }),
      ],
    });
    const action = determineNextAction(criticalState, "did_not_help");
    action.type === "escalate" && action.reason === "critical_step_failed"
      ? pass("determineNextAction: did_not_help + escalation_if_failed → escalate")
      : fail("determineNextAction: should escalate on critical step failure", action);
  }

  {
    // unable_to_access on a stop_if_unsure step → escalate
    const unsureState = makeState({
      steps: [
        makeStep({ index: 0, stop_if_unsure: true }),
        makeStep({ index: 1 }),
      ],
    });
    const action = determineNextAction(unsureState, "unable_to_access");
    action.type === "escalate" && action.reason === "prerequisite_inaccessible"
      ? pass("determineNextAction: unable_to_access + stop_if_unsure → escalate")
      : fail("determineNextAction: should escalate on inaccessible prerequisite", action);
  }

  {
    // unable_to_access on a normal step → next_step (not escalate)
    const normalState = makeState({
      steps: [
        makeStep({ index: 0, stop_if_unsure: false }),
        makeStep({ index: 1 }),
      ],
    });
    const action = determineNextAction(normalState, "unable_to_access");
    action.type === "next_step"
      ? pass("determineNextAction: unable_to_access on normal step → next_step")
      : fail("determineNextAction: should go next_step on normal unable_to_access", action);
  }

  {
    const action = determineNextAction(state, "completed");
    action.type === "next_step"
      ? pass("determineNextAction: completed → next_step (more steps)")
      : fail("determineNextAction: completed should go next_step", action);
  }

  {
    // Last step
    const lastStepState = makeState({ current_step_index: 2 });
    const action = determineNextAction(lastStepState, "completed");
    action.type === "all_steps_done"
      ? pass("determineNextAction: completed on last step → all_steps_done")
      : fail("determineNextAction: last step should be all_steps_done", action);
  }

  {
    const action = determineNextAction(state, "did_not_try");
    action.type === "next_step"
      ? pass("determineNextAction: did_not_try → next_step")
      : fail("determineNextAction: did_not_try should go next_step", action);
  }

  {
    const action = determineNextAction(state, "partial");
    action.type === "next_step"
      ? pass("determineNextAction: partial → next_step")
      : fail("determineNextAction: partial should go next_step", action);
  }

  // ── findNextEligibleStep ──
  {
    // Simple: all action steps, no dependencies
    const s = makeState();
    const next = findNextEligibleStep(s, 0);
    next === 1
      ? pass("findNextEligibleStep: simple → next action step")
      : fail("findNextEligibleStep: expected 1", next);
  }

  {
    // Skips terminal step
    const s = makeState({
      steps: [
        makeStep({ index: 0, step_kind: "action" }),
        makeStep({ index: 1, step_kind: "terminal" }),
        makeStep({ index: 2, step_kind: "action" }),
      ],
    });
    const next = findNextEligibleStep(s, 0);
    next === 2
      ? pass("findNextEligibleStep: skips terminal step")
      : fail("findNextEligibleStep: should skip terminal", next);
  }

  {
    // Skips observation when prereq not completed
    const s = makeState({
      steps: [
        makeStep({ index: 0, step_kind: "action" }),
        makeStep({ index: 1, step_kind: "observation", depends_on: 0 }),
        makeStep({ index: 2, step_kind: "action" }),
      ],
      log: [
        { step_index: 0, presented_at: "", responded_at: "", raw_response: "skip", result: "did_not_try" },
      ],
    });
    const next = findNextEligibleStep(s, 0);
    next === 2
      ? pass("findNextEligibleStep: skips observation when prereq not completed")
      : fail("findNextEligibleStep: should skip dependent observation", next);
  }

  {
    // Allows observation when prereq completed
    const s = makeState({
      steps: [
        makeStep({ index: 0, step_kind: "action" }),
        makeStep({ index: 1, step_kind: "observation", depends_on: 0 }),
        makeStep({ index: 2, step_kind: "action" }),
      ],
      log: [
        { step_index: 0, presented_at: "", responded_at: "", raw_response: "done", result: "completed" },
      ],
    });
    const next = findNextEligibleStep(s, 0);
    next === 1
      ? pass("findNextEligibleStep: allows observation when prereq completed")
      : fail("findNextEligibleStep: should allow dependent observation", next);
  }

  {
    // Returns null when no more eligible steps
    const s = makeState({
      steps: [
        makeStep({ index: 0, step_kind: "action" }),
        makeStep({ index: 1, step_kind: "terminal" }),
      ],
    });
    const next = findNextEligibleStep(s, 0);
    next === null
      ? pass("findNextEligibleStep: null when only terminal remains")
      : fail("findNextEligibleStep: should be null", next);
  }

  // ── getTerminalGuidance ──
  {
    const s = makeState({
      steps: [
        makeStep({ index: 0, step_kind: "action" }),
        makeStep({ index: 1, step_kind: "terminal", description: "Avoid using the faucet" }),
        makeStep({ index: 2, step_kind: "media_request", description: "Send a photo of the leak" }),
      ],
      log: [
        { step_index: 0, presented_at: "", responded_at: "", raw_response: "done", result: "completed" },
      ],
    });
    const guidance = getTerminalGuidance(s);
    // media_request steps are excluded (media already requested in AWAITING_MEDIA)
    guidance.length === 1
      ? pass("getTerminalGuidance: collects terminal steps only (no media_request)")
      : fail("getTerminalGuidance: expected 1 item (terminal only)", guidance.length);

    guidance[0] === "Avoid using the faucet"
      ? pass("getTerminalGuidance: correct terminal text")
      : fail("getTerminalGuidance: wrong text", guidance[0]);
  }

  // ── buildStepMessage ──
  {
    const msg = buildStepMessage(makeStep(), true);
    msg.includes("safe checks")
      ? pass("buildStepMessage: first step has intro")
      : fail("buildStepMessage: first step should have intro", msg.slice(0, 100));
  }

  {
    const msg = buildStepMessage(makeStep({ index: 1 }), false);
    !msg.includes("safe checks")
      ? pass("buildStepMessage: subsequent step has no intro")
      : fail("buildStepMessage: subsequent step should not have intro");
  }

  {
    const msg = buildStepMessage(makeStep({ citation: "[SOP-3]" }), false);
    !msg.includes("[SOP-3]")
      ? pass("buildStepMessage: no raw citation in output")
      : fail("buildStepMessage: should NOT show raw citation");
  }

  {
    const msg = buildStepMessage(makeStep({ stop_if_unsure: true }), false);
    msg.includes("not sure how to do this safely")
      ? pass("buildStepMessage: stop_if_unsure shows safety note")
      : fail("buildStepMessage: should show safety note for stop_if_unsure");
  }

  {
    const msg = buildStepMessage(makeStep({ step_kind: "action" }), false);
    msg.includes("once you've done that")
      ? pass("buildStepMessage: action step has action-specific prompt")
      : fail("buildStepMessage: action step should have action prompt", msg.slice(-80));
  }

  {
    const msg = buildStepMessage(makeStep({ step_kind: "observation" }), false);
    msg.includes("what you see")
      ? pass("buildStepMessage: observation step has observation-specific prompt")
      : fail("buildStepMessage: observation step should have observation prompt", msg.slice(-80));
  }

  {
    const msg = buildStepMessage(makeStep({ step_kind: "terminal", description: "Avoid using faucet" }), false);
    !msg.includes("Let me know") && !msg.includes("did it help")
      ? pass("buildStepMessage: terminal step has no feedback prompt")
      : fail("buildStepMessage: terminal step should NOT have feedback prompt", msg.slice(-80));
  }

  // ── Natural language tolerance — COMPLETED_PATTERNS ──
  classifyStepFeedback("have tried that", step) === "completed"
    ? pass("classifyStepFeedback: completed — 'have tried that'")
    : fail("classifyStepFeedback: expected completed for 'have tried that'", classifyStepFeedback("have tried that", step));

  classifyStepFeedback("tried", step) === "completed"
    ? pass("classifyStepFeedback: completed — bare 'tried'")
    : fail("classifyStepFeedback: expected completed for bare 'tried'", classifyStepFeedback("tried", step));

  classifyStepFeedback("I tried", step) === "completed"
    ? pass("classifyStepFeedback: completed — 'I tried'")
    : fail("classifyStepFeedback: expected completed for 'I tried'", classifyStepFeedback("I tried", step));

  classifyStepFeedback("already did that", step) === "completed"
    ? pass("classifyStepFeedback: completed — 'already did that'")
    : fail("classifyStepFeedback: expected completed for 'already did that'", classifyStepFeedback("already did that", step));

  classifyStepFeedback("tried it!", step) === "completed"
    ? pass("classifyStepFeedback: completed — 'tried it!'")
    : fail("classifyStepFeedback: expected completed for 'tried it!'", classifyStepFeedback("tried it!", step));

  // ── Natural language tolerance — DID_NOT_HELP_PATTERNS ──
  classifyStepFeedback("still there", step) === "did_not_help"
    ? pass("classifyStepFeedback: did_not_help — 'still there'")
    : fail("classifyStepFeedback: expected did_not_help for 'still there'", classifyStepFeedback("still there", step));

  classifyStepFeedback("still mold", step) === "did_not_help"
    ? pass("classifyStepFeedback: did_not_help — 'still mold'")
    : fail("classifyStepFeedback: expected did_not_help for 'still mold'", classifyStepFeedback("still mold", step));

  // ── Natural language tolerance — UNABLE_TO_ACCESS_PATTERNS ──
  classifyStepFeedback("can't tell", step) === "unable_to_access"
    ? pass("classifyStepFeedback: unable_to_access — 'can't tell'")
    : fail("classifyStepFeedback: expected unable_to_access for 'can't tell'", classifyStepFeedback("can't tell", step));

  classifyStepFeedback("not sure", step) === "unable_to_access"
    ? pass("classifyStepFeedback: unable_to_access — 'not sure'")
    : fail("classifyStepFeedback: expected unable_to_access for 'not sure'", classifyStepFeedback("not sure", step));

  classifyStepFeedback("don't know", step) === "unable_to_access"
    ? pass("classifyStepFeedback: unable_to_access — 'don't know'")
    : fail("classifyStepFeedback: expected unable_to_access for 'don't know'", classifyStepFeedback("don't know", step));

  classifyStepFeedback("hard to see", step) === "unable_to_access"
    ? pass("classifyStepFeedback: unable_to_access — 'hard to see'")
    : fail("classifyStepFeedback: expected unable_to_access for 'hard to see'", classifyStepFeedback("hard to see", step));

  // ── Natural language tolerance — DID_NOT_TRY_PATTERNS ──
  classifyStepFeedback("move on", step) === "did_not_try"
    ? pass("classifyStepFeedback: did_not_try — 'move on'")
    : fail("classifyStepFeedback: expected did_not_try for 'move on'", classifyStepFeedback("move on", step));

  classifyStepFeedback("let's move on", step) === "did_not_try"
    ? pass("classifyStepFeedback: did_not_try — 'let's move on'")
    : fail("classifyStepFeedback: expected did_not_try for 'let's move on'", classifyStepFeedback("let's move on", step));

  // ── Natural action-completion language → completed ──
  classifyStepFeedback("we wiped everything", step) === "completed"
    ? pass("classifyStepFeedback: completed — 'we wiped everything'")
    : fail("classifyStepFeedback: expected completed for 'we wiped everything'", classifyStepFeedback("we wiped everything", step));

  classifyStepFeedback("i wiped it", step) === "completed"
    ? pass("classifyStepFeedback: completed — 'i wiped it'")
    : fail("classifyStepFeedback: expected completed for 'i wiped it'", classifyStepFeedback("i wiped it", step));

  classifyStepFeedback("cleaned it up", step) === "completed"
    ? pass("classifyStepFeedback: completed — 'cleaned it up'")
    : fail("classifyStepFeedback: expected completed for 'cleaned it up'", classifyStepFeedback("cleaned it up", step));

  classifyStepFeedback("we did", step) === "completed"
    ? pass("classifyStepFeedback: completed — 'we did'")
    : fail("classifyStepFeedback: expected completed for 'we did'", classifyStepFeedback("we did", step));

  classifyStepFeedback("i did that", step) === "completed"
    ? pass("classifyStepFeedback: completed — 'i did that'")
    : fail("classifyStepFeedback: expected completed for 'i did that'", classifyStepFeedback("i did that", step));

  classifyStepFeedback("i placed several across the living room", step) === "completed"
    ? pass("classifyStepFeedback: completed — 'i placed several across the living room'")
    : fail("classifyStepFeedback: expected completed for 'i placed several...'", classifyStepFeedback("i placed several across the living room", step));

  classifyStepFeedback("i put down bait", step) === "completed"
    ? pass("classifyStepFeedback: completed — 'i put down bait'")
    : fail("classifyStepFeedback: expected completed for 'i put down bait'", classifyStepFeedback("i put down bait", step));

  classifyStepFeedback("we stored everything", step) === "completed"
    ? pass("classifyStepFeedback: completed — 'we stored everything'")
    : fail("classifyStepFeedback: expected completed for 'we stored everything'", classifyStepFeedback("we stored everything", step));

  classifyStepFeedback("i checked", step) === "completed"
    ? pass("classifyStepFeedback: completed — 'i checked'")
    : fail("classifyStepFeedback: expected completed for 'i checked'", classifyStepFeedback("i checked", step));

  classifyStepFeedback("we looked", step) === "completed"
    ? pass("classifyStepFeedback: completed — 'we looked'")
    : fail("classifyStepFeedback: expected completed for 'we looked'", classifyStepFeedback("we looked", step));

  classifyStepFeedback("we found it", step) === "completed"
    ? pass("classifyStepFeedback: completed — 'we found it'")
    : fail("classifyStepFeedback: expected completed for 'we found it'", classifyStepFeedback("we found it", step));

  classifyStepFeedback("we found the ants are coming from a hole under the carpet", step) === "completed"
    ? pass("classifyStepFeedback: completed — 'we found the ants...' (with detail)")
    : fail("classifyStepFeedback: expected completed for 'we found the ants...'", classifyStepFeedback("we found the ants are coming from a hole under the carpet", step));

  classifyStepFeedback("i sealed the gap", step) === "completed"
    ? pass("classifyStepFeedback: completed — 'i sealed the gap'")
    : fail("classifyStepFeedback: expected completed for 'i sealed the gap'", classifyStepFeedback("i sealed the gap", step));

  classifyStepFeedback("we cleaned it", step) === "completed"
    ? pass("classifyStepFeedback: completed — 'we cleaned it'")
    : fail("classifyStepFeedback: expected completed for 'we cleaned it'", classifyStepFeedback("we cleaned it", step));

  // ── determineNextAction — double-unclear auto-advance ──
  {
    const action = determineNextAction(state, "unclear", "unclear");
    action.type === "next_step"
      ? pass("determineNextAction: double-unclear → next_step (escape hatch)")
      : fail("determineNextAction: double-unclear should auto-advance", action);
  }

  {
    const action = determineNextAction(state, "unclear", null);
    action.type === "clarify"
      ? pass("determineNextAction: first unclear (previousResult=null) → clarify")
      : fail("determineNextAction: first unclear should still clarify", action);
  }

  {
    // Double-unclear on last step → all_steps_done
    const lastStepState = makeState({ current_step_index: 2 });
    const action = determineNextAction(lastStepState, "unclear", "unclear");
    action.type === "all_steps_done"
      ? pass("determineNextAction: double-unclear on last step → all_steps_done")
      : fail("determineNextAction: double-unclear on last step should finish", action);
  }

  // ── buildClarifyReply — step-kind-aware ──
  {
    const reply = buildClarifyReply(makeStep({ step_kind: "action" }));
    reply.includes("confirm")
      ? pass("buildClarifyReply: action step asks for confirmation")
      : fail("buildClarifyReply: action should ask for confirmation", reply.slice(0, 80));
  }

  {
    const reply = buildClarifyReply(makeStep({ step_kind: "observation" }));
    reply.includes("what did you notice")
      ? pass("buildClarifyReply: observation step asks what they noticed")
      : fail("buildClarifyReply: observation should ask what they noticed", reply.slice(0, 80));
  }

  {
    const reply = buildClarifyReply(makeStep());
    !reply.includes("You can say things like")
      ? pass("buildClarifyReply: does NOT list example keywords")
      : fail("buildClarifyReply: should NOT include keyword examples");
  }

  // ── buildFeedbackReply ──
  {
    const reply = buildFeedbackReply("unsafe", { type: "escalate", reason: "tenant_reported_unsafe" });
    reply.includes("safety comes first") && reply.includes("escalated")
      ? pass("buildFeedbackReply: unsafe → safety alert + escalation")
      : fail("buildFeedbackReply: unsafe should mention safety + escalation", reply.slice(0, 100));
  }

  {
    const reply = buildFeedbackReply("helped", { type: "resolved" });
    reply.includes("glad that worked")
      ? pass("buildFeedbackReply: helped → glad that worked")
      : fail("buildFeedbackReply: helped should say glad that worked", reply.slice(0, 100));
  }

  {
    const reply = buildFeedbackReply("helped", { type: "resolved" }, undefined, ["Avoid using the faucet"]);
    reply.includes("Avoid using the faucet")
      ? pass("buildFeedbackReply: helped + resolved includes terminal guidance")
      : fail("buildFeedbackReply: should include terminal guidance on resolution", reply.slice(0, 200));
  }

  {
    const nextStep = makeStep({ index: 1, description: "Tighten the fitting", step_kind: "action" });
    const reply = buildFeedbackReply("did_not_help", { type: "next_step" }, nextStep);
    reply.includes("didn't do the trick") && reply.includes("Tighten the fitting")
      ? pass("buildFeedbackReply: did_not_help + next_step includes next step text")
      : fail("buildFeedbackReply: should include next step text", reply.slice(0, 150));
  }

  {
    // No raw citation in feedback reply
    const nextStep = makeStep({ index: 1, description: "Tighten the fitting", citation: "[SOP-2]", step_kind: "action" });
    const reply = buildFeedbackReply("completed", { type: "next_step" }, nextStep);
    !reply.includes("[SOP-2]")
      ? pass("buildFeedbackReply: no raw citation in next step text")
      : fail("buildFeedbackReply: should NOT show raw citation");
  }

  {
    const reply = buildFeedbackReply("completed", { type: "all_steps_done" }, undefined, ["Avoid using the faucet"]);
    reply.includes("gone through all the steps") && reply.includes("Avoid using the faucet")
      ? pass("buildFeedbackReply: all_steps_done includes terminal guidance")
      : fail("buildFeedbackReply: all_steps_done should include terminal guidance", reply.slice(0, 200));
  }

  {
    const reply = buildFeedbackReply("unable_to_access", { type: "escalate", reason: "prerequisite_inaccessible" });
    reply.includes("don't force anything")
      ? pass("buildFeedbackReply: unable_to_access + escalate → don't force anything")
      : fail("buildFeedbackReply: should say don't force anything", reply.slice(0, 150));
  }

  {
    const reply = buildFeedbackReply("did_not_help", { type: "escalate", reason: "critical_step_failed" });
    reply.includes("pass this along")
      ? pass("buildFeedbackReply: escalate → pass this along message")
      : fail("buildFeedbackReply: escalate should mention passing along", reply.slice(0, 100));
  }

  // ── Step-kind-aware completed acknowledgements ──
  {
    const reply = buildFeedbackReply("completed", { type: "next_step" },
      makeStep({ index: 1, description: "Next step" }), undefined,
      { currentStepKind: "action" });
    reply.includes("Done") && reply.includes("thanks")
      ? pass("buildFeedbackReply: completed action → 'Done — thanks...'")
      : fail("buildFeedbackReply: action completed should say Done", reply.slice(0, 80));
  }

  {
    const reply = buildFeedbackReply("completed", { type: "next_step" },
      makeStep({ index: 1, description: "Next step" }), undefined,
      { currentStepKind: "observation" });
    reply.includes("noted")
      ? pass("buildFeedbackReply: completed observation → 'noted'")
      : fail("buildFeedbackReply: observation completed should say noted", reply.slice(0, 80));
  }

  {
    const reply = buildFeedbackReply("completed", { type: "next_step" },
      makeStep({ index: 1, description: "Next step" }), undefined,
      { currentStepKind: "observation", extractedNote: "area is dry" });
    reply.includes("noted") && reply.includes("area is dry")
      ? pass("buildFeedbackReply: completed observation + note includes extracted note")
      : fail("buildFeedbackReply: should include extracted note", reply.slice(0, 120));
  }

  {
    // did_not_help on observation → "thanks for checking" not "didn't do the trick"
    const reply = buildFeedbackReply("did_not_help", { type: "next_step" },
      makeStep({ index: 1, description: "Next step" }), undefined,
      { currentStepKind: "observation" });
    reply.includes("thanks for checking")
      ? pass("buildFeedbackReply: did_not_help on observation → 'thanks for checking'")
      : fail("buildFeedbackReply: observation did_not_help wording", reply.slice(0, 80));
  }

  // ── stripCitations ──
  {
    stripCitations("Check under the sink [SOP-1]") === "Check under the sink"
      ? pass("stripCitations: removes [SOP-1]")
      : fail("stripCitations: expected clean text", stripCitations("Check under the sink [SOP-1]"));
  }

  {
    stripCitations("Turn off valve [SOP-2] carefully") === "Turn off valve carefully"
      ? pass("stripCitations: removes mid-text citation")
      : fail("stripCitations: expected clean mid-text", stripCitations("Turn off valve [SOP-2] carefully"));
  }

  {
    stripCitations("No citation here") === "No citation here"
      ? pass("stripCitations: no-op when no citation")
      : fail("stripCitations: should be no-op");
  }

  {
    stripCitations("Step text _([SOP-1])_") === "Step text"
      ? pass("stripCitations: removes _([SOP-1])_ format")
      : fail("stripCitations: expected clean text for _([SOP])_ format", stripCitations("Step text _([SOP-1])_"));
  }

  // ── convertToGuidedSteps ──
  {
    const steps: TroubleshootingStep[] = [
      { step: 1, description: "Check under the sink for visible leaks [SOP-1]", completed: false },
      { step: 2, description: "Turn off the shut-off valve carefully [SOP-2]", completed: false },
      { step: 3, description: "Check to see if the dripping stops after shutting off [SOP-1]", completed: false },
      { step: 4, description: "Please avoid using the faucet until maintenance has reviewed [SOP-1]", completed: false },
    ];

    const guided = convertToGuidedSteps(steps);

    guided.length === 4
      ? pass("convertToGuidedSteps: correct count")
      : fail("convertToGuidedSteps: expected 4 steps", guided.length);

    guided[0].citation === "[SOP-1]"
      ? pass("convertToGuidedSteps: extracts [SOP-1] citation")
      : fail("convertToGuidedSteps: expected [SOP-1]", guided[0].citation);

    !guided[0].description.includes("[SOP-1]")
      ? pass("convertToGuidedSteps: description stripped of citation")
      : fail("convertToGuidedSteps: description should not contain citation", guided[0].description);

    guided[1].stop_if_unsure === true
      ? pass("convertToGuidedSteps: valve step → stop_if_unsure")
      : fail("convertToGuidedSteps: valve step should be stop_if_unsure");

    // Step kinds
    guided[0].step_kind === "action"
      ? pass("convertToGuidedSteps: step 0 → action")
      : fail("convertToGuidedSteps: step 0 should be action", guided[0].step_kind);

    guided[1].step_kind === "action"
      ? pass("convertToGuidedSteps: step 1 (shutoff) → action")
      : fail("convertToGuidedSteps: step 1 should be action", guided[1].step_kind);

    guided[2].step_kind === "observation"
      ? pass("convertToGuidedSteps: step 2 (check if stops) → observation")
      : fail("convertToGuidedSteps: step 2 should be observation", guided[2].step_kind);

    guided[3].step_kind === "terminal"
      ? pass("convertToGuidedSteps: step 3 (avoid using) → terminal")
      : fail("convertToGuidedSteps: step 3 should be terminal", guided[3].step_kind);

    // Dependency
    guided[2].depends_on === 1
      ? pass("convertToGuidedSteps: observation depends_on shutoff action (index 1)")
      : fail("convertToGuidedSteps: observation should depend on step 1", guided[2].depends_on);

    guided[0].depends_on === null
      ? pass("convertToGuidedSteps: action step has no dependency")
      : fail("convertToGuidedSteps: action step should have null depends_on");

    guided[0].index === 0 && guided[1].index === 1 && guided[2].index === 2 && guided[3].index === 3
      ? pass("convertToGuidedSteps: correct indices")
      : fail("convertToGuidedSteps: indices should be 0,1,2,3");
  }

  {
    // Step without citation
    const steps: TroubleshootingStep[] = [
      { step: 1, description: "Try wiggling the handle", completed: false },
    ];
    const guided = convertToGuidedSteps(steps);
    guided[0].citation === null
      ? pass("convertToGuidedSteps: no citation when absent")
      : fail("convertToGuidedSteps: should be null when no citation", guided[0].citation);
  }

  {
    // Leak-critical step (both patterns match)
    const steps: TroubleshootingStep[] = [
      { step: 1, description: "Check if the pipe joint is leaking at the connection [SOP-1]", completed: false },
    ];
    const guided = convertToGuidedSteps(steps);
    guided[0].escalation_if_failed === true
      ? pass("convertToGuidedSteps: leak-critical step → escalation_if_failed")
      : fail("convertToGuidedSteps: leak + pipe should flag escalation_if_failed");
  }

  {
    // Media request step
    const steps: TroubleshootingStep[] = [
      { step: 1, description: "Take a photo of the leaking pipe joint and send it to us [SOP-3]", completed: false },
    ];
    const guided = convertToGuidedSteps(steps);
    guided[0].step_kind === "media_request"
      ? pass("convertToGuidedSteps: photo step → media_request kind")
      : fail("convertToGuidedSteps: photo step should be media_request", guided[0].step_kind);
  }

  // ── Tenant-inappropriate step filtering ──
  printSection("Step Filtering");

  {
    const steps: TroubleshootingStep[] = [
      { step: 1, description: "Seal any visible gaps around pipes with temporary caulk [SOP-1]", completed: false },
    ];
    const guided = convertToGuidedSteps(steps);
    guided[0].step_kind === "terminal"
      ? pass("convertToGuidedSteps: seal/caulk step → terminal (filtered)")
      : fail("convertToGuidedSteps: seal/caulk should be terminal", guided[0].step_kind);
  }

  {
    const steps: TroubleshootingStep[] = [
      { step: 1, description: "Seal any visible holes or gaps with steel wool and tape [SOP-2]", completed: false },
    ];
    const guided = convertToGuidedSteps(steps);
    guided[0].step_kind === "terminal"
      ? pass("convertToGuidedSteps: steel wool step → terminal (filtered)")
      : fail("convertToGuidedSteps: steel wool should be terminal", guided[0].step_kind);
  }

  {
    const steps: TroubleshootingStep[] = [
      { step: 1, description: "If you notice any specific entry points, consider sealing them [SOP-1]", completed: false },
    ];
    const guided = convertToGuidedSteps(steps);
    guided[0].step_kind === "terminal"
      ? pass("convertToGuidedSteps: 'consider sealing' → terminal (filtered)")
      : fail("convertToGuidedSteps: 'consider sealing' should be terminal", guided[0].step_kind);
  }

  {
    // Non-repair steps should NOT be filtered
    const steps: TroubleshootingStep[] = [
      { step: 1, description: "Place bait traps near areas where you've seen activity [SOP-1]", completed: false },
    ];
    const guided = convertToGuidedSteps(steps);
    guided[0].step_kind === "action"
      ? pass("convertToGuidedSteps: bait trap step remains action (not filtered)")
      : fail("convertToGuidedSteps: bait trap should stay action", guided[0].step_kind);
  }

  {
    const steps: TroubleshootingStep[] = [
      { step: 1, description: "Store all food in sealed containers [SOP-1]", completed: false },
    ];
    const guided = convertToGuidedSteps(steps);
    guided[0].step_kind === "action"
      ? pass("convertToGuidedSteps: store food step remains action (not filtered)")
      : fail("convertToGuidedSteps: store food should stay action", guided[0].step_kind);
  }

  // ── mapToStepResult — pure mapping ──
  printSection("mapToStepResult");

  mapToStepResult("completed") === "completed"
    ? pass("mapToStepResult: completed → completed")
    : fail("mapToStepResult: expected completed", mapToStepResult("completed"));

  mapToStepResult("helped") === "helped"
    ? pass("mapToStepResult: helped → helped")
    : fail("mapToStepResult: expected helped", mapToStepResult("helped"));

  mapToStepResult("partially_helped") === "partial"
    ? pass("mapToStepResult: partially_helped → partial")
    : fail("mapToStepResult: expected partial", mapToStepResult("partially_helped"));

  mapToStepResult("did_not_help") === "did_not_help"
    ? pass("mapToStepResult: did_not_help → did_not_help")
    : fail("mapToStepResult: expected did_not_help", mapToStepResult("did_not_help"));

  mapToStepResult("unable_to_access") === "unable_to_access"
    ? pass("mapToStepResult: unable_to_access → unable_to_access")
    : fail("mapToStepResult: expected unable_to_access", mapToStepResult("unable_to_access"));

  mapToStepResult("cannot_assess") === "unable_to_access"
    ? pass("mapToStepResult: cannot_assess → unable_to_access")
    : fail("mapToStepResult: expected unable_to_access for cannot_assess", mapToStepResult("cannot_assess"));

  mapToStepResult("did_not_try") === "did_not_try"
    ? pass("mapToStepResult: did_not_try → did_not_try")
    : fail("mapToStepResult: expected did_not_try", mapToStepResult("did_not_try"));

  mapToStepResult("skip") === "did_not_try"
    ? pass("mapToStepResult: skip → did_not_try")
    : fail("mapToStepResult: expected did_not_try for skip", mapToStepResult("skip"));

  mapToStepResult("unknown") === "unclear"
    ? pass("mapToStepResult: unknown → unclear")
    : fail("mapToStepResult: expected unclear for unknown", mapToStepResult("unknown"));

  // ── parseInterpretation — JSON parsing ──
  printSection("parseInterpretation");

  {
    const valid = parseInterpretation(JSON.stringify({
      result: "completed",
      confidence: "high",
      extracted_note: null,
      mentioned_safety_issue: false,
      mentioned_emergency_issue: false,
    }));
    valid !== null && valid.result === "completed" && valid.confidence === "high"
      ? pass("parseInterpretation: valid JSON → parsed correctly")
      : fail("parseInterpretation: should parse valid JSON", valid);
  }

  {
    const withNote = parseInterpretation(JSON.stringify({
      result: "completed",
      confidence: "high",
      extracted_note: "Ants entering from hole under carpet",
      mentioned_safety_issue: false,
      mentioned_emergency_issue: false,
    }));
    withNote !== null && withNote.extracted_note === "Ants entering from hole under carpet"
      ? pass("parseInterpretation: extracts note from valid JSON")
      : fail("parseInterpretation: should extract note", withNote);
  }

  {
    const invalid = parseInterpretation("this is not json");
    invalid === null
      ? pass("parseInterpretation: invalid string → null")
      : fail("parseInterpretation: should return null for invalid string", invalid);
  }

  {
    const badResult = parseInterpretation(JSON.stringify({
      result: "banana",
      confidence: "high",
    }));
    badResult === null
      ? pass("parseInterpretation: invalid result value → null")
      : fail("parseInterpretation: should reject invalid result", badResult);
  }

  {
    const badConfidence = parseInterpretation(JSON.stringify({
      result: "completed",
      confidence: "super",
    }));
    badConfidence === null
      ? pass("parseInterpretation: invalid confidence → null")
      : fail("parseInterpretation: should reject invalid confidence", badConfidence);
  }

  {
    const fenced = parseInterpretation('```json\n{"result":"helped","confidence":"medium","extracted_note":null,"mentioned_safety_issue":false,"mentioned_emergency_issue":false}\n```');
    fenced !== null && fenced.result === "helped"
      ? pass("parseInterpretation: strips markdown code fences")
      : fail("parseInterpretation: should handle fenced JSON", fenced);
  }

  {
    const emptyNote = parseInterpretation(JSON.stringify({
      result: "completed",
      confidence: "high",
      extracted_note: "  ",
      mentioned_safety_issue: false,
      mentioned_emergency_issue: false,
    }));
    emptyNote !== null && emptyNote.extracted_note === undefined
      ? pass("parseInterpretation: whitespace-only note → undefined")
      : fail("parseInterpretation: should drop whitespace-only note", emptyNote?.extracted_note);
  }

  // ── Safety override — regex catches before LLM ──
  printSection("Hybrid Safety Override");

  {
    // Regex catches "gas smell" deterministically — no LLM needed
    const safetyResult = classifyStepFeedback("I smell gas now!", makeStep());
    safetyResult === "unsafe"
      ? pass("safety override: 'I smell gas now!' → unsafe (regex)")
      : fail("safety override: should detect gas smell", safetyResult);
  }

  {
    const safetyResult2 = classifyStepFeedback("there are sparks coming from the outlet", makeStep());
    safetyResult2 === "unsafe"
      ? pass("safety override: 'sparks coming from outlet' → unsafe (regex)")
      : fail("safety override: should detect sparks", safetyResult2);
  }

  {
    const safetyResult3 = classifyStepFeedback("water is flooding everywhere", makeStep());
    safetyResult3 === "unsafe"
      ? pass("safety override: 'water is flooding everywhere' → unsafe (regex)")
      : fail("safety override: should detect flooding", safetyResult3);
  }

  return result;
}

// ── LLM integration tests (gated behind RUN_EXTERNAL) ──

export async function testHybridInterpretation(): Promise<TestResult> {
  printSection("Hybrid Step Interpretation (LLM)");
  const { pass, fail, result } = createRunner();

  const RUN_EXTERNAL = process.env.RUN_EXTERNAL === "1";
  if (!RUN_EXTERNAL) {
    console.log("  \x1b[33m⏭️  LLM interpretation tests (RUN_EXTERNAL !== 1)\x1b[0m");
    return result;
  }

  const observationStep = makeStep({
    index: 0,
    description: "Take note of where the ants are entering or clustering.",
    step_kind: "observation",
  });

  const actionStep = makeStep({
    index: 0,
    description: "Wipe up any crumbs, spills, and standing water in your living room.",
    step_kind: "action",
  });

  const checkStep = makeStep({
    index: 0,
    description: "Check whether the ceiling area is dry, damp, or actively wet.",
    step_kind: "observation",
  });

  // "can't really tell" → regex misses (word gap) → LLM classifies
  {
    const { result: r, source } = await classifyStepHybrid(
      "can't really tell from here",
      checkStep,
      "plumbing",
      null
    );
    r === "unable_to_access"
      ? pass("LLM hybrid: 'can't really tell' → unable_to_access")
      : fail("LLM hybrid: expected unable_to_access for 'can't really tell'", { result: r, source });
  }

  // "we found the ants are coming from a hole under the carpet" → completed + note
  {
    const { result: r, note, source } = await classifyStepHybrid(
      "we found the ants are coming from a hole under the carpet",
      observationStep,
      "pest_control",
      "ants"
    );
    // This already matches regex "completed" via the (i|we)\s+found pattern,
    // but if it reached the LLM, it should also work. Either path is valid.
    r === "completed"
      ? pass("LLM hybrid: 'we found ants coming from hole...' → completed")
      : fail("LLM hybrid: expected completed", { result: r, source });
  }

  // "we wiped everything" → regex fast-path (should not need LLM)
  {
    const { result: r, source } = await classifyStepHybrid(
      "we wiped everything",
      actionStep,
      "pest_control",
      "ants"
    );
    r === "completed" && source === "regex"
      ? pass("LLM hybrid: 'we wiped everything' → completed via regex fast-path")
      : fail("LLM hybrid: expected completed/regex", { result: r, source });
  }

  // "it's not that bad anymore but still a little damp" → partial or did_not_help
  {
    const { result: r, source } = await classifyStepHybrid(
      "it's not that bad anymore but still a little damp",
      checkStep,
      "plumbing",
      null
    );
    (r === "partial" || r === "did_not_help")
      ? pass(`LLM hybrid: 'still a little damp' → ${r} (source: ${source})`)
      : fail("LLM hybrid: expected partial or did_not_help", { result: r, source });
  }

  // "have tried that" → regex fast-path
  {
    const { result: r, source } = await classifyStepHybrid(
      "have tried that",
      actionStep,
      "pest_control",
      "ants"
    );
    r === "completed" && source === "regex"
      ? pass("LLM hybrid: 'have tried that' → completed via regex")
      : fail("LLM hybrid: expected completed/regex", { result: r, source });
  }

  // Invalid/malformed LLM should fall back safely — tested via parseInterpretation above
  // Here test that safety overrides still fire even in hybrid mode
  {
    const { result: r, source } = await classifyStepHybrid(
      "now I smell gas!",
      actionStep,
      "pest_control",
      "ants"
    );
    r === "unsafe" && source === "regex"
      ? pass("LLM hybrid: safety override — 'smell gas' → unsafe/regex")
      : fail("LLM hybrid: safety should override before LLM", { result: r, source });
  }

  // Observation step with detail that regex would miss
  {
    const { result: r, source } = await classifyStepHybrid(
      "yeah they seem to be mostly around the baseboard near the kitchen entrance",
      observationStep,
      "pest_control",
      "ants"
    );
    // LLM should interpret this as completed (tenant observed and reported)
    r === "completed"
      ? pass(`LLM hybrid: observation with detail → completed (source: ${source})`)
      : fail("LLM hybrid: expected completed for observation detail", { result: r, source });
  }

  return result;
}

// Standalone
const isMain = process.argv[1]?.replace(/\.ts$/, "").endsWith("test-guided-troubleshooting");
if (isMain) runStandalone(async () => {
  const r1 = testGuidedTroubleshooting();
  const r2 = await testHybridInterpretation();
  return {
    passed: r1.passed + r2.passed,
    failed: r1.failed + r2.failed,
    skipped: r1.skipped + r2.skipped,
  };
});
