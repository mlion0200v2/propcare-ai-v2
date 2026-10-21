/**
 * Test: chat workflow (leak deep-dive, prevention first, shot list,
 * access details, owner update) — pure
 * Run:  npx tsx tests/integration/test-chat-workflow.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRunner, printSection, runStandalone, type TestResult } from "./helpers";
import { buildInitialGathered } from "../../src/lib/triage/state-machine";
import { advanceGather, openConversation } from "../../src/lib/triage/conversation";
import { buildMediaPrompt, buildPreventionSteps, buildShotList } from "../../src/lib/triage/guidance";
import { buildChatHints } from "../../src/lib/triage/hints";
import { buildOwnerUpdate } from "../../src/lib/messages";
import { matchingRooms, readUnitProfile, whichRoomQuestion } from "../../src/lib/units/profile";
import type { GatheredInfo, TriageClassification } from "../../src/lib/triage/types";
import { generateTicketSummary } from "../../src/lib/triage/summary";
import { buildQueryText } from "../../src/lib/retrieval/pinecone";
import { sopByKey } from "../../src/lib/sops/catalog";
import { answerIntake, startIntake } from "../../src/lib/sops/intake";
import { rulesFrame } from "../../src/lib/understanding/rules";

const SRC = join(__dirname, "..", "..", "src");

/** Drive the chat: first message, then answers in order. Returns the state and every question asked. */
async function chatThrough(first: string, answers: string[], rooms = ["Kitchen", "Main bathroom (hallway)"]) {
  const open = await openConversation(first, { rooms });
  const stored: TriageClassification = open.triageClassification;
  const asked: string[] = [];
  let question = stored.current_question;
  let emergency: string | null = null;
  for (const answer of answers) {
    if (!question) break;
    asked.push(question);
    const step = advanceGather({ stored, description: first, triageState: "GATHER_INFO", message: answer });
    stored.gathered = step.gathered;
    if (step.kind === "emergency") {
      emergency = step.emergency.kind;
      break;
    }
    question = step.kind === "ask" ? step.nextQuestion : null;
    stored.current_question = question;
  }
  return { gathered: stored.gathered!, asked, next: question, emergency, firstReply: open.reply };
}

/** The answer to an SOP's electrical question (safety-critical order). */
function electricalAnswer(text: string): { value: string; emergency: string | null } {
  const sop = sopByKey("water_leak_unknown")!;
  const q = sop.intake_questions.find((x) => x.slot === "electrical_near")!;
  const r = answerIntake(sop, startIntake(sop, rulesFrame("water leak"), "high"), q, text);
  return { value: r.state.answers.electrical_near.value, emergency: r.emergency };
}

