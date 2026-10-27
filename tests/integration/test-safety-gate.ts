/**
 * Test: the safety gate (pure — the model is stubbed, no network)
 * Run:  npx tsx tests/integration/test-safety-gate.ts
 *
 * Covers:
 *   - without the model, the keyword rules decide exactly as before
 *   - the model can turn a smell-only keyword match into one question, never
 *     sparks, alarms, flooding or an explicit gas leak
 *   - the model catches danger no keyword names
 *   - a cleared check starts the conversation and isn't asked again
 *   - anything but a clear "no", in English, French or Chinese, escalates
 *   - after an emergency, the manager's questions are asked one at a time
 */
import { checkSafety, readSafetyAnswer, type SafetyModel, type SafetyReading } from "../../src/assistant/safety/gate";
import { classifySafetyAnswer, emergencyNotice, EMERGENCY_QUESTIONS } from "../../src/assistant/triage/emergency";
import type { SafetyAnswer } from "../../src/assistant/triage/emergency";
import { newChat, say } from "../eval/drive";
import { createRunner, printSection, runStandalone, type TestResult } from "./helpers";

const NONE: SafetyReading = { level: "none", kind: "none", phrase: "", question: "" };

/** A stand-in model: a reading per message (by substring), and an answer per answer. */
function stubModel(readings: [string, SafetyReading][], answers: [string, SafetyAnswer][] = []): SafetyModel {
  return {
    read: async (message) => readings.find(([k]) => message.toLowerCase().includes(k))?.[1] ?? NONE,
    readAnswer: async (_q, answer) => answers.find(([k]) => answer.toLowerCase().includes(k))?.[1] ?? null,
  };
}

const HOT_WATER_CHECK: SafetyReading = {
  level: "check",
  kind: "gas",
  phrase: "rotten egg smell",
  question: "Is the smell only from the hot water, or also in the air near the water heater or stove?",
};

