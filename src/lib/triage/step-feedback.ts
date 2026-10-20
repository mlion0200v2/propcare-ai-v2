/**
 * Guided Troubleshooting — Deterministic Feedback Logic
 *
 * Pure functions (no LLM, no network). Pattern: same as detect-safety.ts, classify-issue.ts.
 *
 * All categories supported. Guided mode activates when grounded steps
 * contain at least one actionable (step_kind === "action") step.
 */

import type {
  GuidedStep,
  GuidedStepKind,
  GuidedTroubleshootingState,
  GuidedNextAction,
  TroubleshootingStepResult,
} from "./types";
import { detectEmergency, EMERGENCY_FOOTER } from "./emergency";

// ── Feedback classification (keyword-based, no LLM) ──

// Emergencies (gas, CO, fire/smoke, sparks, sewage, …) come from the shared
// detector in ./emergency; these add non-emergency "stop, this feels unsafe".
const UNSAFE_PATTERNS = [
  /\b(danger|dangerous|unsafe|scared|afraid)\b/i,
  /\b(shock|shocked)\b/i,
  /\b(flood|flooding|flooded|water everywhere)\b/i,
  /\b(collapse|collapsing|falling)\b/i,
  /\b(can'?t breathe|hard to breathe|dizzy|nauseous|headache)\b/i,
  /\b(getting worse|got worse|much worse|not safe)\b/i,
  /\bwater near (outlet|electric|wir)/i,
];

// Qualified partial outcomes that contain a negation ("not completely fixed")
// — checked before NEGATED_OUTCOME_PATTERNS so they stay "partial".
const QUALIFIED_PARTIAL_PATTERNS = [
  /\b(not completely|not fully|not entirely|not totally|still some|still a little|still a bit)\b/i,
  /\b(improved but|better but|less but|slowed but)\b/i,
  /\b(helped|better|improved|slowed( down)?)\s+(a little|a bit|some|somewhat|slightly)\b/i,
  /\b(a little|a bit|somewhat|slightly) (better|less|slower)\b/i,
];

// Negated outcomes ("hasn't stopped", "still not fixed", "nothing worked",
// "stopped working"). Checked BEFORE HELPED_PATTERNS, which would otherwise
// match the bare "stopped" / "fixed" / "worked".
const NEGATED_OUTCOME_PATTERNS = [
  /\b(not|never|isn'?t|is not|wasn'?t|was not|hasn'?t|has not|haven'?t|have not|didn'?t|did not|doesn'?t|does not|won'?t|will not|can'?t|cannot|ain'?t)\s+(?:\w+\s+){0,2}?(work|works|worked|working|fix|fixes|fixed|resolve|resolved|solve|solved|stop|stops|stopped|stopping|help|helps|helped|helping|change|changed)\b/i,
  /\bnothing\s+(?:\w+\s+)?(worked|helped|fixed|changed|stopped)\b/i,
  /\bstopped (working|responding|heating|cooling|draining|spinning|flushing|turning on)\b/i,
  /\bstill\s+(not|isn'?t|won'?t|doesn'?t|hasn'?t|leak\w*|drip\w*|running|broken|happening|there|wet|bad)\b/i,
  /\b(no|not any) (better|different)\b/i,
];

const HELPED_PATTERNS = [
  /\b(worked|fixed|resolved|solved)\b/i,
  /\bnot (leaking|dripping|running|making (the|that) (noise|sound)) (anymore|any more)\b/i,
  /\b(that (did it|helped|worked|fixed))\b/i,
  /\b(stopped|no more|all good|back to normal)\b/i,
  /\b(yes|yep|yeah)[\s,!.]*(?:it|that|this)?\s*(?:worked|helped|fixed|did it)/i,
  /\bstopped (dripping|leaking|running)\b/i,
  /\bno more (dripping|leaking|water)\b/i,
];

const PARTIAL_PATTERNS = [
  /\b(a little|somewhat|partially|sort of|kind of|a bit)\b/i,
  /\b(slowed|reduced|less|improved but|better but)\b/i,
  /\b(not completely|not fully|still some|still a little)\b/i,
  /\b(a little better|slightly better)\b/i,
  /\bless water\b/i,
  /\bslowed down\b/i,
];

const DID_NOT_HELP_PATTERNS = [
  /\b(didn'?t (work|help|fix|do anything|change|stop))\b/i,
  /\b(no (change|difference|luck|improvement|effect))\b/i,
  /\b(still (the same|happening|leaking|dripping|broken|running|there|present|here|bad|wet|damp|mold|mould|not fixed))\b/i,
  /\b(same (problem|issue|thing))\b/i,
  /\b(nope|nothing|useless)\b/i,
  /\b(didn'?t stop|hasn'?t stopped|not stopped)\b/i,
];

const ASKING_HOW_PATTERNS = [
  /\b(how (do|can|should|would) (I|we|you))\b/i,
  /\b(can you (explain|show|tell me|help me with))\b/i,
  /\b(what (do|should|would) (I|we) (do|use|look for|check))\b/i,
  /\b(do you know how)\b/i,
  /\b(what does that mean|what is that)\b/i,
  /\b(where (do|should|would) (I|we) (find|look|check|start))\b/i,
  /\b(I('m| am) not sure (how|what))\b/i,
  /\b(how to (do|check|find|tell|fix|clean|remove|open|close))\b/i,
];

const UNABLE_TO_ACCESS_PATTERNS = [
  /\b(can'?t|cannot|could ?not|couldn'?t) (find|reach|access|get to|locate|see|tell)\b/i,
  /\b(don'?t|do not) (know|see) where\b/i,
  /\bnot sure where\b/i,
  /\bunable to (find|locate|reach|access)\b/i,
  /\b(no (access|idea where|clue where))\b/i,
  /\b(where is|where'?s) (the|that|this)\b/i,
  /\b(locked|blocked)\b/i,
  /\b(don'?t|do not) see (it|them|that|the)\b/i,
  /\bhard to (see|tell|reach|find|access)\b/i,
  /^(not sure|don'?t know|no idea)\s*[.!]?\s*$/i,
];

const COMPLETED_PATTERNS = [
  /\b(done|did (it|that)|finished|completed|tried it)\b/i,
  /\b(ok|okay|alright|got it|ready)\b/i,
  /\b(what'?s next|next step|what now|and now)\b/i,
  /\b(yes|yep|yeah|yup)$/i,
  /\b(i turned (it|them) off)\b/i,
  /\bturned (it|them) off\b/i,
  /\b(have tried|already tried|already did|already done|already checked)\b/i,
  /\btried (it|that|this|them)\b/i,
  /^(tried|i tried)\s*[.!]?\s*$/i,
  // Natural past-tense action-completion: "we wiped everything", "i placed several"
  /\b(i|we|i've|we've)\s+(wiped|cleaned|placed|put|stored|checked|looked|found|moved|turned|opened|closed|sealed|set|removed|threw|replaced|washed|swept|sprayed|covered|unplugged|plugged)\b/i,
  // Bare past-tense verbs (no pronoun): "cleaned it up", "wiped it down"
  /\b(wiped|cleaned|placed|sealed|removed|replaced|swept|sprayed|covered|unplugged|plugged)\s+(it|them|everything|the)\b/i,
  // Short confirmations: "we did", "i did", "we did that"
  /^(i|we)\s+did(\s+(that|this|it))?\s*[.!]?\s*$/i,
];

const DID_NOT_TRY_PATTERNS = [
  /\b(skip|skipped|pass)\b/i,
  /\b(didn'?t try|haven'?t tried|not going to|rather not)\b/i,
  /\b(don'?t want to|not comfortable|not sure (how|if))\b/i,
  /\b(too (hard|difficult|complicated|risky))\b/i,
  /\b(couldn'?t do|could ?not do|did ?not do)\b/i,
  /\b(move on|moving on|next one|let'?s move on)\b/i,
];

/**
 * Classify tenant's feedback on a troubleshooting step.
 *
 * Priority order: unsafe > qualified partial > negated outcome (did_not_help)
 *   > did_not_help > helped > partial > asking_how > unable_to_access > completed > did_not_try
 * Negations are checked before "helped" so "hasn't stopped" / "still not fixed"
 * are never read as fixed.
 * Step-kind-aware: bare "no" is interpreted based on step context.
 * Default: "unclear" (does NOT silently advance).
 */
export function classifyStepFeedback(
  message: string,
  step: GuidedStep
): TroubleshootingStepResult {
  const text = message.trim();

  if (detectEmergency(text) || UNSAFE_PATTERNS.some((p) => p.test(text))) return "unsafe";
  if (QUALIFIED_PARTIAL_PATTERNS.some((p) => p.test(text))) return "partial";
  if (NEGATED_OUTCOME_PATTERNS.some((p) => p.test(text))) return "did_not_help";
  if (DID_NOT_HELP_PATTERNS.some((p) => p.test(text))) return "did_not_help";
  if (HELPED_PATTERNS.some((p) => p.test(text))) return "helped";
  if (PARTIAL_PATTERNS.some((p) => p.test(text))) return "partial";
  if (ASKING_HOW_PATTERNS.some((p) => p.test(text))) return "asking_how";
  if (UNABLE_TO_ACCESS_PATTERNS.some((p) => p.test(text))) return "unable_to_access";
  if (COMPLETED_PATTERNS.some((p) => p.test(text))) return "completed";
  if (DID_NOT_TRY_PATTERNS.some((p) => p.test(text))) return "did_not_try";

  // Step-kind-aware bare negative handling
  if (/^\s*(no|nah)\s*[.!]?\s*$/i.test(text)) {
    if (step.step_kind === "observation") return "did_not_help";
    return "did_not_try";
  }

  // Ambiguous — do NOT silently advance
  return "unclear";
}

// ── Step eligibility (dependency-aware) ──

/**
 * Find the next eligible step after `afterIndex`, skipping:
 * - terminal steps (shown in completion messages instead)
 * - observation steps whose prerequisite action was not completed
 */
export function findNextEligibleStep(
  state: GuidedTroubleshootingState,
  afterIndex: number
): number | null {
  for (let i = afterIndex + 1; i < state.steps.length; i++) {
    const step = state.steps[i];

    // Terminal and media_request steps are included in completion messages, not interactive
    if (step.step_kind === "terminal" || step.step_kind === "media_request") continue;

    // Observation steps: skip if prerequisite was not completed
    if (step.depends_on !== null) {
      const prereqLog = state.log.find((l) => l.step_index === step.depends_on);
      const prereqResult = prereqLog?.result;
      const wasCompleted =
        prereqResult === "completed" ||
        prereqResult === "helped" ||
        prereqResult === "partial";
      if (!wasCompleted) continue;
    }

    return i;
  }
  return null;
}

/**
 * Collect terminal step descriptions that were not interactively presented.
 * These get appended to completion messages.
 *
 * NOTE: media_request steps are excluded — media upload is already
 * handled during the AWAITING_MEDIA stage, so including them here
 * would create a duplicate request.
 */
export function getTerminalGuidance(
  state: GuidedTroubleshootingState
): string[] {
  const shownIndices = new Set(state.log.map((l) => l.step_index));
  return state.steps
    .filter(
      (s) =>
        s.step_kind === "terminal" &&
        !shownIndices.has(s.index)
    )
    .map((s) => s.description);
}

// ── Next-action decision tree ──

/**
 * Given the current guided state and feedback result, determine what happens next.
 */
export function determineNextAction(
  state: GuidedTroubleshootingState,
  feedback: TroubleshootingStepResult,
  previousResult?: TroubleshootingStepResult | null
): GuidedNextAction {
  const currentStep = state.steps[state.current_step_index];

  // Unsafe → always escalate immediately
  if (feedback === "unsafe") {
    return { type: "escalate", reason: "tenant_reported_unsafe" };
  }

  // Helped → issue resolved
  if (feedback === "helped") {
    return { type: "resolved" };
  }

  // Unclear → ask for clarification, but auto-advance after 2 consecutive unclear
  if (feedback === "unclear") {
    if (previousResult === "unclear") {
      // Escape hatch: don't trap the tenant in a clarification loop
      const nextIdx = findNextEligibleStep(state, state.current_step_index);
      if (nextIdx !== null) {
        return { type: "next_step" };
      }
      return { type: "all_steps_done" };
    }
    return { type: "clarify" };
  }

  // Asking how → provide help, but escape hatch if already helped once
  if (feedback === "asking_how") {
    if (previousResult === "asking_how") {
      const nextIdx = findNextEligibleStep(state, state.current_step_index);
      return nextIdx !== null ? { type: "next_step" } : { type: "all_steps_done" };
    }
    return { type: "provide_help" };
  }

  // Did not help on a step flagged as escalation_if_failed → escalate
  if (feedback === "did_not_help" && currentStep?.escalation_if_failed) {
    return { type: "escalate", reason: "critical_step_failed" };
  }

  // Unable to access on a stop_if_unsure step → escalate (don't force tenant)
  if (feedback === "unable_to_access" && currentStep?.stop_if_unsure) {
    return { type: "escalate", reason: "prerequisite_inaccessible" };
  }

  // Check if there's an eligible next step
  const nextIdx = findNextEligibleStep(state, state.current_step_index);
  if (nextIdx !== null) {
    return { type: "next_step" };
  }

  // No more eligible steps
  return { type: "all_steps_done" };
}

// ── Message builders ──

const GUIDED_INTRO = [
  "I can walk you through a couple of safe checks while your property manager reviews this.",
  "",
].join("\n");

// Step-kind-specific tail prompts — varied by step type
const STEP_PROMPTS: Record<string, string> = {
  action: "Let me know once you've done that, or if you're not able to.",
  observation: "Just let me know what you see.",
  terminal: "",
  media_request: "",
};

/**
 * Build the message presenting a single troubleshooting step.
 * Varies the tail prompt by step_kind. No raw citations shown.
 */
export function buildStepMessage(step: GuidedStep, isFirst: boolean): string {
  const parts: string[] = [];

  if (isFirst) {
    parts.push(GUIDED_INTRO);
  }

  parts.push(step.description);

  if (step.stop_if_unsure) {
    parts.push(
      "",
      "If you're not sure how to do this safely, just let me know and we'll skip it."
    );
  }

  const prompt = STEP_PROMPTS[step.step_kind] ?? STEP_PROMPTS.action;
  if (prompt) {
    parts.push("", prompt);
  }

  return parts.join("\n");
}

/**
 * Build a clarification reply when feedback was ambiguous.
 */
export function buildClarifyReply(step: GuidedStep): string {
  if (step.step_kind === "observation") {
    return "Just to make sure I understand — what did you notice?";
  }
  return "Just to confirm — were you able to try that step?";
}

// ── Step-kind-aware acknowledgements ──

/** Options for building a feedback reply */
export interface FeedbackReplyOpts {
  currentStepKind?: GuidedStepKind;
  extractedNote?: string | null;
}

/**
 * Build an acknowledgement line that varies by step kind and extracted note.
 */
function buildCompletedAck(
  stepKind: GuidedStepKind | undefined,
  note: string | null | undefined
): string {
  if (note) {
    return `Got it — I've noted that. (${note})`;
  }
  switch (stepKind) {
    case "observation":
      return "Got it — I've noted that.";
    case "action":
      return "Done — thanks for taking care of that.";
    default:
      return "Got it, thanks.";
  }
}

/**
 * Build the conversational reply after processing tenant feedback.
 * No raw citations in user-facing text. Includes terminal guidance in completion messages.
 *
 * The acknowledgement varies by step kind and whether the tenant provided
 * an observation or useful detail (extractedNote).
 */
export function buildFeedbackReply(
  feedback: TroubleshootingStepResult,
  action: GuidedNextAction,
  nextStep?: GuidedStep,
  terminalGuidance?: string[],
  opts?: FeedbackReplyOpts
): string {
  const parts: string[] = [];
  const stepKind = opts?.currentStepKind;
  const note = opts?.extractedNote;

  // Acknowledge the feedback
  switch (feedback) {
    case "unsafe":
      parts.push(
        "**I'm flagging this for your property manager right away.** Your safety comes first.",
        "",
        "Please do not attempt any further steps.",
        "",
        EMERGENCY_FOOTER,
        "",
        "Your ticket has been escalated for urgent review. The property manager should contact you within 2 hours."
      );
      return parts.join("\n");

    case "helped":
      parts.push(
        "Great, glad that worked! I'll note that in your ticket."
      );
      if (terminalGuidance && terminalGuidance.length > 0) {
        parts.push("");
        for (const g of terminalGuidance) {
          parts.push(g);
        }
      }
      parts.push(
        "",
        "Your property manager will still review this to make sure everything is fully resolved."
      );
      return parts.join("\n");

    case "partial":
      parts.push("Okay, sounds like that helped a bit but didn't fully fix it.");
      break;

    case "did_not_help":
      if (stepKind === "observation") {
        parts.push("Got it — thanks for checking.");
      } else {
        parts.push("Got it, that one didn't do the trick.");
      }
      break;

    case "unable_to_access":
      if (action.type === "escalate") {
        parts.push(
          "No worries — please don't force anything you're not sure about."
        );
      } else {
        parts.push("No problem — we'll skip that one and move on.");
      }
      break;

    case "did_not_try":
      parts.push("That's okay, we'll skip that step.");
      break;

    case "completed":
      parts.push(buildCompletedAck(stepKind, note));
      break;

    default:
      parts.push("Got it.");
      break;
  }

  // What happens next
  if (action.type === "next_step" && nextStep) {
    parts.push("");
    parts.push(nextStep.description);

    if (nextStep.stop_if_unsure) {
      parts.push(
        "",
        "If you're not sure how to do this safely, just let me know and we'll skip it."
      );
    }

    const prompt = STEP_PROMPTS[nextStep.step_kind] ?? STEP_PROMPTS.action;
    if (prompt) {
      parts.push("", prompt);
    }
  } else if (action.type === "escalate") {
    if (terminalGuidance && terminalGuidance.length > 0) {
      parts.push("");
      for (const g of terminalGuidance) {
        parts.push(g);
      }
    }
    parts.push(
      "",
      "I'm going to pass this along to your property manager so they can help directly.",
      "",
      "Your ticket has been updated and they'll be in touch soon."
    );
  } else if (action.type === "all_steps_done") {
    if (terminalGuidance && terminalGuidance.length > 0) {
      parts.push("");
      for (const g of terminalGuidance) {
        parts.push(g);
      }
    }
    parts.push(
      "",
      "We've gone through all the steps I have for this issue. I'll pass this along to your property manager so they can take it from here.",
      "",
      "Your ticket has been updated with everything we tried. They'll be in touch soon."
    );
  }

  return parts.join("\n");
}

/**
 * Build a reply that wraps LLM-generated help text with a re-offer prompt.
 */
export function buildHelpReply(helpText: string, step: GuidedStep): string {
  const parts = [helpText, ""];
  if (step.stop_if_unsure) {
    parts.push("If you're not comfortable trying this, just let me know and we'll skip it.");
  } else {
    parts.push("Give it a try if you can, or let me know if you'd rather move on.");
  }
  return parts.join("\n");
}