export async function testChatWorkflow(): Promise<TestResult> {
  printSection("Chat workflow (SOP intake for leaks, prevention, shot list, dispatch)");
  const { pass, fail, result } = createRunner();
  const check = (cond: boolean, msg: string, detail?: unknown) => (cond ? pass(msg) : fail(msg, detail));

  // Rooms
  const rooms = ["Main bathroom (upstairs hallway)", "Ensuite", "Kitchen", "Laundry (basement)", "Basement"];
  check(matchingRooms("bathroom", rooms).join("|") === "Main bathroom (upstairs hallway)|Ensuite", "'bathroom' matches both bathrooms in the profile");
  check(matchingRooms("kitchen", rooms).join("|") === "Kitchen" && matchingRooms("bathroom", ["Main bathroom (hallway)", "Kitchen"]).length === 1, "a single match is used directly");
  check(whichRoomQuestion("bathroom", ["Main bathroom (upstairs hallway)", "Ensuite"]) === "Which bathroom is it? (Main bathroom (upstairs hallway) or Ensuite)", "asks 'Which bathroom?' with the unit's own rooms");
  const candidateChips = buildChatHints({ currentQuestion: "location_in_unit", triageState: "GATHER_INFO", category: "plumbing", description: "leak", profile: readUnitProfile({ rooms }), locationCandidates: ["Main bathroom (upstairs hallway)", "Ensuite"] });
  check(candidateChips.quickReplies.join("|") === "Main bathroom (upstairs hallway)|Ensuite", "chips offer just the matching rooms");

  // Electrical answer: safety-critical
  check(electricalAnswer("No").value === "no" && electricalAnswer("nope").value === "no" && electricalAnswer("no outlets nearby").value === "no", "clear 'no' → no");
  check(electricalAnswer("yes").emergency === "water_electrical" && electricalAnswer("there's a light right above it").emergency === "water_electrical", "yes / mentions a light → escalate");
  check(electricalAnswer("No, but the lamp is plugged in nearby").emergency === "water_electrical", "'no, but … plugged in' → yes (safer)");
  check(electricalAnswer("I don't know").emergency === "unconfirmed_safety" && electricalAnswer("maybe").emergency === "unconfirmed_safety", "unclear → not sure (escalated)");

  // Ceiling leak: the SOP's questions in order, nothing the message already said
  const ceiling = await chatThrough("There's water dripping from the bathroom ceiling", ["A bathroom", "Only when that's used (shower, toilet or tap above)", "It's spreading", "No", "Today"]);
  check(ceiling.gathered.sop?.issue_key === "ceiling_stain", "ceiling drip → ceiling SOP", ceiling.gathered.sop?.issue_key);
  check(ceiling.asked.join(",") === "intake:ceiling_above,intake:ceiling_timing,intake:amount,intake:electrical_near,intake:onset", "asks what's above, when, how much, electrical, when it started", ceiling.asked);
  check(ceiling.next === null && ceiling.gathered.sop?.complete === true && ceiling.gathered.sop?.cause?.id === "above_bathroom", "intake complete; likely source recorded", ceiling.gathered.sop?.cause);
  const danger = await chatThrough("There's water dripping from the bathroom ceiling", ["A bathroom", "All the time", "A few drops", "Not sure"]);
  check(danger.emergency === "unconfirmed_safety", "'not sure' near electrical is treated as an emergency", danger.emergency);
  const unknownLeak = await chatThrough("something is leaking", ["Toilet", "Around the base, on the floor"]);
  check(unknownLeak.asked[0] === "intake:leak_where" && unknownLeak.gathered.sop?.issue_key === "toilet_base_leak", "unknown source: 'where is the water?' first; the answer picks the toilet SOP", [unknownLeak.asked, unknownLeak.gathered.sop?.issue_key]);
  const grease = await chatThrough("rangehood is leaking gease", ["The filter area underneath"]);
  check(grease.gathered.sop?.issue_key === "range_hood_grease_drip" && !grease.asked.some((q) => /electrical_near|amount|leak_where/.test(q)), "grease drip: hood questions, no water questions", grease.asked);
  check(!/where in your unit|where is the water/i.test(grease.firstReply), "Simone's transcript: no 'Where in your unit?' or 'Where is the water?'", grease.firstReply);

  const route = readFileSync(join(SRC, "app", "api", "triage", "chat", "route.ts"), "utf8");
  check(/gatherStep\.kind === "emergency"[\s\S]{0,200}handleEmergency\(/.test(route) && /buildMediaPrompt\(/.test(route), "the chat escalates immediately when an answer is an emergency; media step uses the guided prompt");

  // Prevention first
  const safe = ceiling.gathered;
  const profile = readUnitProfile({ water_shutoff: "Laundry closet, blue lever", breaker_panel: "Hallway" });
  const prevention = buildPreventionSteps(safe, profile);
  check(prevention[0] === "Turn off the main water: Laundry closet, blue lever.", "spreading water: shut-off location first", prevention);
  check(prevention.some((s) => /bucket/.test(s)) && prevention.some((s) => /electronics/.test(s)) && prevention.some((s) => /sagging/.test(s)), "towels/bucket, move valuables, ceiling warning");
  const toiletLeak = await chatThrough("my toilet is leaking", ["Not sure", "Not sure", "A few drops", "No", "Today"], ["Kitchen", "Bathroom"]);
  check(/toilet's shut-off valve/.test(buildPreventionSteps(toiletLeak.gathered, readUnitProfile({}))[0]), "toilet leak (source unknown): the toilet's own valve", buildPreventionSteps(toiletLeak.gathered, readUnitProfile({})));
  const toiletBase = await chatThrough("water on the floor around my toilet", ["Only when it's flushed", "A few drops", "No", "Today"], ["Kitchen", "Bathroom"]);
  check(/Don't flush this toilet/.test(buildPreventionSteps(toiletBase.gathered, readUnitProfile({}))[0]), "toilet base leak: don't flush (likely source picks the step)");
  const trap = await chatThrough("my kitchen sink is leaking", ["The drain pipe / P-trap under the sink", "Only while water is draining", "A few drops", "No", "Today"]);
  check(/Don't run the tap or the dishwasher; put a bowl under the trap/.test(buildPreventionSteps(trap.gathered, readUnitProfile({}))[0]), "drain/trap leak: don't run the tap or dishwasher, bowl under the trap");
  check(/Don't cook on the burner under the drip/.test(buildPreventionSteps(grease.gathered, profile)[0] ?? ""), "grease drip: the SOP's own prevention step (no water steps)", buildPreventionSteps(grease.gathered, profile));
  const notLeak: GatheredInfo = { ...buildInitialGathered(), category: "electrical", location_in_unit: "Kitchen", started_when: "today", current_status: "still happening" };
  check(buildPreventionSteps(notLeak, profile).length === 0, "no prevention block without an SOP or a leak");

  // Shot list
  const shots = buildShotList(trap.gathered);
  check(shots[0].startsWith("A wide shot") && shots.some((s) => /under the sink/i.test(s)), "leak shot list: wide shot, then the SOP's photos (under the sink)", shots);
  const appliance = buildShotList({ ...notLeak, category: "appliance" });
  check(appliance.some((s) => /model\/serial label/.test(s)), "appliances: the model label");
  const prompt = buildMediaPrompt(safe, profile);
  check(prompt.indexOf("limit the damage") >= 0 && prompt.indexOf("limit the damage") < prompt.indexOf("Photos help") && /60 seconds/.test(prompt), "media prompt: prevention first, then shots, video ≤ 60 s");

  // Chips come from the SOP's options (only the ones that make sense)
  const chipsAt = (gathered: GatheredInfo, q: string) =>
    buildChatHints({ currentQuestion: q, triageState: "GATHER_INFO", category: "plumbing", description: "leak", profile, gathered }).quickReplies;
  const ceilingStart = await chatThrough("There's water dripping from the bathroom ceiling", []);
  check(chipsAt(ceilingStart.gathered, "intake:ceiling_above").includes("Another unit (a neighbour's)"), "ceiling: 'what's above?' chips");
  check(chipsAt(ceilingStart.gathered, "intake:electrical_near").join() === "No,Yes,Not sure", "electrical chips: No, Yes, Not sure", chipsAt(ceilingStart.gathered, "intake:electrical_near"));
  const bathSink = await chatThrough("the bathroom sink is leaking", [], ["Kitchen", "Bathroom"]);
  const sinkChips = chipsAt(bathSink.gathered, "intake:sink_part");
  check(sinkChips.includes("The drain stopper") && !sinkChips.includes("The garbage disposal"), "bathroom sink: a stopper option, no disposal", sinkChips);

  // Media limits in the browser
  const chat = readFileSync(join(SRC, "components", "triage", "chat.tsx"), "utf8");
  check(/checkMediaFile\(file\)/.test(chat) && /MAX_VIDEO_SECONDS/.test(chat), "videos over 60 s or files over 25 MB are stopped before upload");

  // Access details
  const access = readFileSync(join(SRC, "lib", "actions", "access.ts"), "utf8");
  check(/\.eq\("tenant_id", user\.id\)/.test(access) && /createServiceClient\(\)/.test(access), "access details: ownership checked with the tenant's session before writing");

  // The likely source reaches the summary (and so the work order) and the SOP search
  {
    const summary = generateTicketSummary({
      ticketId: "t1",
      traceId: "t1",
      description: "my kitchen sink is leaking",
      gathered: trap.gathered,
      steps: [],
      mediaCount: 0,
      timestamp: "2026-10-21T10:00:00Z",
    });
    check(/Likely source: Drain pipe \/ P-trap slip nut/.test(summary) && /When does it leak: Only while water is draining/.test(summary) && /Procedure: /.test(summary), "summary lists the procedure, the answers and the likely source", summary);
    check(/p-trap slip nut drain pipe/.test(buildQueryText(trap.gathered, "my kitchen sink is leaking")), "SOP search is steered to the likely source");
  }

  // Owner update
  const update = buildOwnerUpdate({
    workspaceName: "Demo Rentals",
    ownerName: "Riley",
    title: "Kitchen sink, slow drain",
    address: "3076 Arbutus Street, Unit 304",
    whatHappened: "Drains slowly since yesterday.",
    stageLabel: "Waiting for owner",
    photos: 2,
    pendingQuote: { amount: "$340", limit: "$300", vendor: "Westside Plumbing" },
    link: "https://app.test/tickets/x",
  });
  check(update.subject.startsWith("Approval needed") && /Westside Plumbing quoted \$340, over your \$300/.test(update.text) && /Approve or decline here: https:\/\/app\.test\/tickets\/x/.test(update.text), "owner update: plain language, quote vs limit, approve/decline link");
  check(/2 photos/.test(update.text), "owner update mentions the photos");

  return result;
}

const isMain = process.argv[1]?.replace(/\.ts$/, "").endsWith("test-chat-workflow");
if (isMain) runStandalone(testChatWorkflow);
