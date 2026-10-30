/**
 * Test: the model-led conversation (pure — the model is a stub, no network)
 * Run:  npx tsx tests/integration/test-chat-flow.ts
 *
 * Covers:
 *   - mode: scripted by default; "chat" leads with the model; a conversation keeps its mode
 *   - the phases code decides from the model's step: question, photos, confirm, submitted, escalated
 *   - the safety gate still runs first; the model never sees an emergency message
 *   - unsafe advice is removed, and an unsafe step makes the model rewrite once
 *   - the manager's summary and diagnosis come from the ticket fields and the card
 *   - model failures, the wrap-up nudge, options for text channels
 */
import { turn, type TurnRequest, type TurnResponse } from "../../src/assistant";
import type { ChatInput, ChatStep, ConversationModel } from "../../src/assistant/chat/model";
import { filterAdvice } from "../../src/assistant/chat/flow";
import { buildDiagnosisView } from "../../src/assistant/sops/diagnosis-view";
import { EMPTY_PROPERTY } from "../../src/assistant/property";
import type { AssistantState } from "../../src/assistant";
import { createRunner, printSection, runStandalone, type TestResult } from "./helpers";

const TICKET: ChatStep["ticket"] = {
  issue: "Kitchen sink drain pipe leaks when draining",
  location: "Kitchen",
  started: "Today",
  severity: "Slow drip into the cabinet, caught in a bowl",
  equipment: "kitchen sink",
  brand_model: null,
  tried: ["Put a bowl under it"],
  facts: ["Leaks only while water drains"],
  category: "plumbing",
};

function step(over: Partial<ChatStep> = {}): ChatStep {
  return {
    reply: "Got it. Does it leak only while water is draining?",
    options: ["Only while draining", "All the time", "Not sure"],
    ticket: TICKET,
    card: "under_sink_leak",
    cause: "none",
    confidence: "medium",
    urgency: "medium",
    steps_suggested: [],
    photo_request: "",
    ready: false,
    confirmed: null,
    escalate: false,
    escalate_reason: "",
    ...over,
  };
}

/**
 * Returns the queued steps in order (null = a failed call) and records what
 * it was asked. `searches[i]`, when set, is searched (search_cards) on call i.
 */
function stubModel(queue: (ChatStep | null)[], searches: (string | null)[] = []): ConversationModel & { inputs: ChatInput[]; found: string[][] } {
  const inputs: ChatInput[] = [];
  const found: string[][] = [];
  return {
    inputs,
    found,
    async next(input, tools) {
      inputs.push(structuredClone(input));
      const query = searches[inputs.length - 1];
      found.push(query && tools ? await tools.searchCards(query) : []);
      return queue.length ? (queue.shift() ?? null) : step();
    },
  };
}

interface Run {
  state: AssistantState | null;
  media: number;
  model: ConversationModel;
  channel: TurnRequest["channel"];
}

function newRun(model: ConversationModel, channel: TurnRequest["channel"] = "web"): Run {
  return { state: null, media: 0, model, channel };
}

async function say(run: Run, message: string, action?: TurnRequest["action"]): Promise<TurnResponse> {
  const r = await turn(
    { conversation: "t", message, action, state: run.state, property: { ...EMPTY_PROPERTY, rooms: ["Kitchen"] }, media: { count: run.media }, channel: run.channel },
    { understander: null, safety: null, search: null, mode: "chat", conversation: run.model }
  );
  run.state = r.state;
  return r;
}

