/**
 * Diagnosis eval: for every SOP and every cause it lists, a hidden scenario
 * card fixes the true cause; a scripted tenant answers each question the
 * way that cause would look (options that rule it in, else neutral ones).
 * The chat runs end to end from a real corpus first message for that SOP
 * (understanding → SOP → intake → diagnosis). Pass: the ticket lists the
 * true cause first or second, with its trade and parts. No network.
 *
 *   npx tsx tests/eval/diagnosis-eval.ts [--failures]
 */
import { loadCatalog } from "../../src/assistant/sops/catalog";
import type { Sop } from "../../src/assistant/sops/schema";
import type { AssistantState } from "../../src/assistant";
import { EQUIPMENT_LABEL, EQUIPMENT_ROOM } from "../../src/assistant/understanding/taxonomy";
import { HELDOUT_FILES, TUNED_FILES, loadCorpus, type CorpusCase } from "./frame-eval";
import { newChat, say } from "./drive";

export interface DiagnosisCard {
  sop: string;
  cause: string;
  /** The tenant's first message (from the corpus, else built from the SOP). */
  first: string;
  /** Used instead when the corpus message already says something this cause wouldn't (it says "base", the cause is the supply line). */
  neutral: string;
  /** Question id → the answer this cause would give. */
  answers: Record<string, string>;
}

export interface CardResult {
  card: DiagnosisCard;
  sopUsed: string | null;
  ranked: string[];
  top1: boolean;
  top2: boolean;
  tradeOk: boolean;
  partsOk: boolean;
  confidence: string | null;
  asked: string[];
}

const ROOMS = ["Kitchen", "Main bathroom (hallway)", "Laundry closet", "Bedroom", "Living room"];
const NEUTRAL: Record<string, string> = {
  onset: "Yesterday",
  status: "Still happening",
  amount: "A few drops",
  electrical_near: "No",
  brand_model: "Unknown",
};

/** The answer a tenant with this cause gives to `question`. */
function answerFor(sop: Sop, cause: string, questionId: string): string {
  const q = sop.intake_questions.find((x) => x.id === questionId);
  if (!q) return "not sure";
  if (NEUTRAL[q.slot]) return NEUTRAL[q.slot];
  const pointing = q.options.find((o) => o.rules_in?.includes(cause));
  if (pointing) return pointing.label;
  // Nothing points at it: an answer that points nowhere, else "not sure" (a real tenant with this
  // problem wouldn't see the signs of another cause), else one that at least doesn't rule it out.
  const neutral = q.options.find((o) => o.value !== "not_sure" && !o.emergency && !o.rules_out?.includes(cause) && !o.rules_in?.length);
  if (neutral) return neutral.label;
  if (q.options.some((o) => o.value === "not_sure") || q.options.length === 0) return q.options.length ? "not sure" : "Number 3";
  return q.options.find((o) => !o.emergency && !o.rules_out?.includes(cause))?.label ?? "not sure";
}

const SYMPTOM_TEXT: Record<string, string> = {
  leaking: "is leaking", clogged: "is clogged", not_working: "isn't working", no_heat: "isn't heating", not_cooling: "isn't cooling",
  no_hot_water: "has no hot water", running: "keeps running", noisy: "is noisy", smell: "smells", stuck: "is stuck", broken: "is broken",
  damaged: "is damaged", beeping: "is beeping", tripping: "keeps tripping", mold: "has mould", pests: "has bugs", no_water: "has no water",
  draft: "is drafty", sparking: "is sparking",
};

/** A first message that names the problem but none of the details (so it can't contradict the card). */
function neutralFirst(c: CorpusCase | undefined, sop: Sop): string {
  const eq = c?.expected.equipment ?? sop.applies_to.equipment.find((e) => e !== "unknown") ?? "unknown";
  const sym = c?.expected.symptom ?? sop.applies_to.symptoms[0] ?? "not_working";
  if (sym === "pests") return `I have ${sop.title.toLowerCase()}`;
  return `my ${EQUIPMENT_LABEL[eq as keyof typeof EQUIPMENT_LABEL] ?? "home"} ${SYMPTOM_TEXT[sym] ?? "has a problem"}`;
}

export function buildCards(corpus: CorpusCase[] = [...loadCorpus(TUNED_FILES), ...loadCorpus(HELDOUT_FILES)]): DiagnosisCard[] {
  const cards: DiagnosisCard[] = [];
  for (const sop of loadCatalog().filter((s) => s.selectable && !s.route_to_manager && s.severity !== "emergency")) {
    const fromCorpus = corpus.find((c) => c.sop === sop.issue_key && c.lang === "en" && !c.emergency);
    for (const cause of sop.causes) {
      const answers = Object.fromEntries(sop.intake_questions.map((q) => [q.id, answerFor(sop, cause.id, q.id)]));
      cards.push({ sop: sop.issue_key, cause: cause.id, first: fromCorpus?.message ?? neutralFirst(undefined, sop), neutral: neutralFirst(fromCorpus, sop), answers });
    }
  }
  return cards;
}

