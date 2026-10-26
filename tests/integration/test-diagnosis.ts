/**
 * Diagnosis: ranking from answers, the manager/vendor view, and that the
 * tenant never sees parts, trades or diagnosis talk. No network.
 */
import { createRunner, printSection, type TestResult } from "./helpers";
import { sopByKey } from "../../src/assistant/sops/catalog";
import { answerIntake, startIntake, nextIntakeQuestion } from "../../src/assistant/sops/intake";
import { buildDiagnosisView, diagnosisText, quoteNoteFromDiagnosis } from "../../src/assistant/sops/diagnosis-view";
import { rulesFrame } from "../../src/assistant/understanding/rules";
import { generateTenantSummary, generateTicketSummary } from "../../src/assistant/triage/summary";
import { loadCatalog } from "../../src/assistant/sops/catalog";
import { buildCards } from "../eval/diagnosis-eval";
import type { GatheredInfo } from "../../src/assistant/triage/types";
import { newChat, say } from "../eval/drive";

function answer(key: string, message: string, replies: Record<string, string>) {
  const sop = sopByKey(key)!;
  let state = startIntake(sop, rulesFrame(message), "high");
  for (let i = 0; i < 12; i++) {
    const q = nextIntakeQuestion(sop, state, { room: true });
    if (!q) break;
    state = answerIntake(sop, state, q, replies[q.id] ?? "not sure").state;
  }
  return state;
}

export async function testDiagnosis(): Promise<TestResult> {
  printSection("Diagnosis: causes, parts and trade for the manager and vendor; never the tenant");
  const { pass, fail, result } = createRunner();
  const check = (ok: boolean, label: string, detail?: unknown) => (ok ? pass(label) : fail(label, detail));

  // Simone's fridge examples
  const drain = answer("fridge_leak", "my fridge is leaking", { fridge_part: "Inside, under the crisper drawers", fridge_supply_line: "No", fridge_freezer_ice: "No", fridge_dispenser: "No" });
  check(drain.diagnosis?.ranked[0].id === "fridge_drain" && drain.diagnosis?.confidence === "high", "fridge: water inside, no ice, line dry → defrost drain, high confidence", drain.diagnosis);
  const line = answer("fridge_leak", "my fridge is leaking", { fridge_part: "Behind it", fridge_supply_line: "Water on it", fridge_dispenser: "Yes" });
  check(line.diagnosis?.ranked[0].id === "fridge_water_line", "fridge: behind, water on the line, dispenser used → inlet/ice-maker line", line.diagnosis?.ranked);
  const toilet = answer("toilet_running", "toilet keeps running", { toilet_running_sound: "Water keeps trickling into the bowl", toilet_refills: "Yes", toilet_bowl_moving: "Yes, a trickle down the sides" });
  check(toilet.diagnosis?.ranked[0].id === "flapper", "toilet: refills on its own, water moving in the bowl → flapper", toilet.diagnosis?.ranked);
  const outlet = answer("outlet_not_working", "outlet not working", { outlet_scope: "Several", outlet_same_wall: "No, those are dead too", outlet_gfci_anywhere: "Yes" });
  check(outlet.diagnosis?.ranked[0].id === "breaker_or_gfci" && outlet.diagnosis?.ranked[0].candidate_parts.some((p) => /GFCI/.test(p)), "outlet: several dead, a GFCI somewhere → GFCI receptacle", outlet.diagnosis?.ranked[0]);
  const unanswered = answer("fridge_leak", "my fridge is leaking", {});
  check(unanswered.diagnosis?.confidence === "low" && unanswered.cause === null, "no answers: low confidence, no cause claimed");

  // The view: parts, trade, time, model/serial, quote note
  const gathered = { sop: { ...line, answers: { ...line.answers, brand_model: { value: "LG LRMVS3006S", label: "LG LRMVS3006S" } } } } as unknown as GatheredInfo;
  const view = buildDiagnosisView(gathered, 2)!;
  check(view.causes[0].label.includes("supply line") && view.trade === "appliance technician" && /min/.test(view.visit ?? ""), "view: cause, trade, visit length", view);
  check(view.modelSerial === "LG LRMVS3006S" && view.parts.some((p) => /inlet valve/i.test(p)) && view.evidence.some((e) => /2 photos/.test(e)), "view: model/serial, parts to bring, photo evidence");
  check(/^DIAGNOSIS/.test(diagnosisText(view)) && /Bring: /.test(diagnosisText(view)), "text block for the summary and work order");
  check(/Parts if needed: .*inlet valve/i.test(quoteNoteFromDiagnosis(view)), "vendor quote form pre-filled with the parts list");
  const manager = buildDiagnosisView({ sop: answer("noise_complaint", "neighbours are loud", {}) } as unknown as GatheredInfo);
  check(!!manager?.managerOnly && quoteNoteFromDiagnosis(manager) === "", "neighbour noise: manager only, no parts or quote");

  // Manager summary carries it; the tenant summary doesn't.
  const g: GatheredInfo = { ...(gathered as object), category: "appliance", location_in_unit: "Kitchen", started_when: "today", current_status: "Still happening", is_emergency: false } as GatheredInfo;
  const managerSummary = generateTicketSummary({ description: "my fridge is leaking", gathered: g, steps: [], mediaCount: 2, timestamp: "2026-10-21T10:00:00Z" });
  const tenantSummary = generateTenantSummary({ description: "my fridge is leaking", gathered: g, mediaCount: 2 });
  check(/DIAGNOSIS/.test(managerSummary) && /inlet valve/i.test(managerSummary), "manager summary (and default work-order scope) has the diagnosis");
  check(!/DIAGNOSIS|Bring:|inlet valve|appliance technician|Likely cause/i.test(tenantSummary), "tenant summary has no diagnosis, parts or trade");

  // Every SOP × cause chat: nothing the tenant sees mentions parts, trades or the diagnosis.
  const catalog = loadCatalog();
  const partStrings = new Set(catalog.flatMap((s) => s.causes.flatMap((c) => c.candidate_parts)).filter((p) => p.length > 12));
  const trades = new Set(catalog.flatMap((s) => s.causes.map((c) => c.trade)));
  const leaks: string[] = [];
  for (const card of buildCards()) {
    const chat = newChat({ rooms: ["Kitchen", "Main bathroom (hallway)"] });
    let response = await say(chat, card.first);
    const seen: string[] = [response.reply, ...response.options];
    for (let i = 0; i < 12 && response.phase === "GATHER_INFO" && !response.emergency && response.state.current_question; i++) {
      const q = response.state.current_question;
      const id = q.startsWith("intake:") ? q.slice(7) : q;
      response = await say(chat, card.answers[id] ?? (q === "safety_check" ? "no" : "not sure"));
      seen.push(response.reply, ...response.options);
    }
    const text = seen.join("\n");
    const hit = [...partStrings].find((p) => text.includes(p)) ?? [...trades].find((t) => new RegExp(`\\b${t}\\b`, "i").test(text) && t !== "handyperson") ?? (/\b(DIAGNOSIS|Bring:|candidate parts|\$\d)/.test(text) ? "diagnosis wording" : null);
    if (hit) leaks.push(`${card.sop}/${card.cause}: ${hit}`);
  }
  check(leaks.length === 0, "tenant never sees parts, trades, prices or the diagnosis (all SOP × cause chats)", leaks.slice(0, 5));
  return result;
}