export async function testChatFlow(): Promise<TestResult> {
  const { pass, fail, result } = createRunner();
  const check = (ok: boolean, label: string, detail?: unknown) => (ok ? pass(label) : fail(label, detail));

  printSection("Chat flow — modes");
  const savedMode = process.env.ASSISTANT_MODE;
  delete process.env.ASSISTANT_MODE; // a local .env.local may turn chat on
  try {
    const model = stubModel([]);
    const scripted = await turn(
      { conversation: "t", message: "my kitchen sink is leaking", state: null, property: EMPTY_PROPERTY, media: { count: 0 }, channel: "web" },
      { understander: null, safety: null, search: null, conversation: model }
    );
    check(!scripted.state.chat && model.inputs.length === 0, "no mode given (and no ASSISTANT_MODE): the scripted flow", scripted.state.chat);
    const later = await turn(
      { conversation: "t", message: "Kitchen", state: scripted.state, property: EMPTY_PROPERTY, media: { count: 0 }, channel: "web" },
      { understander: null, safety: null, search: null, mode: "chat", conversation: model }
    );
    check(!later.state.chat && model.inputs.length === 0, "a scripted conversation stays scripted when the mode changes");
  } catch (e) {
    fail("modes threw", e);
  } finally {
    if (savedMode !== undefined) process.env.ASSISTANT_MODE = savedMode;
  }

  printSection("Chat flow — a whole report");
  try {
    const model = stubModel([
      step(),
      step({ reply: "Does it smell?", photo_request: "Thanks. Could you add a photo under the sink?", steps_suggested: ["Put a bowl under the drip"] }),
      step({ reply: "Here's your report: kitchen sink drain leak, since today. Is that right?", ready: true, cause: "drain_trap", confidence: "high" }),
    ], ["kitchen sink leaks under the cabinet"]);
    const run = newRun(model);
    const first = await say(run, "my kitchen sink is leaking under the cabinet");
    check(first.phase === "GATHER_INFO" && first.reply.startsWith("Got it"), "first message: the model's reply", first.reply);
    check(first.options.length === 3 && first.state.ui.options.length === 3, "its tap options go to the web chat", first.options);
    check(model.inputs[0].cards.length === 0, "no cards before the model searches", model.inputs[0].cards.length);
    check(model.found[0].some((c) => c.includes("card: under_sink_leak")), "search_cards finds the sink-leak card", model.found[0].map((c) => c.slice(0, 60)));
    check(first.state.chat?.card === "under_sink_leak" && first.state.gathered.category === "plumbing", "the card and ticket fields are kept (and in gathered)");
    check(first.state.chat?.searches?.[0] === "kitchen sink leaks under the cabinet", "the search is kept for review", first.state.chat?.searches);

    const second = await say(run, "only when it drains");
    check(model.inputs[1].cards[0]?.includes("card: under_sink_leak") === true, "next message: the card in use is shown first", model.inputs[1].cards.map((c) => c.slice(0, 60)));
    check(second.phase === "AWAITING_MEDIA" && second.options.length === 0, "the model asks for photos → AWAITING_MEDIA, no tap options", second.phase);
    check(second.reply === "Thanks. Could you add a photo under the sink?", "only the photo request is shown with the upload buttons, not the model's other question", second.reply);
    check(run.state?.chat?.steps.includes("Put a bowl under the drip") === true, "safe steps are recorded");

    const third = await say(run, "", "skip_photos");
    check(third.phase === "CONFIRM_SUMMARY" && /Is that right/.test(third.reply), "ready → CONFIRM_SUMMARY", third.phase);
    check(model.inputs[2].messages.some((m) => m.text.includes("[Skipped adding photos]")), "the model is told photos were skipped");
    check(third.ticket.category === "plumbing" && third.ticket.troubleshooting_steps?.length === 1, "the ticket gets the category and steps", third.ticket);

    const done = await say(run, "", "confirm_summary");
    check(done.phase === "DONE" && done.done && model.inputs.length === 3, "the confirm button submits without another model call");
    const summary = done.ticket.manager_summary ?? "";
    check(/MAINTENANCE REQUEST — Plumbing/.test(summary) && summary.includes("Tenant's words: my kitchen sink is leaking") && summary.includes("Leaks only while water drains"), "the manager's summary is built from the ticket fields", summary.slice(0, 300));
    check(Boolean(done.ticket.diagnosis?.causes[0]?.label) && (done.ticket.diagnosis?.parts.length ?? 0) > 0 && done.ticket.diagnosis?.trade === "plumber", "the diagnosis comes from the card's cause", done.ticket.diagnosis);
    check(buildDiagnosisView(done.state.gathered)?.procedure === done.ticket.diagnosis?.procedure, "the manager's page shows the stored diagnosis");
    check(done.ticket.notify_manager === "summary" && !done.ticket.escalate, "the manager gets the summary, not escalated");
    check(!/Bring:|P-trap/i.test(done.reply), "the tenant's reply never shows parts", done.reply);
  } catch (e) {
    fail("whole report threw", e);
  }

  printSection("Chat flow — confirming by text, corrections, escalation");
  try {
    const model = stubModel([
      step({ ready: true, reply: "Summary… Is that right?" }),
      step({ confirmed: false, reply: "Updated: it's the bathroom sink. Is that right now?", ticket: { ...TICKET, location: "Bathroom" } }),
      step({ confirmed: true, reply: "Thanks, sent to your manager." }),
    ]);
    const run = newRun(model);
    await say(run, "sink leaking");
    const corrected = await say(run, "no, it's the bathroom");
    check(corrected.phase === "CONFIRM_SUMMARY" && run.state?.gathered.location_in_unit === "Bathroom", "a correction stays in CONFIRM_SUMMARY, updated", corrected.phase);
    check(model.inputs[1].phase === "confirm", "the model knows it is reading a confirmation");
    const yes = await say(run, "没问题");
    check(yes.phase === "DONE" && yes.reply === "Thanks, sent to your manager.", "a confirmation in any language submits", yes.reply);

    const esc = newRun(stubModel([step({ escalate: true, escalate_reason: "Water can't be stopped", reply: "I'm alerting your manager now. Keep towels down." })]));
    const r = await say(esc, "water keeps coming from under the sink and the valve won't close");
    check(r.phase === "DONE" && r.ticket.escalate === true && r.ticket.notify_manager === "urgent" && r.ticket.priority === "high", "escalate → DONE, urgent", r.ticket);
    check((r.ticket.manager_summary ?? "").includes("ESCALATED: Water can't be stopped"), "the summary says why");
  } catch (e) {
    fail("confirm/escalate threw", e);
  }

  printSection("Chat flow — safety");
  try {
    const model = stubModel([]);
    const run = newRun(model);
    const r = await say(run, "I smell gas in the kitchen");
    check(r.phase === "EMERGENCY" && r.emergency?.kind === "gas" && model.inputs.length === 0, "the safety gate escalates before the model is asked", r.phase);

    const later = newRun(stubModel([step()]));
    await say(later, "my kitchen sink is leaking");
    const sparks = await say(later, "now the outlet next to it is sparking");
    check(sparks.phase === "EMERGENCY" && sparks.emergency?.kind === "electrical", "danger mid-chat still escalates", sparks.emergency);

    const unsafe = stubModel([
      step({ reply: "Try this. Turn off the gas valve behind the stove. Then wipe it up.", steps_suggested: ["Turn off the gas valve behind the stove"] }),
      step({ reply: "Please keep away from the stove and wipe up any spill.", steps_suggested: ["Wipe up any spill"] }),
    ]);
    const u = newRun(unsafe);
    const ur = await say(u, "my stove is leaking water");
    check(unsafe.inputs.length === 2 && unsafe.inputs[1].avoid?.[0] === "Turn off the gas valve behind the stove", "an unsafe step makes the model rewrite once, told what to avoid", unsafe.inputs[1]?.avoid);
    check(ur.reply === "Please keep away from the stove and wipe up any spill." && !u.state?.chat?.steps.some((s) => /gas/i.test(s)), "the rewrite is used; the unsafe step is never recorded", ur.reply);

    const leaky = stubModel([
      step({ reply: "Okay. Turn off the gas valve behind the stove. Keep the area dry.", steps_suggested: [] }),
      step({ reply: "Okay. Turn off the gas valve behind the stove. Keep the area dry.", steps_suggested: [] }),
    ]);
    const l = newRun(leaky);
    const lr = await say(l, "my stove is leaking water");
    check(!/gas valve/i.test(lr.reply) && /Keep the area dry/.test(lr.reply), "an unsafe sentence in the reply is removed even if not declared as a step", lr.reply);
    check(l.state?.chat?.removed.some((x) => /gas valve/.test(x)) === true, "…and logged for review");
  } catch (e) {
    fail("safety threw", e);
  }

  printSection("Chat flow — failures, length, channels");
  try {
    const flaky = stubModel([null, null]);
    const f = newRun(flaky);
    const r1 = await say(f, "my kitchen sink is leaking");
    check(r1.phase === "GATHER_INFO" && /didn't catch/.test(r1.reply), "a failed model call: ask again, keep the phase", r1.reply);
    const r2 = await say(f, "under the sink");
    check(r2.phase === "DONE" && r2.ticket.notify_manager === "summary" && Boolean(r2.ticket.manager_summary), "two failures in a row: submit what we have", r2.phase);

    const long = stubModel([]);
    const lrun = newRun(long);
    for (let i = 0; i < 8; i++) await say(lrun, `detail ${i}`);
    check(long.inputs.at(-1)?.wrapUp === true && long.inputs[0].wrapUp === false, "a long chat tells the model to wrap up");

    const email = newRun(stubModel([step()]), "email");
    const er = await say(email, "my kitchen sink is leaking");
    check(er.options.length === 0 && er.reply.includes("- Only while draining"), "email: the options are written into the reply", er.reply);
  } catch (e) {
    fail("failures/channels threw", e);
  }

  printSection("Advice filter");
  {
    const a = filterAdvice("Thanks.\n1. Flip the breaker near the water.\n2. Put towels down.");
    check(!/breaker/.test(a.text) && /Put towels down/.test(a.text) && a.removed.length === 1, "an unsafe numbered line is removed", a);
    const b = filterAdvice("Keep the oven at 350°F.");
    check(/°C/.test(b.text), "°F → °C", b.text);
    const c = filterAdvice("Do not touch the gas valve. Leave the area.");
    check(c.text === "Do not touch the gas valve. Leave the area." && c.removed.length === 0, "warnings stay", c);
  }

  return result;
}

// Standalone
const isMain = process.argv[1]?.replace(/\.ts$/, "").endsWith("test-chat-flow");
if (isMain) runStandalone(testChatFlow);
