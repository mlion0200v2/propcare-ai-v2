/**
 * Test: launch-blocker safety fixes (pure — no network)
 * Run:  npx tsx tests/integration/test-launch-safety.ts
 *
 * Covers:
 *   - shared emergency detector: every required phrasing fires, benign
 *     phrases ("smoke detector chirping", "fireplace") do not
 *   - unclear answers to a safety question escalate, never clear
 *   - emergency reply carries leave-now + FortisBC 1-800-663-9911 + 911
 *   - negations are checked before "helped" in step feedback
 *   - "not right" (and other corrections) never submit the summary
 *   - never-instruct filter on all generated steps; °F → °C
 *   - chat message length cap, tenant-only sign-up, LIKE escaping, rate limits
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  detectEmergency,
  hasEmergencyKeywords,
  classifySafetyAnswer,
  buildEmergencyReply,
  buildEmergencyFollowUpReply,
  FORTISBC_EMERGENCY_PHONE,
  type EmergencyKind,
} from "../../src/lib/triage/emergency";
import { hasEmergencyKeywords as stateMachineHasEmergency, buildInitialGathered } from "../../src/lib/triage/state-machine";
import { detectSafety, parseSafetyResponse } from "../../src/lib/triage/detect-safety";
import { classifyStepFeedback } from "../../src/lib/triage/step-feedback";
import { isSummaryConfirmation } from "../../src/lib/triage/confirmation";
import { findUnsafeInstruction, filterUnsafeSteps, sanitizeReplyText, toCelsius } from "../../src/lib/triage/step-safety";
import { getFallbackSOP } from "../../src/lib/triage/sop-fallback";
import { triageChatRequestSchema, signUpSchema, MAX_TRIAGE_MESSAGE_LENGTH } from "../../src/lib/utils/validation";
import { escapeLikePattern } from "../../src/lib/utils/escape-like";
import { createRateLimiter } from "../../src/lib/rate-limit";
import type { GuidedStep } from "../../src/lib/triage/types";
import { createRunner, printSection, runStandalone, type TestResult } from "./helpers";

const JANUARY = new Date("2027-01-15T12:00:00Z");
const JULY = new Date("2026-07-15T12:00:00Z");

const actionStep: GuidedStep = {
  index: 0,
  description: "Turn off the shut-off valve under the sink.",
  citation: null,
  step_kind: "action",
  depends_on: null,
  stop_if_unsure: false,
  escalation_if_failed: false,
  request_media_after: false,
};
const observationStep: GuidedStep = { ...actionStep, description: "Check whether the drip has stopped.", step_kind: "observation" };

export function testLaunchSafety(): TestResult {
  const { pass, fail, result } = createRunner();
  const check = (ok: boolean, label: string, detail?: unknown) => (ok ? pass(label) : fail(label, detail));

  // ── 7. Shared emergency detector ──
  printSection("Emergency detector — must fire");
  const mustFire: Array<[string, EmergencyKind]> = [
    ["It smells like gas in the kitchen", "gas"],
    ["there's a smell of gas near the stove", "gas"],
    ["I can smell gas", "gas"],
    ["strong gas smell in the hallway", "gas"],
    ["gas leak!!", "gas"],
    ["it smells like rotten eggs in here", "gas"],
    ["Rotten egg smell by the furnace", "gas"],
    ["I hear hissing gas behind the stove", "gas"],
    ["the gas line is hissing", "gas"],
    ["My CO alarm is going off", "carbon_monoxide"],
    ["CO detector going off in the bedroom", "carbon_monoxide"],
    ["the carbon monoxide detector keeps beeping", "carbon_monoxide"],
    ["Carbon monoxide alarm went off", "carbon_monoxide"],
    ["the outlet is throwing sparks", "electrical"],
    ["Sparks coming from the light switch", "electrical"],
    ["outlet sparking when I plug in", "electrical"],
    ["water is coming through the ceiling light", "water_electrical"],
    ["Water through a ceiling light in the bathroom", "water_electrical"],
    ["water dripping from the light fixture", "water_electrical"],
    ["the ceiling light is full of water", "water_electrical"],
    ["water leaking into the outlet", "water_electrical"],
    ["the sewer is backing up into my tub", "sewage"],
    ["sewage backing up in the basement", "sewage"],
    ["Sewer backup in the laundry room", "sewage"],
    ["toilet overflowing onto the floor", "sewage"],
    ["The toilet is overflowing all over the floor", "sewage"],
    ["there's smoke coming from the dryer", "fire"],
    ["fire in the kitchen", "fire"],
    ["smoke alarm is going off and I smell burning", "fire"],
    ["burning smell from the outlet", "fire"],
    ["pipe burst and water is pouring everywhere", "flooding"],
    ["the ceiling fell in the bathroom", "structural"],
  ];
  for (const [text, kind] of mustFire) {
    const m = detectEmergency(text, JULY);
    check(m?.kind === kind, `fires (${kind}): "${text}"`, m);
  }

  printSection("Emergency detector — no heat in winter");
  check(detectEmergency("no heat in winter", JULY)?.kind === "no_heat", `"no heat in winter" fires even in July (explicit winter)`);
  check(detectEmergency("We have no heat in winter and it's freezing", JULY)?.kind === "no_heat", `"no heat … freezing" fires`);
  check(detectEmergency("no heat", JANUARY)?.kind === "no_heat", `"no heat" fires in January`);
  check(detectEmergency("the furnace is not working", JANUARY)?.kind === "no_heat", `"furnace is not working" fires in January`);
  check(detectEmergency("heat isn't working and it's snowing", JULY)?.kind === "no_heat", `"heat isn't working … snowing" fires`);
  check(detectEmergency("no heat", JULY) === null, `"no heat" alone in July does not fire`);

  printSection("Emergency detector — must NOT fire");
  const mustNotFire = [
    "smoke detector chirping",
    "My smoke detector is chirping every minute",
    "the smoke alarm keeps chirping, I think the battery is low",
    "fireplace won't turn on",
    "the gas fireplace remote is broken",
    "our fireplace insert is making a noise",
    "kitchen faucet is dripping",
    "there was some flooding in the bathroom last week",
    "the water heater pilot light is out",
    "sparkling water dispenser on the fridge is broken",
    "I don't smell gas, the stove just won't light",
    "no gas smell, the burner just clicks",
    "There's no smoke, just a weird noise from the dryer",
    "CO detector chirping — low battery",
  ];
  for (const text of mustNotFire) {
    const m = detectEmergency(text, JULY);
    check(m === null, `does not fire: "${text}"`, m);
  }

  printSection("Emergency detector — uncertainty escalates");
  check(detectEmergency("not sure if I smell gas", JULY)?.kind === "gas", `"not sure if I smell gas" fires`);
  check(detectEmergency("I think it might smell like gas?", JULY)?.kind === "gas", `"I think it might smell like gas?" fires`);

  printSection("One shared detector everywhere");
  check(stateMachineHasEmergency === hasEmergencyKeywords, "state-machine re-exports the shared detector (no duplicate list)");
  const sources = ["state-machine.ts", "detect-safety.ts"].map((f) =>
    readFileSync(join(__dirname, "..", "..", "src", "lib", "triage", f), "utf8")
  );
  check(sources.every((src) => !/const EMERGENCY_KEYWORDS\b/.test(src)), "no duplicate EMERGENCY_KEYWORDS lists remain");
  {
    const g = { ...buildInitialGathered(), category: "plumbing" };
    check(detectSafety("It smells like gas near the water heater", g).detected, "detectSafety uses the shared detector (smells like gas)");
    check(!detectSafety("smoke detector chirping in the hallway", { ...g, category: "general" }).detected, "detectSafety: smoke detector chirping is not an emergency");
    check(!detectSafety("the fireplace won't light", { ...g, category: "general" }).detected, "detectSafety: fireplace is not an emergency");
  }

  // ── Unclear safety answers escalate, never clear ──
  printSection("Safety answers — unclear escalates");
  const answerCases: Array<[string, "concern" | "no_concern" | "unclear"]> = [
    ["no", "no_concern"],
    ["No, nothing like that", "no_concern"],
    ["nope", "no_concern"],
    ["it's not spreading", "no_concern"],
    ["yes", "concern"],
    ["yeah it's spreading into the hall", "concern"],
    ["I see sparks", "concern"],
    ["not sure", "unclear"],
    ["maybe?", "unclear"],
    ["I don't know", "unclear"],
    ["kind of, a little", "unclear"],
    ["hard to tell", "unclear"],
    ["no but it smells a bit weird", "unclear"],
    ["what do you mean?", "unclear"],
    ["the cat is asleep", "unclear"],
  ];
  for (const [text, expected] of answerCases) {
    const got = classifySafetyAnswer(text, JULY);
    check(got === expected, `classifySafetyAnswer("${text}") → ${expected}`, got);
  }
  for (const text of ["not sure", "maybe", "I don't know", "hard to tell", "kind of"]) {
    check(parseSafetyResponse(text) === true, `parseSafetyResponse("${text}") escalates (true)`);
  }
  check(parseSafetyResponse("no") === false, `parseSafetyResponse("no") clears (false)`);

  // ── 8. Emergency reply ──
  printSection("Emergency reply content");
  const kinds: EmergencyKind[] = [
    "gas", "carbon_monoxide", "fire", "electrical", "water_electrical",
    "sewage", "flooding", "no_heat", "structural", "unconfirmed_safety",
  ];
  for (const kind of kinds) {
    const reply = buildEmergencyReply(kind, true);
    check(
      reply.includes(FORTISBC_EMERGENCY_PHONE) && reply.includes("911") && /leave now/i.test(reply),
      `emergency reply (${kind}) has leave-now, FortisBC ${FORTISBC_EMERGENCY_PHONE} and 911`
    );
    check(!/troubleshoot|step 1|try (this|the following)/i.test(reply), `emergency reply (${kind}) has no troubleshooting`);
  }
  check(FORTISBC_EMERGENCY_PHONE === "1-800-663-9911", "FortisBC number is 1-800-663-9911");
  check(/alerted your property manager/i.test(buildEmergencyReply("gas", true)), "reply says the manager was alerted when the email went out");
  check(buildEmergencyFollowUpReply().includes(FORTISBC_EMERGENCY_PHONE), "follow-up reply in EMERGENCY state repeats the emergency numbers");

  // ── 9. Negations before HELPED ──
  printSection("Step feedback — negations before 'helped'");
  const notFixed = [
    "hasn't stopped",
    "it hasn't stopped leaking",
    "still not fixed",
    "it's still not fixed",
    "not fixed",
    "nothing worked",
    "that didn't work",
    "it didn't stop",
    "it has not stopped dripping",
    "it stopped working completely",
    "nope, still leaking",
    "no it isn't fixed",
    "still dripping",
  ];
  for (const text of notFixed) {
    const r = classifyStepFeedback(text, actionStep);
    check(r === "did_not_help", `"${text}" → did_not_help (not helped)`, r);
  }
  for (const text of notFixed) {
    const r = classifyStepFeedback(text, observationStep);
    check(r !== "helped", `observation step: "${text}" is never helped`, r);
  }
  const fixed = ["it stopped dripping", "that worked!", "yes that fixed it", "no more leaking", "it's not leaking anymore", "all good now"];
  for (const text of fixed) {
    const r = classifyStepFeedback(text, actionStep);
    check(r === "helped", `"${text}" → helped`, r);
  }
  for (const text of ["not completely fixed", "it helped a little but still dripping some", "a bit better but still wet"]) {
    const r = classifyStepFeedback(text, actionStep);
    check(r === "partial", `"${text}" → partial`, r);
  }
  check(classifyStepFeedback("I smell gas now", actionStep) === "unsafe", `"I smell gas now" during a step → unsafe`);
  check(classifyStepFeedback("my smoke detector is chirping", actionStep) !== "unsafe", "smoke detector chirping during a step is not unsafe");

  // ── 9b. Summary confirmation ──
  printSection("Summary confirmation — 'not right' never submits");
  const notConfirm = [
    "not right",
    "that's not right",
    "no",
    "no, that's wrong",
    "not correct",
    "that isn't right",
    "right location but wrong time",
    "looks good but the location is the bathroom",
    "wait, it's the bedroom",
    "actually it started yesterday",
    "it's not good",
    "",
  ];
  for (const text of notConfirm) {
    check(!isSummaryConfirmation(text), `does not submit: "${text}"`);
  }
  for (const text of ["yes", "Looks good", "that's right", "correct", "submit", "yep, send it", "perfect"]) {
    check(isSummaryConfirmation(text), `submits: "${text}"`);
  }
  check(isSummaryConfirmation("", "confirm"), "confirm button submits");
  {
    const routeSrc = readFileSync(join(__dirname, "..", "..", "src", "app", "api", "triage", "chat", "route.ts"), "utf8");
    check(routeSrc.includes("isSummaryConfirmation(summaryAction, confirmSummary)"), "route uses the negation-aware confirmation parser");
    check(!routeSrc.includes("details: String(err)"), "chat route returns generic errors (no String(err))");
  }

  // ── 10. Never-instruct filter ──
  printSection("Never-instruct filter");
  const unsafeSteps = [
    "For gas water heaters, check if the pilot light is lit.",
    "Relight the pilot light following the label on the tank.",
    "Make sure the oven is plugged in (electric) or the gas valve is open (gas).",
    "Turn off the gas at the meter.",
    "If you smell burning or see sparks, turn off the breaker.",
    "If water is near electrical fixtures, turn off the breaker for that area.",
    "Flip the breaker for the bathroom since water is dripping from the light.",
    "Pull the fridge out and inspect the water line connection.",
    "Pull out the dishwasher to check the hose.",
    "If a key is stuck, try lubricant (WD-40) gently.",
    "Spray some WD-40 into the lock.",
    "You might find a helpful video by searching YouTube for 'reset GFCI outlet'.",
    "Remove the outlet cover plate and check the wires.",
    "Pour a drain cleaner like Drano down the sink.",
    "Climb up on the roof and clear the gutter.",
  ];
  for (const text of unsafeSteps) {
    check(findUnsafeInstruction(text) !== null, `blocked: "${text}"`);
  }
  const safeSteps = [
    "Do NOT try to relight a pilot light or touch any gas controls or gas lines.",
    "Do not attempt to repair gas appliances yourself.",
    "Place a bucket or towels under the leak.",
    "Check whether the breaker labelled 'water heater' has tripped. Reset it once only.",
    "Check that the appliance is plugged in and the outlet is working.",
    "Take a short video of the noise if possible.",
    "Move any items away from the stove so nothing is touching it.",
    "Locate the shut-off valve for the affected fixture and turn it off.",
  ];
  for (const text of safeSteps) {
    check(findUnsafeInstruction(text) === null, `allowed: "${text}"`, findUnsafeInstruction(text));
  }
  check(
    findUnsafeInstruction("Don't forget to turn off the gas valve.") !== null,
    "a disguised instruction (\"don't forget to turn off the gas valve\") is still blocked"
  );
  {
    const filtered = filterUnsafeSteps([
      { step: 1, description: "Check the pilot light.", completed: false },
      { step: 2, description: "Set the thermostat to 70°F.", completed: false },
      { step: 3, description: "Place towels under the leak.", completed: false },
    ]);
    check(filtered.steps.length === 2 && filtered.removed.length === 1, "filterUnsafeSteps drops the unsafe step and keeps the rest");
    check(filtered.steps[0].step === 1 && filtered.steps[1].step === 2, "filterUnsafeSteps renumbers");
    check(filtered.steps[0].description.includes("21 °C") && !filtered.steps[0].description.includes("°F"), "filterUnsafeSteps converts °F to °C", filtered.steps[0]);
    const reply = sanitizeReplyText("Here you go:\n1. Check the pilot light.\n2. Place towels under the leak.");
    check(!/pilot/i.test(reply) && /towels/.test(reply), "sanitizeReplyText removes unsafe lines from the reply");
  }
  check(toCelsius("between 120°F and 140°F") === "between 49 °C and 60 °C", "toCelsius: 120°F and 140°F", toCelsius("between 120°F and 140°F"));
  check(toCelsius("set it to 120-140 degrees F") === "set it to 49–60 °C", "toCelsius: range", toCelsius("set it to 120-140 degrees F"));
  check(toCelsius("keep it at 21 °C") === "keep it at 21 °C", "toCelsius leaves °C alone");

  printSection("Fallback SOPs pass the filter");
  const categories = ["plumbing", "electrical", "hvac", "appliance", "structural", "pest_control", "locksmith", "roofing", "painting", "flooring", "landscaping", "general", "other"];
  const subcategories = [null, "leak", "clog", "broken_fixture", "running_toilet", "no_hot_water", "water_pressure", "mold", "window", "fixture", "ants", "mice", "water_pooling", "tree_hazard", "irrigation", "noise"];
  const equipment = [null, "range hood", "refrigerator", "dishwasher", "oven", "stove", "microwave", "washer", "dryer", "garbage disposal"];
  const offenders: string[] = [];
  let combos = 0;
  for (const category of categories) {
    for (const sub of subcategories) {
      for (const eq of equipment) {
        for (const emergency of [false, true]) {
          const sop = getFallbackSOP(category, emergency, sub, eq, sub);
          combos++;
          for (const s of sop.steps) {
            const rule = findUnsafeInstruction(s.description);
            if (rule) offenders.push(`${category}/${sub}/${eq}: [${rule}] ${s.description}`);
            if (/°\s*F\b|\bfahrenheit\b/i.test(s.description)) offenders.push(`${category}/${sub}/${eq}: °F in "${s.description}"`);
          }
        }
      }
    }
  }
  check(offenders.length === 0, `no unsafe or °F step in ${combos} SOP combinations`, [...new Set(offenders)].slice(0, 5));
  {
    const all = getFallbackSOP("plumbing", false, "no_hot_water").steps.map((s) => s.description).join(" ");
    check(!/check if the pilot light is lit/i.test(all), "no-hot-water SOP no longer asks to check the gas pilot light");
    const lock = getFallbackSOP("locksmith", false).steps.map((s) => s.description).join(" ");
    check(!/wd-?40/i.test(lock), "locksmith SOP no longer suggests WD-40");
    const emergencySop = getFallbackSOP("general", true).steps.map((s) => s.description).join(" ");
    check(emergencySop.includes(FORTISBC_EMERGENCY_PHONE), "emergency SOP prefix includes the FortisBC number");
  }
  {
    const helpSrc = readFileSync(join(__dirname, "..", "..", "src", "lib", "triage", "step-help.ts"), "utf8");
    check(!/End with a YouTube/i.test(helpSrc) && /Do NOT suggest YouTube/.test(helpSrc), "step-help prompt no longer suggests YouTube");
    check(/isUnsafeInstruction/.test(helpSrc), "step-help output goes through the never-instruct filter");
  }

  // ── 5. Input limits, sign-up, LIKE escaping, rate limits ──
  printSection("Request validation and limits");
  const ok = triageChatRequestSchema.safeParse({ message: "a".repeat(MAX_TRIAGE_MESSAGE_LENGTH) });
  const tooLong = triageChatRequestSchema.safeParse({ message: "a".repeat(MAX_TRIAGE_MESSAGE_LENGTH + 1) });
  check(MAX_TRIAGE_MESSAGE_LENGTH === 2000, "message cap is 2000 characters");
  check(ok.success && !tooLong.success, "chat schema accepts 2000 chars and rejects 2001");
  check(!triageChatRequestSchema.safeParse({ message: "hi", ticket_id: "not-a-uuid" }).success, "chat schema rejects a non-UUID ticket_id");
  check(!triageChatRequestSchema.safeParse({ confirm_profile: "maybe" }).success, "chat schema rejects unknown confirm_profile");
  {
    const parsed = signUpSchema.safeParse({ email: "a@test.local", password: "password123", full_name: "A", role: "manager" });
    check(parsed.success && !("role" in parsed.data), "sign-up schema ignores a submitted role (tenants only)");
  }
  check(escapeLikePattern("100% Main_St\\") === "100\\% Main\\_St\\\\", "escapeLikePattern escapes % _ and \\", escapeLikePattern("100% Main_St\\"));
  {
    let t = 0;
    const limiter = createRateLimiter([{ limit: 3, windowMs: 60_000 }], () => t);
    const first = [limiter.check("u1"), limiter.check("u1"), limiter.check("u1")].every((r) => r.allowed);
    const fourth = limiter.check("u1");
    const otherUser = limiter.check("u2");
    t = 61_000;
    const afterWindow = limiter.check("u1");
    check(first && !fourth.allowed && fourth.retryAfterSeconds > 0, "rate limiter blocks the 4th request in the window");
    check(otherUser.allowed, "rate limiter is per user");
    check(afterWindow.allowed, "rate limiter allows again after the window");
  }
  {
    const mediaSrc = readFileSync(join(__dirname, "..", "..", "src", "app", "api", "triage", "media", "route.ts"), "utf8");
    check(/triageMediaLimiter\.check\(user\.id\)/.test(mediaSrc), "media route applies the per-user rate limit");
    check(!mediaSrc.includes("String(err)"), "media route returns generic errors");
    const emailSrc = readFileSync(join(__dirname, "..", "..", "src", "lib", "email", "send-ticket-email.ts"), "utf8");
    check(/escapeLikePattern\(streetAddress\)/.test(emailSrc), "manager lookup escapes the reported address in ilike");
  }

  return result;
}

// Standalone
const isMain = process.argv[1]?.replace(/\.ts$/, "").endsWith("test-launch-safety");
if (isMain) runStandalone(async () => testLaunchSafety());
