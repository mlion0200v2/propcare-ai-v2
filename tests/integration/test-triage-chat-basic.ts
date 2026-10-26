/**
 * Basic triage chat: the first reply, the base questions, and `turn()`
 * itself (gather, emergency, confirm, done). Pure: no Supabase, no network.
 */

import {
  createRunner,
  printSection,
  type TestResult,
} from "./helpers";
import { buildInitialReply, buildInitialGathered, QUESTIONS } from "../../src/assistant/triage/base-questions";
import { getFallbackSOP } from "../../src/assistant/triage/sop-fallback";
import { buildAcknowledgement } from "../../src/assistant/triage/acknowledgement";
import { buildEmergencyFollowUpReply } from "../../src/assistant/triage/emergency";
import { SUBMITTED_REPLY } from "../../src/assistant/confirm";
import { turn } from "../../src/assistant";
import { newChat, say } from "../eval/drive";

export async function testTriageChatBasic(): Promise<TestResult> {
  printSection("Triage chat — basic");
  const { pass, fail, result } = createRunner();
  const check = (ok: boolean, label: string, detail?: unknown) => (ok ? pass(label) : fail(label, detail));

  // ── buildInitialReply ──

  try {
    const ack = buildAcknowledgement("my faucet is leaking");
    const reply = buildInitialReply(ack, QUESTIONS.location_in_unit);
    if (reply.includes("Where in your unit")) {
      pass("buildInitialReply includes location question");
    } else {
      fail("buildInitialReply missing location question", reply.slice(0, 200));
    }
    if (!reply.includes("Reply with a number")) {
      pass("buildInitialReply does NOT include numbered category menu");
    } else {
      fail("buildInitialReply still has category menu", reply.slice(0, 200));
    }
  } catch (e) {
    fail("buildInitialReply threw", e);
  }

  // ── buildInitialGathered ──

  try {
    const g = buildInitialGathered();
    if (
      g.category === null &&
      g.location_in_unit === null &&
      g.started_when === null &&
      g.is_emergency === null &&
      g.current_status === null &&
      g.brand_model === null
    ) {
      pass("buildInitialGathered returns all nulls (6 fields)");
    } else {
      fail("buildInitialGathered has non-null fields", g);
    }
  } catch (e) {
    fail("buildInitialGathered threw", e);
  }


  // ── turn(): one message in, the next step out; the state comes back ──

  const rooms = ["Kitchen", "Main bathroom (hallway)"];
  try {
    const chat = newChat({ rooms });
    const open = await say(chat, "my sink is leaking");
    check(open.phase === "GATHER_INFO" && open.state.current_question === "location_in_unit", "turn: a sink in a unit with two sink rooms asks which room", open.state.current_question);
    check(open.options.includes("Kitchen") && open.options.includes("Main bathroom (hallway)"), "turn: the options are the unit's own rooms", open.options);
    const before = JSON.stringify(chat.state);
    const next = await say(chat, "Kitchen");
    check(next.state.gathered.location_in_unit === "Kitchen", "turn: the answer is recorded", next.state.gathered.location_in_unit);
    check(next.state.current_question?.startsWith("intake:") === true, "turn: then the sink's own questions", next.state.current_question);
    check(next.state.v === 1 && next.state.phase === "GATHER_INFO", "turn: the state carries its version and phase");
    const again = await turn({ conversation: "t", message: "Kitchen", state: JSON.parse(before), property: chat.property, media: { count: 0 }, channel: "web" }, { understander: null });
    check(JSON.stringify(again.state.gathered) === JSON.stringify(next.state.gathered), "turn: stateless (same state + message → same result)");
  } catch (e) {
    fail("turn: gather flow threw", e);
  }

  try {
    const chat = newChat({ rooms });
    await say(chat, "my sink is leaking");
    const r = await say(chat, "Kitchen — I think there's a gas leak");
    check(r.phase === "EMERGENCY" && r.emergency?.kind === "gas", "turn: danger in any answer → EMERGENCY at once", r.emergency);
    check(r.ticket.priority === "emergency" && r.ticket.escalate === true && r.ticket.flag_emergency === true, "turn: the ticket update asks the app to escalate", r.ticket);
    check(r.state.gathered.is_emergency === true && r.state.emergency?.manager_notified === false, "turn: the state records the emergency; the app says whether the manager was reached");
    check(!/property manager has been|we've alerted|notified/i.test(r.reply), "turn: the reply is safety advice only (the app adds the notice)", r.reply.slice(0, 200));
    const follow = await say(chat, "ok what now");
    check(follow.phase === "EMERGENCY" && follow.reply === buildEmergencyFollowUpReply() && !follow.emergency, "turn: after an emergency, replies are added to the report");
  } catch (e) {
    fail("turn: emergency flow threw", e);
  }

  try {
    const r = await say(newChat({ rooms }), "I smell gas in the kitchen");
    check(r.phase === "EMERGENCY" && r.emergency?.kind === "gas", "turn: an emergency first message", r.emergency);
  } catch (e) {
    fail("turn: emergency first message threw", e);
  }

  try {
    const chat = newChat({ rooms });
    const open = await say(chat, "my kitchen faucet is dripping");
    const confirming = { ...open.state, phase: "CONFIRM_SUMMARY" as const, current_question: null };
    const done = await turn({ conversation: "t", message: "", action: "confirm_summary", state: confirming, property: chat.property, media: { count: 1 }, channel: "web" }, { understander: null });
    check(done.phase === "DONE" && done.done && done.reply === SUBMITTED_REPLY, "turn: confirm → DONE, submitted", done.reply);
    check(done.ticket.notify_manager === "summary" && !!done.ticket.manager_summary && done.ticket.priority === "medium", "turn: the app gets the summary to send and the priority", done.ticket);
    const after = await turn({ conversation: "t", message: "hello?", state: done.state, property: chat.property, media: { count: 1 }, channel: "web" }, { understander: null });
    check(after.phase === "DONE" && after.done && Object.keys(after.ticket).length === 0, "turn: after DONE, nothing changes");
  } catch (e) {
    fail("turn: confirm flow threw", e);
  }

  // ── getFallbackSOP: non-emergency ──

  try {
    const sop = getFallbackSOP("plumbing", false);
    if (sop.steps.length > 0 && sop.display.includes("Troubleshooting Steps")) {
      pass(`getFallbackSOP: plumbing non-emergency returns ${sop.steps.length} steps`);
    } else {
      fail("getFallbackSOP: plumbing non-emergency missing steps", sop);
    }
  } catch (e) {
    fail("getFallbackSOP threw", e);
  }

  // ── getFallbackSOP: emergency includes prefix steps ──

  try {
    const sop = getFallbackSOP("electrical", true);
    if (sop.display.includes("IMMEDIATE ACTIONS")) {
      pass("getFallbackSOP: emergency includes IMMEDIATE ACTIONS");
    } else {
      fail("getFallbackSOP: emergency missing IMMEDIATE ACTIONS", sop.display.slice(0, 100));
    }
    if (sop.steps.length > 5) {
      pass(`getFallbackSOP: emergency has ${sop.steps.length} steps (prefix + category)`);
    } else {
      fail("getFallbackSOP: emergency too few steps", sop.steps.length);
    }
  } catch (e) {
    fail("getFallbackSOP emergency threw", e);
  }

  // ── getFallbackSOP: unknown category falls back to general ──

  try {
    const sop = getFallbackSOP("nonexistent_category", false);
    if (sop.steps.length > 0) {
      pass("getFallbackSOP: unknown category falls back to general");
    } else {
      fail("getFallbackSOP: unknown category returned empty");
    }
  } catch (e) {
    fail("getFallbackSOP unknown category threw", e);
  }

  return result;
}
