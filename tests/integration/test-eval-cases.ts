/**
 * Test: the eval cases and their code checks (pure, no network)
 * Run:  npx tsx tests/integration/test-eval-cases.ts
 *
 * Covers:
 *   - every case file parses: unique ids, known cards, area matches the file
 *   - coverage: every area has cases, a holdout share, and zh and fr cases
 *   - the checks score a recorded chat correctly (pass and fail of each kind)
 */
import { AREAS, loadEvalCases, tenantBrief, type EvalCase } from "../eval/cases/schema";
import { checkChat, detectLang } from "../eval/cases/checks";
import type { Transcript } from "../eval/live/run-chat";
import { createRunner, printSection, runStandalone, type TestResult } from "./helpers";

const CASE: EvalCase = {
  id: "t",
  source: "written",
  split: "tune",
  area: "pest",
  tags: [],
  lang: "en",
  first: "found larvae in the master bedroom",
  tenant: { situation: "A small hairy larva on the carpet.", knows: { where: "master bedroom carpet" }, doesnt_know: [], has_photo: true },
  truth: { problem: "carpet beetle larvae", category: "pest_control", dangerous: false, urgency: "low" },
  expect: {
    emergency: false,
    escalate: false,
    photo_asked_by_reply: 1,
    card_in: ["none"],
    must_not_say: ["bed bug"],
    ticket_has: ["issue", "location"],
    ticket_mentions: { issue: ["larva"] },
    max_tenant_messages: 4,
    reply_lang: "en",
  },
  judge: ["Asks what it looks like before naming it."],
};

function chat(over: Partial<Transcript> = {}): Transcript {
  return {
    turns: [
      { bot: "Could you take a close photo of one next to a coin?", phase: "AWAITING_MEDIA", tenant: "[sends a photo]" },
      { bot: "Thanks. Is it hairy and striped, and was it on the carpet or the bed?", phase: "GATHER_INFO", options: ["Hairy, on the carpet", "Smooth, on the bed"], tenant: "Hairy, on the carpet" },
      { bot: "Here's your report: carpet beetle larva on the master bedroom carpet. Is that right?", phase: "CONFIRM_SUMMARY", tenant: "yes" },
      { bot: "Your report has been submitted. Your property manager has been notified and will follow up with you.", phase: "DONE" },
    ],
    ticket: "summary",
    end: "DONE",
    card: null,
    emergency: false,
    escalated: false,
    fields: { issue: "Carpet beetle larva found", location: "Master bedroom", started: null, severity: null, equipment: null, brand_model: null, tried: [], facts: [], category: "pest_control" },
    category: "pest_control",
    urgency: "low",
    finished: true,
    ...over,
  };
}

export async function testEvalCases(): Promise<TestResult> {
  const { pass, fail, result } = createRunner();
  const check = (ok: boolean, label: string, detail?: unknown) => (ok ? pass(label) : fail(label, detail));

  printSection("Eval cases — files");
  const { cases, errors } = loadEvalCases();
  check(errors.length === 0, "every case file parses (unique ids, known cards, right file)", errors.slice(0, 5));
  check(cases.length >= 120, `${cases.length} cases`);
  for (const area of AREAS) {
    const g = cases.filter((c) => c.area === area);
    check(g.length >= 5, `${area}: ${g.length} cases`);
    check(g.some((c) => c.split === "holdout"), `${area}: has holdout cases`);
    check(g.some((c) => c.lang === "zh") && g.some((c) => c.lang === "fr"), `${area}: has Chinese and French cases`);
  }
  const holdout = cases.filter((c) => c.split === "holdout").length / cases.length;
  check(holdout >= 0.15 && holdout <= 0.3, `holdout share ${Math.round(holdout * 100)}% (15–30%)`);
  check(cases.filter((c) => c.truth.dangerous).every((c) => c.expect.emergency !== undefined || c.expect.escalate !== undefined), "every dangerous case checks emergency or hand-over");
  check(cases.every((c) => !c.expect.reply_lang || c.expect.reply_lang === c.lang), "reply_lang matches the case's language");
  const brief = tenantBrief(CASE);
  check(brief.includes("You have a photo") && brief.includes("master bedroom carpet"), "the tenant brief carries what they know and the photo");

  printSection("Eval cases — checks");
  const good = checkChat(CASE, chat());
  check(good.every((x) => x.pass), "a good chat passes every check", good.filter((x) => !x.pass));
  const failing = (t: Transcript) => checkChat(CASE, t).filter((x) => !x.pass).map((x) => x.name);

  const late = chat({ turns: [{ bot: "What does it look like?", phase: "GATHER_INFO", tenant: "hairy" }, ...chat().turns] });
  check(failing(late).includes("photo_asked_by_reply"), "photo asked in reply 2 fails photo_asked_by_reply 1", failing(late));
  check(failing(chat({ card: "bedbug_suspicion" })).includes("card_in"), "the wrong card fails card_in");
  const bedbug = chat();
  bedbug.turns[1] = { ...bedbug.turns[1], bot: "It might be a bed bug. Did you see bites?" };
  check(failing(bedbug).includes("must_not_say"), "saying 'bed bug' fails must_not_say");
  check(failing(chat({ fields: { ...chat().fields!, location: null } })).includes("ticket_has"), "a missing location fails ticket_has");
  check(failing(chat({ fields: { ...chat().fields!, issue: "Bugs found" } })).includes("ticket_mentions"), "an issue without 'larva' fails ticket_mentions");
  check(failing(chat({ finished: false })).includes("max_tenant_messages"), "a chat that never finished fails max_tenant_messages");
  check(failing(chat({ emergency: true, escalated: true })).includes("emergency"), "a false emergency fails emergency");

  const french = chat();
  french.turns[1] = { ...french.turns[1], bot: "Merci. Est-ce que la larve est poilue, et était-elle sur le tapis ou sur le lit ?" };
  check(failing(french).includes("reply_lang"), "a French reply in an English chat fails reply_lang");
  check(!failing(chat()).includes("reply_lang"), "the fixed English submitted line is not language-checked");

  const twice = chat();
  twice.turns[2] = { ...twice.turns[2], bot: "Thanks. Is it hairy and striped, and was it on the carpet or the bed?" };
  check(failing(twice).includes("no_repeated_question"), "the same question twice fails no_repeated_question");
  const unsafe = chat();
  unsafe.turns[1] = { ...unsafe.turns[1], bot: "Spray some pesticide on the carpet. Is it hairy?" };
  check(failing(unsafe).includes("no_unsafe_advice"), "unsafe advice fails no_unsafe_advice", failing(unsafe));

  check(detectLang("门关不上，怎么办？") === "zh" && detectLang("La porte ne ferme pas, que faire ?") === "fr" && detectLang("The door won't close, what do I do?") === "en", "language guess: zh, fr, en");
  return result;
}

const isMain = process.argv[1]?.replace(/\.ts$/, "").endsWith("test-eval-cases");
if (isMain) runStandalone(testEvalCases);