/** Does the first message already answer a question differently from the card? */
function contradicts(card: DiagnosisCard, prefilled: Record<string, { label: string }>, sop: Sop | undefined): boolean {
  if (!sop) return false;
  return sop.intake_questions.some((q) => prefilled[q.slot] && card.answers[q.id] && card.answers[q.id] !== "not sure" && prefilled[q.slot].label !== card.answers[q.id]);
}

export async function runCard(card: DiagnosisCard): Promise<CardResult> {
  const catalog = loadCatalog();
  let chat = newChat({ rooms: ROOMS });
  let response = await say(chat, card.first);
  const prefilled = response.state.gathered?.sop?.answers ?? {};
  if (contradicts(card, prefilled, catalog.find((s) => s.issue_key === response.state.gathered?.sop?.issue_key))) {
    card = { ...card, first: card.neutral };
    chat = newChat({ rooms: ROOMS });
    response = await say(chat, card.first);
  }
  let stored: AssistantState = response.state;
  const asked: string[] = [];
  const sopOf = () => catalog.find((s) => s.issue_key === stored.gathered?.sop?.issue_key);
  for (let i = 0; i < 16 && response.phase === "GATHER_INFO" && !response.emergency && stored.current_question; i++) {
    const question = stored.current_question;
    asked.push(question);
    let answer = "not sure";
    if (question.startsWith("intake:")) {
      const id = question.slice("intake:".length);
      const sop = sopOf();
      answer = card.answers[id] ?? (sop ? answerFor(sop, card.cause, id) : "not sure");
    } else if (question === "location_in_unit") {
      const eq = sopOf()?.applies_to.equipment.find((e) => EQUIPMENT_ROOM[e]);
      answer = eq ? ({ kitchen: "Kitchen", bathroom: "Main bathroom (hallway)", laundry: "Laundry closet" } as Record<string, string>)[EQUIPMENT_ROOM[eq]!] ?? "Kitchen" : "Living room";
    } else if (question === "safety_check") answer = "no";
    else if (question === "classify_category") answer = sopOf()?.category ?? "general";
    else answer = NEUTRAL[question] ?? "yesterday";
    response = await say(chat, answer);
    if (response.emergency) break;
    stored = response.state;
  }
  const diag = stored.gathered?.sop?.diagnosis ?? null;
  const ranked = diag?.ranked.map((r) => r.id) ?? [];
  const truth = catalog.find((s) => s.issue_key === card.sop)!.causes.find((c) => c.id === card.cause)!;
  const entry = diag?.ranked.find((r) => r.id === card.cause);
  return {
    card,
    sopUsed: stored.gathered?.sop?.issue_key ?? null,
    ranked,
    top1: ranked[0] === card.cause,
    top2: ranked.slice(0, 2).includes(card.cause),
    tradeOk: !!entry && entry.trade === truth.trade,
    partsOk: !!entry && entry.candidate_parts.join("|") === truth.candidate_parts.join("|"),
    confidence: diag?.confidence ?? null,
    asked,
  };
}

export interface DiagnosisReport {
  cards: number;
  top1: number;
  top2: number;
  sopKept: number;
  byConfidence: Record<string, number>;
  results: CardResult[];
}

export async function runDiagnosisEval(cards = buildCards()): Promise<DiagnosisReport> {
  const results: CardResult[] = [];
  for (const card of cards) results.push(await runCard(card));
  const pct = (n: number) => Math.round((n / Math.max(1, results.length)) * 1000) / 1000;
  const byConfidence: Record<string, number> = {};
  for (const r of results) byConfidence[r.confidence ?? "none"] = (byConfidence[r.confidence ?? "none"] ?? 0) + 1;
  return {
    cards: results.length,
    top1: pct(results.filter((r) => r.top1).length),
    top2: pct(results.filter((r) => r.top2 && r.tradeOk && r.partsOk).length),
    sopKept: pct(results.filter((r) => r.sopUsed === r.card.sop).length),
    byConfidence,
    results,
  };
}

const isMain = process.argv[1]?.replace(/\.ts$/, "").endsWith("diagnosis-eval");
if (isMain) {
  runDiagnosisEval().then((r) => {
    console.log(`cards: ${r.cards}  top-1: ${(r.top1 * 100).toFixed(1)}%  top-2 with trade and parts: ${(r.top2 * 100).toFixed(1)}%  SOP kept: ${(r.sopKept * 100).toFixed(1)}%  confidence: ${JSON.stringify(r.byConfidence)}`);
    if (process.argv.includes("--failures")) {
      for (const x of r.results.filter((y) => !y.top2 || y.sopUsed !== y.card.sop)) {
        console.log(`${x.card.sop} / ${x.card.cause}: got [${x.ranked.join(", ")}] via ${x.sopUsed}; "${x.card.first}"; asked ${x.asked.join(" ")}`);
      }
    }
  });
}
