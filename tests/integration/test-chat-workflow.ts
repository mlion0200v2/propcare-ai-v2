/**
 * Test: chat workflow (leak deep-dive, prevention first, shot list,
 * access details, owner update) — pure
 * Run:  npx tsx tests/integration/test-chat-workflow.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRunner, printSection, runStandalone, type TestResult } from "./helpers";
import {
  extractLeakWhere,
  refreshLeakDetails,
  getNextExtendedQuestion,
  isGatherComplete,
  isWaterLeak,
  normaliseYesNo,
  processExtendedAnswer,
} from "../../src/lib/triage/gather-issue";
import { buildInitialGathered } from "../../src/lib/triage/state-machine";
import { buildMediaPrompt, buildPreventionSteps, buildShotList } from "../../src/lib/triage/guidance";
import { buildChatHints } from "../../src/lib/triage/hints";
import { buildOwnerUpdate } from "../../src/lib/messages";
import { matchingRooms, readUnitProfile, whichRoomQuestion } from "../../src/lib/units/profile";
import type { GatheredInfo } from "../../src/lib/triage/types";
import { generateTicketSummary } from "../../src/lib/triage/summary";
import { buildQueryText } from "../../src/lib/retrieval/pinecone";

const SRC = join(__dirname, "..", "..", "src");

export function testChatWorkflow(): TestResult {
  printSection("Chat workflow (leaks, prevention, shot list, dispatch)");
  const { pass, fail, result } = createRunner();
  const check = (cond: boolean, msg: string, detail?: unknown) => (cond ? pass(msg) : fail(msg, detail));

  // Leak detection
  check(isWaterLeak("Water is dripping from the bathroom ceiling") && isWaterLeak("my sink is leaking") && isWaterLeak("there's a puddle by the fridge"), "leaks are recognised");
  check(!isWaterLeak("the oven won't heat") && !isWaterLeak("noisy fan"), "non-leaks don't get the leak questions");

  // Use what the first message already says
  check(extractLeakWhere("There's water dripping from the bathroom ceiling") === "Ceiling", "'dripping from the bathroom ceiling' → water at the ceiling (not asked again)");
  check(
    extractLeakWhere("my kitchen sink is leaking underneath") === "Under the sink" &&
      extractLeakWhere("water around the base of the toilet") === "Around the toilet" &&
      extractLeakWhere("the dishwasher is leaking") === "Around an appliance" &&
      extractLeakWhere("there's a leak somewhere") === null,
    "other sources recognised; unknown stays a question"
  );
  const rooms = ["Main bathroom (upstairs hallway)", "Ensuite", "Kitchen", "Laundry (basement)", "Basement"];
  check(matchingRooms("bathroom", rooms).join("|") === "Main bathroom (upstairs hallway)|Ensuite", "'bathroom' matches both bathrooms in the profile");
  check(matchingRooms("kitchen", rooms).join("|") === "Kitchen" && matchingRooms("bathroom", ["Main bathroom (hallway)", "Kitchen"]).length === 1, "a single match is used directly");
  check(whichRoomQuestion("bathroom", ["Main bathroom (upstairs hallway)", "Ensuite"]) === "Which bathroom is it? (Main bathroom (upstairs hallway) or Ensuite)", "asks 'Which bathroom?' with the unit's own rooms");
  const candidateChips = buildChatHints({ currentQuestion: "location_in_unit", triageState: "GATHER_INFO", category: "plumbing", description: "leak", profile: readUnitProfile({ rooms }), locationCandidates: ["Main bathroom (upstairs hallway)", "Ensuite"] });
  check(candidateChips.quickReplies.join("|") === "Main bathroom (upstairs hallway)|Ensuite", "chips offer just the matching rooms");
  {
    const convSrc = readFileSync(join(SRC, "lib", "triage", "conversation.ts"), "utf8");
    check(/gathered\.leak_where = extractLeakWhere\(message\)/.test(convSrc) && /whichRoomQuestion\(roomWord/.test(convSrc), "first message fills in the water location and narrows the room");
  }

  // Electrical answer: safety-critical
  check(normaliseYesNo("No") === "no" && normaliseYesNo("nope") === "no" && normaliseYesNo("no outlets nearby") === "no", "clear 'no' → no");
  check(normaliseYesNo("yes") === "yes" && normaliseYesNo("there's a light right above it") === "yes", "yes / mentions a light → yes");
  check(normaliseYesNo("No, but the lamp is plugged in nearby") === "yes", "'no, but … plugged in' → yes (safer)");
  check(normaliseYesNo("I don't know") === "not sure" && normaliseYesNo("maybe") === "not sure", "unclear → not sure (escalated)");

  // Gather order and completion
  const base: GatheredInfo = {
    ...buildInitialGathered(),
    category: "plumbing",
    location_in_unit: "Main bathroom",
    started_when: "today",
    current_status: "still happening",
    leak_details_needed: true,
  };
  check(!isGatherComplete(base) && getNextExtendedQuestion(base) === "leak_where", "leak deep-dive starts with 'where is the water?'");
  // With a fixture (here: the ceiling) the questions come from the fixture table.
  let g = refreshLeakDetails(processExtendedAnswer(base, "leak_where", "Ceiling"), "water is leaking");
  check(g.leak_fixture === "ceiling_wall" && getNextExtendedQuestion(g) === "leak_part", "a 'Ceiling' answer picks the ceiling questions ('what's above it?')");
  g = refreshLeakDetails(processExtendedAnswer(g, "leak_part", "A bathroom"), "water is leaking");
  check(getNextExtendedQuestion(g) === "leak_timing", "then when it drips");
  g = refreshLeakDetails(processExtendedAnswer(g, "leak_timing", "Only when that's used (shower, toilet or tap above)"), "water is leaking");
  check(getNextExtendedQuestion(g) === "leak_amount" && g.leak_likely_source?.id === "above_bathroom", "then how much; likely source recorded");
  g = processExtendedAnswer(g, "leak_amount", "It's spreading");
  check(getNextExtendedQuestion(g) === "leak_electrical", "electrical question last");
  const safe = processExtendedAnswer(g, "leak_electrical", "No");
  check(isGatherComplete(safe) && safe.is_emergency !== true, "'no' completes the gather without an emergency");
  const danger = processExtendedAnswer(g, "leak_electrical", "Not sure");
  check(danger.is_emergency === true && danger.leak_electrical === "not sure", "'not sure' near electrical is treated as an emergency");
  const notLeak = { ...base, leak_details_needed: false };
  check(isGatherComplete(notLeak), "non-leak reports skip the leak questions");

  const route = readFileSync(join(SRC, "app", "api", "triage", "chat", "route.ts"), "utf8");
  const conv = readFileSync(join(SRC, "lib", "triage", "conversation.ts"), "utf8");
  check(
    /currentQuestion === "leak_electrical" && gathered\.leak_electrical !== "no"[\s\S]{0,120}kind: "emergency"/.test(conv) &&
      /gatherStep\.kind === "emergency"[\s\S]{0,200}handleEmergency\(/.test(route),
    "the chat escalates immediately on water near electricity"
  );
  check(/isWaterLeak\(message\)/.test(conv) && /buildMediaPrompt\(/.test(route), "leaks flagged from the first message; media step uses the guided prompt");

  // Prevention first
  const profile = readUnitProfile({ water_shutoff: "Laundry closet, blue lever", breaker_panel: "Hallway" });
  const prevention = buildPreventionSteps(safe, profile);
  check(prevention[0] === "Turn off the main water: Laundry closet, blue lever.", "spreading water: shut-off location first", prevention);
  check(prevention.some((s) => /bucket/.test(s)) && prevention.some((s) => /electronics/.test(s)) && prevention.some((s) => /sagging/.test(s)), "towels/bucket, move valuables, ceiling warning");
  const toilet = buildPreventionSteps(
    { ...safe, leak_fixture: null, leak_likely_source: null, leak_amount: "A few drops", leak_where: "Around the toilet" },
    readUnitProfile({})
  );
  check(/toilet's shut-off valve/.test(toilet[0]), "toilet leak (source unknown): the toilet's own valve");
  const toiletBase = buildPreventionSteps(
    { ...safe, leak_fixture: "toilet", leak_amount: "A few drops", leak_likely_source: { id: "toilet_base", label: "Wax ring at the toilet base" } },
    readUnitProfile({})
  );
  check(/Don't flush this toilet/.test(toiletBase[0]), "toilet base leak: don't flush (likely source picks the step)");
  const trap = buildPreventionSteps(
    { ...safe, leak_fixture: "kitchen_sink", leak_amount: "A few drops", leak_likely_source: { id: "drain_trap", label: "Drain pipe / P-trap slip nut" } },
    readUnitProfile({})
  );
  check(/Don't run the tap or the dishwasher; put a bowl under the trap/.test(trap[0]), "drain/trap leak: don't run the tap or dishwasher, bowl under the trap");
  check(buildPreventionSteps(notLeak, profile).length === 0, "no prevention block for non-leaks");

  // Shot list
  const shots = buildShotList({ ...safe, leak_where: "Under the sink" });
  check(shots.some((s) => /Under the sink/.test(s)) && shots[0].startsWith("A wide shot"), "leak shot list: wide shot, source, under the sink");
  const appliance = buildShotList({ ...notLeak, category: "appliance" });
  check(appliance.some((s) => /model\/serial label/.test(s)), "appliances: the model label");
  const prompt = buildMediaPrompt(safe, profile);
  check(prompt.indexOf("limit the damage") >= 0 && prompt.indexOf("limit the damage") < prompt.indexOf("Photos help") && /60 seconds/.test(prompt), "media prompt: prevention first, then shots, video ≤ 60 s");

  // Chips for the new questions
  const chips = (q: string) =>
    buildChatHints({ currentQuestion: q, triageState: "GATHER_INFO", category: "plumbing", description: "leak", profile, gathered: g }).quickReplies;
  check(
    chips("leak_where").includes("Toilet") &&
      chips("leak_part").includes("Another unit (a neighbour's)") &&
      chips("leak_timing").includes("When it rains") &&
      chips("leak_amount").includes("It's spreading") &&
      chips("leak_electrical").join() === "No,Yes,Not sure",
    "tap-answers for every leak question, from the fixture table"
  );

  // Media limits in the browser
  const chat = readFileSync(join(SRC, "components", "triage", "chat.tsx"), "utf8");
  check(/checkMediaFile\(file\)/.test(chat) && /MAX_VIDEO_SECONDS/.test(chat), "videos over 60 s or files over 25 MB are stopped before upload");

  // Access details
  const access = readFileSync(join(SRC, "lib", "actions", "access.ts"), "utf8");
  check(/\.eq\("tenant_id", user\.id\)/.test(access) && /createServiceClient\(\)/.test(access), "access details: ownership checked with the tenant's session before writing");

  // The likely source reaches the summary (and so the work order) and the SOP search
  {
    const trapGathered = {
      ...safe,
      leak_fixture: "kitchen_sink",
      leak_part: "The drain pipe / P-trap under the sink",
      leak_timing: "Only while water is draining",
      leak_likely_source: { id: "drain_trap", label: "Drain pipe / P-trap slip nut" },
    };
    const summary = generateTicketSummary({
      ticketId: "t1",
      traceId: "t1",
      description: "my sink is leaking",
      gathered: trapGathered,
      steps: [],
      mediaCount: 0,
      timestamp: "2026-10-21T10:00:00Z",
    });
    check(/Likely source: Drain pipe \/ P-trap slip nut/.test(summary) && /when: Only while water is draining/.test(summary), "summary lists the likely source and when it leaks");
    check(/p-trap slip nut drain pipe/.test(buildQueryText(trapGathered, "my sink is leaking")), "SOP search is steered to the likely source");
  }

  // The SOP seeds cover the likely sources the chat can name
  {
    const seeds = ["propcare_sop_seed_50.jsonl", "propcare_sop_seed_fixtures.jsonl"].flatMap((f) =>
      readFileSync(join(__dirname, "..", "..", "scripts", f), "utf8")
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as { id: string; title: string; text: string; metadata: { keywords: string[]; tenant_safe: boolean } })
    );
    const corpus = seeds.map((r) => `${r.title} ${r.text} ${r.metadata.keywords.join(" ")}`.toLowerCase()).join(" ");
    const needed = ["cartridge", "aerator", "supply hose", "slip nut", "garbage disposal", "dishwasher drain hose", "flapper", "fill valve", "wax ring", "range hood", "grease filter", "relief valve", "ice maker", "caulking"];
    const missing = needed.filter((k) => !corpus.includes(k));
    check(missing.length === 0, "SOP seeds cover every likely source (cartridge, slip nut, disposal, flapper, wax ring, range hood…)", missing);
    check(new Set(seeds.map((r) => r.id)).size === seeds.length && seeds.every((r) => r.metadata.tenant_safe && /Stop and escalate immediately if:/.test(r.text)), "SOP ids are unique; every SOP is tenant-safe with escalation rules");
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
if (isMain) runStandalone(() => testChatWorkflow());