export async function testSafetyGate(): Promise<TestResult> {
  const { pass, fail, result } = createRunner();
  const check = (ok: boolean, label: string, detail?: unknown) => (ok ? pass(label) : fail(label, detail));

  printSection("Safety gate — keyword rules alone");
  {
    const gas = await checkSafety("It smells like gas in the kitchen", "", null);
    check(gas.kind === "emergency" && gas.emergency.kind === "gas", "no model: a gas smell escalates", gas);
    const egg = await checkSafety("rotten egg smell from the hot water tap", "", null);
    check(egg.kind === "emergency", "no model: a rotten-egg smell still escalates (as before)", egg);
    const fridge = await checkSafety("the fridge is warm", "", null);
    check(fridge.kind === "clear", "no model: an ordinary repair is clear", fridge);
    check((await checkSafety("", "", null)).kind === "clear", "an empty message (a button) is clear");
  }

  printSection("Safety gate — the model can soften only a smell");
  {
    const model = stubModel([
      ["rotten egg", HOT_WATER_CHECK],
      ["gas leak", { ...HOT_WATER_CHECK, level: "check" }],
      ["spark", { ...NONE, level: "check", kind: "electrical", question: "Is it still sparking?" }],
      ["flood", NONE],
      ["burning smell", NONE],
    ]);
    const egg = await checkSafety("rotten egg smell from the hot water tap", "", model);
    check(egg.kind === "check" && egg.check.question === HOT_WATER_CHECK.question, "a smell-only match the model doubts → one question", egg);
    const leak = await checkSafety("I think there's a gas leak", "", model);
    check(leak.kind === "emergency", "an explicit gas leak escalates whatever the model says", leak);
    const sparks = await checkSafety("the outlet sparks when I plug in the kettle", "", model);
    check(sparks.kind === "emergency" && sparks.emergency.kind === "electrical", "sparks escalate whatever the model says", sparks);
    const flood = await checkSafety("water is pouring from the ceiling", "", model);
    check(flood.kind === "emergency", "flooding escalates whatever the model says", flood);
    const heater = await checkSafety("a burning smell when I turned the heater on", "", model);
    check(heater.kind === "check" && heater.check.question.length > 0, "a smell the model calls harmless still gets a question, never cleared outright", heater);
  }

  printSection("Safety gate — the model catches what keywords miss");
  {
    const model = stubModel([
      ["plate is brown", { level: "emergency", kind: "electrical", phrase: "outlet is warm and the plate is brown", question: "" }],
      ["odd smell", { level: "check", kind: "gas", phrase: "odd smell", question: "Does it smell like gas or rotten eggs?" }],
    ]);
    const outlet = await checkSafety("the outlet is warm and the plate is brown", "", model);
    check(outlet.kind === "emergency" && outlet.emergency.kind === "electrical", "a warm, discoloured outlet escalates", outlet);
    const odd = await checkSafety("there's an odd smell in the hallway", "", model);
    check(odd.kind === "check", "an unclear smell → a question", odd);
    const cleared = await checkSafety("there's an odd smell in the hallway", "", model, ["gas"]);
    check(cleared.kind === "clear", "a danger the tenant already ruled out isn't asked again", cleared);
  }

  printSection("Safety answers — any language; only a clear no clears");
  {
    const cases: [string, SafetyAnswer][] = [
      ["No", "no_concern"],
      ["Non, je ne remarque rien de tout ça.", "no_concern"],
      ["Rien du tout", "no_concern"],
      ["没有", "no_concern"],
      ["没有，一切正常", "no_concern"],
      ["Oui, ça sent le brûlé", "concern"],
      ["有", "concern"],
      ["不知道", "unclear"],
      ["je ne sais pas", "unclear"],
      ["没有，但是有点味道", "unclear"],
      ["Non, mais ça sent un peu", "unclear"],
      ["No, but it smells a bit", "unclear"],
    ];
    for (const [answer, want] of cases) {
      const got = classifySafetyAnswer(answer);
      check(got === want, `"${answer}" → ${want}`, got);
    }
    const model = stubModel([], [["c'est correct", "no_concern"], ["just from the tap", "no_concern"]]);
    check((await readSafetyAnswer("q", "c'est correct", model)) === "no_concern", "the model reads what keywords can't");
    check((await readSafetyAnswer("q", "hmm, c'est correct?", model)) === "unclear", "a hedged answer stays unclear even if the model would clear it");
    check((await readSafetyAnswer("q", "comme ci comme ça", stubModel([]))) === "unclear", "the model unsure or unavailable → unclear");
    check((await readSafetyAnswer("q", "yes there are sparks", stubModel([], [["sparks", "no_concern"]]))) === "concern", "keywords' concern can't be cleared by the model");
  }

  printSection("Safety gate in a conversation");
  try {
    const model = stubModel([["rotten egg", HOT_WATER_CHECK]], [["only the hot water", "no_concern"]]);
    const chat = newChat({ rooms: ["Kitchen", "Main bathroom (hallway)"], safety: model });
    const first = await say(chat, "rotten egg smell when I run the hot water");
    check(first.phase === "GATHER_INFO" && !first.emergency && first.reply === HOT_WATER_CHECK.question, "first message: the check question, no alarm", first.reply);
    check(first.options.length === 0, "no tap options from another question while the check waits", first.options);
    const cleared = await say(chat, "no, only the hot water tap smells");
    check(cleared.phase === "GATHER_INFO" && !cleared.emergency, "a clear no starts the conversation", cleared.reply.slice(0, 120));
    check(chat.state?.safety_cleared?.includes("gas") === true && chat.state?.description.includes("rotten egg"), "the state remembers it was cleared, and the first message", chat.state?.safety_cleared);
    const again = await say(chat, "the rotten egg smell is still there in the hot water");
    check(!again.emergency && again.reply !== HOT_WATER_CHECK.question, "the same smell later isn't asked about again", again.reply.slice(0, 120));
    const sparks = await say(chat, "now the heater is sparking");
    check(sparks.phase === "EMERGENCY" && sparks.emergency?.kind === "electrical", "new danger still escalates", sparks.emergency);

    const unsure = newChat({ safety: model });
    await say(unsure, "rotten egg smell when I run the hot water");
    const r = await say(unsure, "not sure, maybe near the heater too");
    check(r.phase === "EMERGENCY" && r.emergency?.kind === "gas", "an unsure answer to the check escalates", r.emergency);

    const midway = newChat({ rooms: ["Kitchen"], safety: stubModel([["odd smell", { level: "check", kind: "gas", phrase: "odd smell", question: "Gas or rotten eggs?" }]], [["no gas", "no_concern"]]) });
    await say(midway, "my kitchen sink is leaking");
    const asked = await say(midway, "Kitchen. there's also an odd smell");
    check(asked.reply === "Gas or rotten eggs?" && asked.phase === "GATHER_INFO", "a check mid-conversation keeps the phase", asked.reply);
    const resumed = await say(midway, "no gas, it's the drain");
    check(!resumed.emergency && resumed.reply !== "Gas or rotten eggs?", "after the check clears, the held answer is handled", resumed.reply.slice(0, 120));
  } catch (e) {
    fail("safety gate conversation threw", e);
  }

  printSection("After an emergency: the manager's questions");
  {
    check(emergencyNotice(true).includes(EMERGENCY_QUESTIONS[0]), "the notice asks the first question");
    check(/once you're safe/i.test(emergencyNotice(false)), "…only once the tenant is safe");
  }

  return result;
}

// Standalone
const isMain = process.argv[1]?.replace(/\.ts$/, "").endsWith("test-safety-gate");
if (isMain) runStandalone(testSafetyGate);
