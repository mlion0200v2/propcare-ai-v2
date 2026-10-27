/**
 * Reference cards: what the conversation model reads about a kind of
 * problem. A card is a view of a written SOP, built at load time, so the
 * catalog stays the one source:
 *
 *   - what a tradesperson needs to know (the SOP's questions and options),
 *   - the steps a tenant may safely do (after the never-instruct filter),
 *   - what never to tell a tenant, and when to stop and hand over,
 *   - the likely causes, trade and parts: for the manager's ticket only.
 *
 * Finding cards returns several, ranked, not one winner: the model reads
 * them and can switch, or use none when nothing fits (the long tail).
 * General SOPs are not cards; with no card the model works from general
 * knowledge, inside the global rules.
 */
import type { IssueFrame } from "@/assistant/understanding/frame";
import { loadCatalog } from "@/assistant/sops/catalog";
import { isGeneralSop } from "@/assistant/sops/general";
import { scoreSop } from "@/assistant/sops/select";
import type { Sop } from "@/assistant/sops/schema";
import { isUnsafeInstruction } from "@/assistant/triage/step-safety";

export interface CardCause {
  id: string;
  label: string;
  trade: string;
  parts: string[];
  /** Estimated visit, minutes [low, high]. */
  visit_minutes: [number, number];
  /** How common before any answers (0–3). */
  prior: number;
}

export interface ReferenceCard {
  /** The SOP's issue_key. */
  key: string;
  title: string;
  category: string;
  severity: Sop["severity"];
  /** What a tradesperson needs to know: each question with its usual answers. */
  ask: { question: string; options: string[] }[];
  /** What to photograph or read so the tech can match parts. */
  identify: string[];
  photos: string[];
  /** Steps a tenant may do, in order (damage-limiting first). Already filtered for safety. */
  safe_steps: string[];
  /** Never tell the tenant to do these (this card's own, on top of the global list). */
  never: string[];
  /** Stop and hand over to the manager when any is true. */
  escalate_if: string[];
  /** No troubleshooting: pass it to the manager (neighbour noise). */
  route_to_manager: boolean;
  /** Manager and vendor only: never shown or said to the tenant. */
  causes: CardCause[];
}

/** What every conversation must never tell a tenant to do, card or no card. */
export const GLOBAL_NEVER = [
  "Touch gas valves, gas lines, pilot lights or gas controls, or turn the gas on or off",
  "Open electrical panels, outlet or switch covers, or touch, cap or reconnect wiring",
  "Reset or flip breakers when there are sparks, burning, smoke or water near electrics",
  "Move, tilt or pull out heavy or built-in appliances (fridge, stove, washer, dryer, dishwasher, water heater)",
  "Take appliances or fixtures apart, or use tools inside them (hex keys, wrenches, screwdrivers)",
  "Use chemical drain cleaners, mix cleaning products, or spray pesticides",
  "Climb ladders, go on the roof or into the attic",
  "Put a hand inside a garbage disposal or any machine with moving parts",
  "Watch or search for repair videos",
];

const unique = (xs: string[]) => [...new Set(xs.map((x) => x.trim()).filter(Boolean))];

export function cardFromSop(sop: Sop): ReferenceCard {
  return {
    key: sop.issue_key,
    title: sop.title,
    category: sop.category,
    severity: sop.severity,
    ask: sop.intake_questions.map((q) => ({
      question: q.question,
      options: q.options.filter((o) => o.value !== "not_sure").map((o) => o.label),
    })),
    identify: sop.identify,
    photos: sop.photos,
    safe_steps: unique([...sop.prevention, ...sop.tenant_steps]).filter((s) => !isUnsafeInstruction(s)),
    never: sop.never ?? [],
    escalate_if: sop.escalate_if,
    route_to_manager: sop.route_to_manager,
    causes: sop.causes.map((c) => ({ id: c.id, label: c.label, trade: c.trade, parts: c.candidate_parts, visit_minutes: c.visit_minutes, prior: c.prior })),
  };
}

let cards: ReferenceCard[] | null = null;

/** Every card: one per written, selectable SOP. */
export function loadCards(): ReferenceCard[] {
  cards ??= loadCatalog()
    .filter((s) => s.selectable && !isGeneralSop(s))
    .map(cardFromSop);
  return cards;
}

export function cardByKey(key: string): ReferenceCard | null {
  return loadCards().find((c) => c.key === key) ?? null;
}

export interface FoundCard {
  card: ReferenceCard;
  score: number;
}

/** Below this, a card is a guess not worth the model's attention. */
const MIN_SCORE = 2;
/** Cards this far behind the best are dropped. */
const MAX_GAP = 3;

/**
 * The cards that fit what the tenant described, best first (at most
 * `limit`). Empty when nothing fits: the model then works without one.
 *
 * @param vectorScores similarity per issue_key from the knowledge base (0–1), when available
 */
export function findCards(frame: IssueFrame, message: string, options: { vectorScores?: Record<string, number>; limit?: number } = {}): FoundCard[] {
  const text = message.normalize("NFKC").toLowerCase();
  const byKey = new Map(loadCards().map((c) => [c.key, c]));
  const ranked = loadCatalog()
    .filter((sop) => byKey.has(sop.issue_key))
    .map((sop) => ({ card: byKey.get(sop.issue_key)!, score: scoreSop(sop, frame, text, options.vectorScores?.[sop.issue_key] ?? 0) }))
    .filter((r): r is FoundCard => r.score !== null && r.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score);
  const best = ranked[0]?.score ?? 0;
  const close = ranked.filter((r) => best - r.score <= MAX_GAP);
  const limit = options.limit ?? 3;
  // Cards tied at the cut all come (up to MAX_TIED): "pests in the kitchen" can't tell ants from cockroaches.
  const cut = close[limit - 1]?.score;
  return close.filter((r, i) => i < limit || (r.score === cut && i < MAX_TIED));
}

const MAX_TIED = 5;

/**
 * A card as the conversation model reads it. Causes are marked for the
 * ticket only, so the model can name one in the diagnosis but not to the tenant.
 */
export function cardText(card: ReferenceCard): string {
  const list = (title: string, xs: string[]) => (xs.length ? [title, ...xs.map((x) => `- ${x}`)] : []);
  return [
    `## ${card.title} (card: ${card.key}; ${card.category}; usual severity ${card.severity})`,
    ...(card.route_to_manager ? ["No troubleshooting: gather the facts and pass it to the manager."] : []),
    ...list(
      "What the tradesperson needs to know (ask only what isn't known yet; the options are usual answers):",
      card.ask.map((q) => (q.options.length ? `${q.question} [${q.options.join(" | ")}]` : q.question))
    ),
    ...list("Safe steps the tenant may do (damage-limiting first):", card.safe_steps),
    ...list("Never tell the tenant to:", card.never),
    ...list("Stop and hand over to the manager if:", card.escalate_if),
    ...list("Useful photos:", unique([...card.photos, ...card.identify])),
    ...list(
      "Likely causes (for the ticket only; never mention causes, parts or trades to the tenant):",
      card.causes.map((c) => `${c.id}: ${c.label} (${c.trade})`)
    ),
  ].join("\n");
}
