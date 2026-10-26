/**
 * Understanding layer: rules frame, merging with the model, replies. No network.
 */
import { createRunner, printSection, type TestResult } from "./helpers";
import { emptyFrame, mergeFrames, updateFrame, withUnknowns, type IssueFrame } from "../../src/assistant/understanding/frame";
import { rulesFrame, editDistance } from "../../src/assistant/understanding/rules";
import { understand, understandReply, openAIUnderstander } from "../../src/assistant/understanding";
import { newChat, say } from "../eval/drive";

function frame(partial: Omit<Partial<IssueFrame>, "confidence"> & { confidence?: Partial<IssueFrame["confidence"]> }): IssueFrame {
  return withUnknowns({ ...emptyFrame(), ...partial, confidence: { ...emptyFrame().confidence, ...(partial.confidence ?? {}) } });
}

export async function testUnderstanding(): Promise<TestResult> {
  printSection("Understanding layer (rules + model merge, no network)");
  const { pass, fail, result } = createRunner();
  const check = (ok: boolean, label: string, detail?: unknown) => (ok ? pass(label) : fail(label, detail));

  // Typo tolerance
  check(editDistance("gease", "grease") === 1, "edit distance: gease → grease is 1");
  check(editDistance("toliet", "toilet") === 1, "edit distance counts a transposition as 1");
  const hood = rulesFrame("rangehood is leaking gease");
  check(hood.equipment === "range_hood" && hood.substance === "grease" && hood.room === "kitchen", "Simone: rangehood leaking gease → range hood, grease, kitchen", hood);
  check(rulesFrame("breaker keeps tripping").symptom === "tripping", "a known word isn't 'corrected' into another (tripping ≠ dripping)");
  check(rulesFrame("roof leeks in heavy rain").equipment === "roof", "rain isn't a typo of drain");
  check(rulesFrame("closet door fell off the track").equipment === "door", "door fell isn't doorbell");
  check(rulesFrame("抽油烟机漏油了").substance === "grease", "Chinese: 抽油烟机漏油了 → grease (烟 in the name isn't smoke)");
  check(rulesFrame("L'évier de la cuisine fuit").equipment === "kitchen_sink", "French elision: l'évier → kitchen sink");
  check(rulesFrame("smoke detector chirping").severity === "low", "a chirping smoke detector isn't an emergency");
  check(rulesFrame("厨房炉子那边有煤气味").severity === "emergency", "Chinese gas smell is an emergency");

  // Merging: model fills and overrides when confident; never lowers urgency
  const rules = frame({ equipment: "range_hood", symptom: "leaking", substance: "unknown", severity: "emergency", confidence: { equipment: 0.9, symptom: 0.8 } });
  const model = frame({ equipment: "range_hood", symptom: "leaking", substance: "grease", severity: "low", confidence: { equipment: 0.9, symptom: 0.9, substance: 0.9 } });
  const merged = mergeFrames(rules, model);
  check(merged.substance === "grease", "model fills a slot the rules left unknown");
  check(merged.severity === "emergency", "model can't lower urgency below the rules");
  const unsure = frame({ substance: "water", confidence: { substance: 0.3 } });
  check(mergeFrames(frame({ substance: "grease", confidence: { substance: 0.9 } }), unsure).substance === "grease", "an unsure model doesn't override a confident rule");
  check(mergeFrames(rules, null).substance === "unknown", "no model: the rules frame");
  const raised = mergeFrames(frame({ severity: "medium" }), frame({ severity: "emergency" }));
  check(raised.severity === "emergency", "model may raise urgency");

  // Replies add information; urgency never drops
  const updated = updateFrame(frame({ equipment: "sink", severity: "high" }), frame({ room: "kitchen", severity: "low", confidence: { room: 0.9 } }));
  check(updated.room === "kitchen" && updated.severity === "high", "a reply fills the room; severity stays high", updated);

  // understand(): model stub is used, failures fall back to rules
  const stub = async () => frame({ equipment: "range_hood", symptom: "leaking", substance: "grease", confidence: { equipment: 0.9, symptom: 0.9, substance: 0.9 } });
  const u = await understand("the thing above my stove is dripping", stub);
  check(u.source === "model+rules" && u.frame.substance === "grease", "understand() merges the model frame", u.frame);
  const broken = async () => {
    throw new Error("timeout");
  };
  const f = await understand("toilet is clogged", broken);
  check(f.source === "rules" && f.frame.equipment === "toilet", "model failure → rules frame");
  check(openAIUnderstander() === null, "no real OpenAI key → no model call (placeholder key)");
  const reply = await understandReply(frame({ equipment: "range_hood", symptom: "leaking", substance: "water", confidence: { substance: 0.6 } }), "it's grease actually, not water");
  check(reply.substance === "grease", "reply 'it's grease' corrects a low-confidence substance", reply);

  // Conversation: grease never gets water questions; a frame is stored
  const chat = newChat({ rooms: ["Kitchen", "Bathroom"] });
  const open = await say(chat, "rangehood is leaking gease");
  check(!open.state.current_question?.includes("leak_where"), "grease leak: no water deep-dive", open.state.current_question);
  check(open.state.gathered.location_in_unit === "Kitchen", "range hood → Kitchen without asking", open.state.gathered.location_in_unit);
  check(open.state.issue_frame?.substance === "grease", "frame stored in the state");
  const next = await say(chat, "yesterday");
  check(next.state.issue_frame?.onset === "yesterday", "a reply updates the stored frame", next.state.issue_frame);

  return result;
}
